// Patchline server: serves the UI, normalizes real OpenAPI specs (YAML/$ref),
// runs analyses, and watches spec URLs for changes on a polite cadence.
//
//   node src/server.mjs [--port 8484]
//
// Data lives in ./data (watches, events, snapshots). No external services.

import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { parseSpecText, fromOpenAPI, isRealOpenAPI } from './openapi.mjs';
import { diffSpecs, scanConsumer, buildFixes, buildPR, summarize } from './engines.mjs';
import { walkRepo, clonePublicRepo } from './repo.mjs';
import { rmSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.PATCHLINE_DATA || join(root, 'data');
const PORT = Number(process.env.PORT || (process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 8484));
const MIN_INTERVAL_MIN = Number(process.env.PATCHLINE_MIN_INTERVAL_MIN || 60); // polite default: hourly
const MAX_WATCHES = Number(process.env.PATCHLINE_MAX_WATCHES || 50);
const MAX_BODY = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const UA = 'patchline/0.2 (self-maintaining-apis; +https://github.com/patchline)';
// SSRF guard: URL fetches (fetch-spec, analyze URLs, watches) only reach public
// IPs. Loopback/private/link-local targets are refused unless explicitly in
// test mode. Redirects are followed hop-by-hop with the same check.
const ALLOW_PRIVATE = process.env.PATCHLINE_ALLOW_PRIVATE === '1';

function isPrivateIP(ip) {
  if (isIP(ip) === 6) {
    const n = ip.toLowerCase();
    return n === '::1' || n.startsWith('fc') || n.startsWith('fd') || n.startsWith('fe80') || n === '::' || n.startsWith('::ffff:127.') || n.startsWith('::ffff:10.') || n.startsWith('::ffff:192.168.') || n.startsWith('::ffff:169.254.') || n.startsWith('::ffff:172.');
  }
  const p = ip.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || p[0] === 0;
}

async function assertPublicUrl(rawUrl) {
  const u = new URL(rawUrl);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http(s) URLs are allowed');
  if (isIP(u.hostname)) {
    if (!ALLOW_PRIVATE && isPrivateIP(u.hostname)) throw new Error(`refusing non-public address ${u.hostname} (set PATCHLINE_ALLOW_PRIVATE=1 only for local testing)`);
    return { url: u, dispatcher: undefined };
  }
  const answers = await lookup(u.hostname, { all: true });
  if (!answers.length) throw new Error(`cannot resolve ${u.hostname}`);
  for (const a of answers) {
    if (!ALLOW_PRIVATE && isPrivateIP(a.address)) throw new Error(`${u.hostname} resolves to non-public address ${a.address}; refused`);
  }
  // pin the connection to the addresses we just validated: the fetch below
  // must not re-resolve DNS (rebinding window between check and connect)
  const pinned = answers.map((a) => ({ address: a.address, family: a.family }));
  const dispatcher = new Agent({
    connect: {
      lookup: (hostname, opts, cb) => {
        if (opts && opts.all) return cb(null, pinned);
        const first = pinned[0];
        return cb(null, first.address, first.family);
      },
    },
  });
  return { url: u, dispatcher };
}

for (const d of [DATA, join(DATA, 'snapshots')]) mkdirSync(d, { recursive: true });

const loadJson = (name, fallback) => { try { return JSON.parse(readFileSync(join(DATA, name), 'utf8')); } catch { return fallback; } };
const saveJson = (name, val) => writeFileSync(join(DATA, name), JSON.stringify(val, null, 2));
let watches = loadJson('watches.json', []);
let events = loadJson('events.json', []);

function normalizeSpecText(text, sourceName) {
  const doc = parseSpecText(text, { sourceName });
  return isRealOpenAPI(doc) ? fromOpenAPI(doc) : doc;
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const meta = loadJson(`snapshots/${urlHash(url)}.meta.json`, {});
    const headers = { 'user-agent': UA, accept: 'application/json, application/yaml, text/yaml, */*' };
    if (meta.etag) headers['if-none-match'] = meta.etag;
    if (meta.lastModified) headers['if-modified-since'] = meta.lastModified;
    let current = url;
    for (let hops = 0; hops <= 3; hops++) {
      const { dispatcher } = await assertPublicUrl(current);
      const res = await fetch(current, { headers, signal: ctrl.signal, redirect: 'manual', dispatcher });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current).toString();
        continue;
      }
      if (res.status === 304) return { notModified: true };
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const text = await res.text();
      if (text.length > MAX_BODY) throw new Error(`spec too large (${text.length} bytes)`);
      return { text, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
    }
    throw new Error(`too many redirects fetching ${url}`);
  } finally {
    clearTimeout(timer);
  }
}

const urlHash = (url) => createHash('sha256').update(url).digest('hex').slice(0, 16);

async function checkWatch(w, { force = false } = {}) {
  const now = Date.now();
  w.lastCheckAt = new Date(now).toISOString();
  try {
    const got = await fetchText(w.url);
    if (got.notModified) { w.lastResult = 'not-modified'; return { status: 'not-modified' }; }
    const hash = createHash('sha256').update(got.text).digest('hex');
    const h = urlHash(w.url);
    const prevPath = join(DATA, 'snapshots', `${h}.txt`);
    const hadPrev = existsSync(prevPath);
    const prevText = hadPrev ? readFileSync(prevPath, 'utf8') : null;
    if (hadPrev && createHash('sha256').update(prevText).digest('hex') === hash) {
      w.lastResult = 'unchanged';
      saveJson(`snapshots/${h}.meta.json`, { etag: got.etag, lastModified: got.lastModified });
      return { status: 'unchanged' };
    }
    let event = null;
    if (hadPrev) {
      // real change: diff old snapshot against the new text
      const oldSpec = normalizeSpecText(prevText, `${w.name} (previous snapshot)`);
      const newSpec = normalizeSpecText(got.text, w.url);
      const changes = diffSpecs(oldSpec, newSpec);
      event = {
        id: randomUUID(), watchId: w.id, watchName: w.name, at: w.lastCheckAt,
        oldVersion: oldSpec.info?.version || null, newVersion: newSpec.info?.version || null,
        summary: summarize(changes), changes,
      };
      if (w.repoUrl) {
        let repoDir = null;
        try {
          repoDir = clonePublicRepo(w.repoUrl);
          const files = walkRepo(repoDir).slice(0, 2000);
          const usages = scanConsumer(files, changes);
          const fixes = buildFixes(files, changes);
          event.impact = {
            repoUrl: w.repoUrl, scannedFiles: files.length,
            affectedLines: usages.length,
            proposedEdits: fixes.reduce((n, f) => n + f.edits.length, 0),
            inferredSuggestions: fixes.reduce((n, f) => n + (f.suggested || []).length, 0),
            manualSpots: fixes.reduce((n, f) => n + f.manual.length, 0),
            usages: usages.slice(0, 100).map((u) => ({ file: u.file, line: u.line, change: u.change.type })),
            pr: buildPR({ oldVersion: event.oldVersion, newVersion: event.newVersion, apiTitle: oldSpec.info?.title || w.name, changes, fixes }).slice(0, 50000),
          };
          w.lastResult += `; impact: ${usages.length} affected line(s)`;
        } catch (e) {
          event.impact = { repoUrl: w.repoUrl, error: e.message };
        } finally {
          if (repoDir) rmSync(repoDir, { recursive: true, force: true });
        }
      }
      events.unshift(event);
      events = events.slice(0, 200);
      saveJson('events.json', events);
      w.lastResult = `changed: ${event.summary.breaking} breaking, ${event.summary.additive} additive, ${event.summary.warnings} warnings`;
    } else {
      w.lastResult = 'baseline-saved';
    }
    writeFileSync(prevPath, got.text);
    saveJson(`snapshots/${h}.meta.json`, { etag: got.etag, lastModified: got.lastModified });
    w.lastChangeAt = hadPrev ? w.lastCheckAt : w.lastChangeAt || null;
    return { status: hadPrev ? 'changed' : 'baseline', event };
  } catch (e) {
    w.lastResult = `error: ${e.message}`;
    return { status: 'error', error: e.message };
  } finally {
    saveJson('watches.json', watches);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('invalid JSON body')); } });
    req.on('error', reject);
  });
}

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

const routes = {
  'GET /': (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(readFileSync(join(root, 'ui', 'index.html'))); },
  'GET /api/health': (req, res) => json(res, 200, { ok: true, watches: watches.length, events: events.length }),
  'GET /api/watches': (req, res) => json(res, 200, { watches, minIntervalMinutes: MIN_INTERVAL_MIN }),
  'GET /api/events': (req, res) => json(res, 200, { events }),

  'POST /api/parse': async (req, res) => {
    const b = await readBody(req);
    try { json(res, 200, { spec: normalizeSpecText(String(b.text || ''), 'paste') }); }
    catch (e) { json(res, 422, { error: e.message }); }
  },

  'POST /api/fetch-spec': async (req, res) => {
    const b = await readBody(req);
    if (!/^https?:\/\//.test(b.url || '')) return json(res, 422, { error: 'url must be http(s)' });
    try { const got = await fetchText(b.url); json(res, 200, { text: got.notModified ? null : got.text }); }
    catch (e) { json(res, 502, { error: e.message }); }
  },

  'POST /api/analyze': async (req, res) => {
    const b = await readBody(req);
    try {
      const oldText = b.oldText || (b.oldUrl ? (await fetchText(b.oldUrl)).text : null);
      const newText = b.newText || (b.newUrl ? (await fetchText(b.newUrl)).text : null);
      if (!oldText || !newText) return json(res, 422, { error: 'need oldText/oldUrl and newText/newUrl' });
      const oldSpec = normalizeSpecText(oldText, 'old');
      const newSpec = normalizeSpecText(newText, 'new');
      const changes = diffSpecs(oldSpec, newSpec);
      const files = Array.isArray(b.files) ? b.files.filter((f) => f && typeof f.name === 'string' && typeof f.content === 'string').slice(0, 500) : [];
      const usages = files.length ? scanConsumer(files, changes) : [];
      const fixes = files.length ? buildFixes(files, changes) : [];
      const pr = buildPR({ oldVersion: oldSpec.info?.version || 'old', newVersion: newSpec.info?.version || 'new', apiTitle: oldSpec.info?.title || 'API', changes, fixes });
      json(res, 200, { summary: summarize(changes), changes, usages, fixes, pr });
    } catch (e) { json(res, 422, { error: e.message }); }
  },

  'POST /api/watches': async (req, res) => {
    const b = await readBody(req);
    if (!b.name || !/^https?:\/\//.test(b.url || '')) return json(res, 422, { error: 'need name and http(s) url' });
    try { await assertPublicUrl(b.url); } catch (e) { return json(res, 422, { error: e.message }); }
    const interval = Math.max(MIN_INTERVAL_MIN, Number(b.intervalMinutes) || MIN_INTERVAL_MIN);
    if (watches.length >= MAX_WATCHES) return json(res, 429, { error: `watch limit ${MAX_WATCHES} reached` });
    if (watches.some((w) => w.url === b.url)) return json(res, 409, { error: 'url already watched' });
    if (b.repoUrl) { try { await assertPublicUrl(b.repoUrl); } catch (e) { return json(res, 422, { error: `repoUrl: ${e.message}` }); } }
    const w = { id: randomUUID(), name: String(b.name).slice(0, 120), url: b.url, repoUrl: b.repoUrl ? String(b.repoUrl) : null, intervalMinutes: interval, createdAt: new Date().toISOString(), nextCheckAt: new Date(Date.now() + interval * 60000).toISOString(), lastCheckAt: null, lastResult: null };
    watches.push(w);
    saveJson('watches.json', watches);
    // baseline fetch immediately so the first change is detectable
    const first = await checkWatch(w);
    json(res, 201, { watch: w, baseline: first.status });
  },

  'POST /api/watches/check': async (req, res) => {
    const b = await readBody(req);
    const w = watches.find((x) => x.id === b.id);
    if (!w) return json(res, 404, { error: 'watch not found' });
    const r = await checkWatch(w, { force: true });
    w.nextCheckAt = new Date(Date.now() + w.intervalMinutes * 60000).toISOString();
    saveJson('watches.json', watches);
    json(res, 200, r);
  },

  'DELETE /api/watches': async (req, res, url) => {
    const id = url.searchParams.get('id');
    const i = watches.findIndex((x) => x.id === id);
    if (i === -1) return json(res, 404, { error: 'watch not found' });
    watches.splice(i, 1);
    saveJson('watches.json', watches);
    json(res, 200, { deleted: id });
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) { json(res, 404, { error: `no route ${key}` }); return; }
  try { await handler(req, res, url); }
  catch (e) { json(res, 500, { error: e.message }); }
});

// polite scheduler: due watches checked on a fixed tick, staggered by their own intervals
const tick = async () => {
  const now = Date.now();
  for (const w of watches) {
    if (w.nextCheckAt && Date.parse(w.nextCheckAt) <= now) {
      await checkWatch(w);
      w.nextCheckAt = new Date(Date.now() + w.intervalMinutes * 60000).toISOString();
      saveJson('watches.json', watches);
    }
  }
};
const timer = setInterval(tick, 30000);
timer.unref();

server.listen(PORT, () => console.log(`patchline server on http://localhost:${PORT} (data: ${DATA}, min interval ${MIN_INTERVAL_MIN}m)`));
