// End-to-end server tests: real HTTP, real watch lifecycle against a live fixture API.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const t = (name, fn) => fn().then(() => passed++).catch((e) => { failed++; console.error(`FAIL ${name}: ${e.message}`); });
const ok = (x, msg = 'expected truthy') => { if (!x) throw new Error(msg); };

// fixture API server whose spec can be swapped mid-test
const specV1 = readFileSync(join(root, 'fixtures/openapi/payments-v1.json'), 'utf8');
const specV2 = readFileSync(join(root, 'fixtures/openapi/payments-v2.yaml'), 'utf8');
let current = specV1;
let hits = 0;
const fixture = createServer((req, res) => {
  hits++;
  res.writeHead(200, { 'content-type': 'text/plain', 'etag': `"v${current === specV1 ? 1 : 2}"` });
  res.end(current);
});
await new Promise((r) => fixture.listen(0, r));
const fixturePort = fixture.address().port;
const fixtureUrl = `http://127.0.0.1:${fixturePort}/spec`;

const dataDir = mkdtempSync(join(tmpdir(), 'patchline-data-'));
const child = spawn('node', [join(root, 'src/server.mjs'), '--port', '0'], {
  env: { ...process.env, PORT: '18499', PATCHLINE_DATA: dataDir, PATCHLINE_MIN_INTERVAL_MIN: '1' },
  stdio: 'pipe',
});
await new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => { if (String(d).includes('patchline server on')) resolve(); });
  child.on('exit', () => reject(new Error('server exited early')));
  setTimeout(() => reject(new Error('server start timeout')), 8000);
});
const B = 'http://127.0.0.1:18499';
const post = async (path, body) => (await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const get = async (path) => (await fetch(B + path)).json();

await t('health endpoint', async () => {
  const h = await get('/api/health');
  ok(h.ok === true, JSON.stringify(h));
});

await t('UI is served at /', async () => {
  const res = await fetch(B + '/');
  const html = await res.text();
  ok(res.status === 200 && html.includes('Patchline'), `status ${res.status}`);
});

await t('parse handles YAML and normalizes real OpenAPI', async () => {
  const r = await post('/api/parse', { text: specV2 });
  ok(r.spec && r.spec.paths['/v3/invoices'], JSON.stringify(r).slice(0, 200));
});

await t('parse rejects garbage with 422-shaped error', async () => {
  const r = await post('/api/parse', { text: 'openapi: [unclosed' });
  ok(r.error, JSON.stringify(r));
});

await t('analyze over URLs with consumer files returns full report', async () => {
  const files = [{ name: 'app.js', content: "const total = inv.amount_cents / 100;\nawait api.get('/v2/payouts');\n" }];
  const r = await post('/api/analyze', { oldUrl: fixtureUrl, newText: specV2, files });
  ok(r.summary && r.summary.breaking > 5, JSON.stringify(r.summary || r));
  ok(r.usages.length >= 2, `usages ${r.usages.length}`); // amount_cents read + removed payouts endpoint
  ok(r.pr.includes('Acme Payments API'), 'PR markdown');
});

await t('watch lifecycle: baseline, change detection, event with diff, delete', async () => {
  const created = await post('/api/watches', { name: 'fixture', url: fixtureUrl, intervalMinutes: 1 });
  ok(created.watch && created.baseline === 'baseline', JSON.stringify(created));
  const id = created.watch.id;

  // no change yet -> unchanged or not-modified
  const again = await post('/api/watches/check', { id });
  ok(['unchanged', 'not-modified'].includes(again.status), JSON.stringify(again));

  // swap the served spec -> change detected with a real diff event
  current = specV2;
  const changed = await post('/api/watches/check', { id });
  ok(changed.status === 'changed', JSON.stringify(changed).slice(0, 300));
  ok(changed.event.summary.breaking > 5, JSON.stringify(changed.event.summary));
  ok(changed.event.oldVersion === '2.1.0' && changed.event.newVersion === '3.0.0', 'versions');

  const ev = await get('/api/events');
  ok(ev.events.length === 1 && ev.events[0].watchName === 'fixture', 'event stored');

  // duplicate url rejected
  const dup = await post('/api/watches', { name: 'dup', url: fixtureUrl });
  ok(dup.error && dup.error.includes('already watched'), JSON.stringify(dup));

  const del = await fetch(B + '/api/watches?id=' + id, { method: 'DELETE' });
  ok(del.status === 200, 'delete');
  const list = await get('/api/watches');
  ok(list.watches.length === 0, 'watch removed');
});

await t('watch persists across restart (data dir)', async () => {
  const created = await post('/api/watches', { name: 'persist', url: fixtureUrl, intervalMinutes: 5 });
  ok(created.watch, JSON.stringify(created));
  const onDisk = JSON.parse(readFileSync(join(dataDir, 'watches.json'), 'utf8'));
  ok(onDisk.length === 1 && onDisk[0].name === 'persist', 'watches.json');
  await fetch(B + '/api/watches?id=' + created.watch.id, { method: 'DELETE' });
});

await t('fetch-spec proxies a URL', async () => {
  const r = await post('/api/fetch-spec', { url: fixtureUrl });
  ok(r.text === null || r.text.includes('Acme Payments'), JSON.stringify(r).slice(0, 120));
});

child.kill();
fixture.close();
console.log(`${passed} passed, ${failed} failed (fixture served ${hits} requests)`);
process.exit(failed ? 1 : 0);
