// Network egress shared by server and repo clone: every outbound fetch is
// SSRF-guarded. Only public IPs are reachable; loopback/private/link-local
// targets are refused unless PATCHLINE_ALLOW_PRIVATE=1 (local testing only).
// DNS is resolved once, validated, and the connection is PINNED to the
// validated addresses so a rebinding between check and connect cannot swap
// the target. Redirects are followed hop-by-hop, re-validating each hop.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const MAX_BODY = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;
const UA = 'patchline/0.2 (self-maintaining-apis; +https://github.com/patchline)';

// read at call time so tests can toggle it per case
const allowPrivate = () => process.env.PATCHLINE_ALLOW_PRIVATE === '1';

export function isPrivateIP(ip) {
  if (isIP(ip) === 6) {
    const n = ip.toLowerCase();
    return n === '::1' || n.startsWith('fc') || n.startsWith('fd') || n.startsWith('fe80') || n === '::' || n.startsWith('::ffff:127.') || n.startsWith('::ffff:10.') || n.startsWith('::ffff:192.168.') || n.startsWith('::ffff:169.254.') || n.startsWith('::ffff:172.');
  }
  const p = ip.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || p[0] === 0;
}

export async function assertPublicUrl(rawUrl) {
  const u = new URL(rawUrl);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http(s) URLs are allowed');
  if (isIP(u.hostname)) {
    if (!allowPrivate() && isPrivateIP(u.hostname)) throw new Error(`refusing non-public address ${u.hostname} (set PATCHLINE_ALLOW_PRIVATE=1 only for local testing)`);
    return { url: u, dispatcher: undefined };
  }
  const answers = await lookup(u.hostname, { all: true });
  if (!answers.length) throw new Error(`cannot resolve ${u.hostname}`);
  for (const a of answers) {
    if (!allowPrivate() && isPrivateIP(a.address)) throw new Error(`${u.hostname} resolves to non-public address ${a.address}; refused`);
  }
  // pin the connection to the addresses we just validated: the fetch below
  // must not re-resolve DNS (rebinding window between check and connect)
  const pinned = answers.map((a) => ({ address: a.address, family: a.family }));
  const pinnedLookup = (hostname, opts, cb) => {
    if (opts && opts.all) return cb(null, pinned);
    const first = pinned[0];
    return cb(null, first.address, first.family);
  };
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup } });
  return { url: u, dispatcher, pinned, pinnedLookup };
}

export const urlHash = (url) => createHash('sha256').update(url).digest('hex').slice(0, 16);

// Fetch a text resource with SSRF guard on every redirect hop, conditional
// request support (etag/last-modified via a snapshot meta dir), size cap and
// timeout. metaDir may be null (no conditional caching).
export async function fetchText(url, { metaDir = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const meta = metaDir ? loadJson(join(metaDir, `${urlHash(url)}.meta.json`), {}) : {};
    const headers = { 'user-agent': UA, accept: 'application/json, application/yaml, text/yaml, */*' };
    if (meta.etag) headers['if-none-match'] = meta.etag;
    if (meta.lastModified) headers['if-modified-since'] = meta.lastModified;
    let current = url;
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      // every hop re-validates: a redirect to a private address is refused here
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

// Binary variant of fetchText for repo archives: same per-hop SSRF guard and
// DNS pinning, same size cap, no conditional caching (archives are immutable
// per ref and fetched only on real spec changes).
export async function fetchBinary(url, { maxBytes = MAX_BODY } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = url;
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      const { dispatcher } = await assertPublicUrl(current);
      const res = await fetch(current, { headers: { 'user-agent': UA }, signal: ctrl.signal, redirect: 'manual', dispatcher });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current).toString();
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`archive too large (${buf.length} bytes)`);
      return buf;
    }
    throw new Error(`too many redirects fetching ${url}`);
  } finally {
    clearTimeout(timer);
  }
}

function loadJson(path, fallback) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }
export function saveMeta(metaDir, url, meta) { writeFileSync(join(metaDir, `${urlHash(url)}.meta.json`), JSON.stringify(meta)); }
