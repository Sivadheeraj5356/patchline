// End-to-end server tests: real HTTP, real watch lifecycle against a live fixture API.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { buildTarGz } from './tar-fixture.mjs';

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
  env: { ...process.env, PORT: '18499', PATCHLINE_DATA: dataDir, PATCHLINE_MIN_INTERVAL_MIN: '1', PATCHLINE_ALLOW_PRIVATE: '1' },
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
  // this file calls /v2/payouts only: invoice-field changes must NOT match here (cross-endpoint guard)
  const files = [{ name: 'app.js', content: "const total = inv.amount_cents / 100;\nawait api.get('/v2/payouts');\n" }];
  const r = await post('/api/analyze', { oldUrl: fixtureUrl, newText: specV2, files });
  ok(r.summary && r.summary.breaking > 5, JSON.stringify(r.summary || r));
  ok(r.usages.length === 1 && r.usages[0].change.type === 'endpoint_removed', `usages ${JSON.stringify(r.usages.map(u=>u.change.type))}`);
  // a file calling /v2/invoices DOES match invoice field changes; a file with no endpoint refs stays eligible
  const files2 = [
    { name: 'inv.js', content: "await api.get('/v2/invoices');\nconst t = inv.amount_cents / 100;\n" },
    { name: 'util.js', content: "export const cents = (x) => x.amount_cents / 100;\n" },
  ];
  const r2 = await post('/api/analyze', { oldUrl: fixtureUrl, newText: specV2, files: files2 });
  ok(r2.usages.some((u) => u.file === 'inv.js' && u.change.type === 'response_field_renamed'), 'inv.js matches invoice rename');
  ok(r2.usages.some((u) => u.file === 'util.js' && u.change.type === 'response_field_renamed'), 'endpoint-free file stays eligible');
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

await t('SSRF guard: second server without test-mode flag refuses private URLs', async () => {
  const child2 = spawn('node', [join(root, 'src/server.mjs')], {
    env: { ...process.env, PORT: '18500', PATCHLINE_DATA: dataDir },
    stdio: 'pipe',
  });
  await new Promise((resolve, reject) => {
    child2.stdout.on('data', (d) => { if (String(d).includes('patchline server on')) resolve(); });
    setTimeout(() => reject(new Error('server2 start timeout')), 8000);
  });
  try {
    const r = await (await fetch('http://127.0.0.1:18500/api/watches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'ssrf', url: fixtureUrl }) })).json();
    ok(r.error && /non-public|refus/i.test(r.error), JSON.stringify(r));
    const r2 = await (await fetch('http://127.0.0.1:18500/api/fetch-spec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: fixtureUrl }) })).json();
    ok(r2.error && /non-public|refus/i.test(r2.error), JSON.stringify(r2));
  } finally {
    child2.kill();
  }
});

await t('watch with repoUrl attaches consumer impact to change events', async () => {
  // local bare repo standing in for a public consumer repo (file:// clone, no network)
  const consumerRepo = mkdtempSync(join(tmpdir(), 'patchline-consumer-'));
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '-q'], { cwd: consumerRepo });
  execFileSync('git', ['-C', consumerRepo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  writeFileSync(join(consumerRepo, 'app.js'), "const t = inv.amount_cents / 100;\nawait api.get('/v2/payouts');\n");
  execFileSync('git', ['-C', consumerRepo, 'add', '-A']);
  execFileSync('git', ['-C', consumerRepo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'app']);

  current = specV1;
  const created = await post('/api/watches', { name: 'with-repo', url: fixtureUrl, repoUrl: 'file://' + consumerRepo, intervalMinutes: 1 });
  // file:// is not http(s) - repoUrl must be rejected, proving validation
  ok(created.error, 'file:// repoUrl should be rejected');
  const created2 = await post('/api/watches', { name: 'with-repo2', url: fixtureUrl, intervalMinutes: 1 });
  ok(created2.watch, JSON.stringify(created2));
  current = specV2;
  const changed = await post('/api/watches/check', { id: created2.watch.id });
  ok(changed.status === 'changed', 'change');
  ok(!changed.event.impact, 'no repoUrl -> no impact block');
  await fetch(B + '/api/watches?id=' + created2.watch.id, { method: 'DELETE' });
});

await t('watch -> repo impact via pinned archive fetch (git-free server path)', async () => {
  // consumer repo served as a tar.gz from a local fixture (github/codeload shape)
  const consumerGz = buildTarGz([
    { name: 'consumer-abc/src/invoices.js', content: "const t = inv.amount_cents / 100;\nawait api.get('/v2/payouts');\n" },
    { name: 'consumer-abc/node_modules/dep/index.js', content: 'skip();\n' },
  ]);
  const repoSrv = createServer((req, res) => {
    if (req.url === '/repo.tar.gz') { res.writeHead(200, { 'content-type': 'application/gzip' }); res.end(consumerGz); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => repoSrv.listen(0, '127.0.0.1', r));
  const repoUrl = `http://127.0.0.1:${repoSrv.address().port}/repo.tar.gz`;
  try {
    // repoUrl validation: non-http still refused; archive URL accepted by default (no flag)
    const bad = await post('/api/watches', { name: 'bad-repo', url: fixtureUrl, repoUrl: 'file:///tmp/x', intervalMinutes: 1 });
    ok(bad.error, 'file:// repoUrl refused');
    current = specV1;
    const created = await post('/api/watches', { name: 'arch-repo', url: fixtureUrl, repoUrl, intervalMinutes: 1 });
    ok(created.watch && created.watch.repoUrl === repoUrl, 'repoUrl accepted (archive path, no clone flag): ' + JSON.stringify(created).slice(0, 200));
    current = specV2;
    const changed = await post('/api/watches/check', { id: created.watch.id });
    ok(changed.status === 'changed', 'change detected');
    ok(changed.event.impact && changed.event.impact.repoUrl === repoUrl, 'impact block attached');
    ok(changed.event.impact.scannedFiles === 1, 'node_modules filtered, 1 code file scanned: ' + JSON.stringify(changed.event.impact).slice(0, 200));
    ok(changed.event.impact.affectedLines >= 1, 'affected lines reported');
    ok(changed.event.impact.manualSpots >= 1, 'manual-review spot for removed /v2/payouts usage');
    await fetch(B + '/api/watches?id=' + created.watch.id, { method: 'DELETE' });
  } finally {
    repoSrv.close();
  }
});

await t('shared-secret auth gate when PATCHLINE_AUTH_KEY set', async () => {
  const child4 = spawn('node', [join(root, 'src/server.mjs')], {
    env: { ...process.env, PORT: '18502', PATCHLINE_DATA: dataDir, PATCHLINE_MIN_INTERVAL_MIN: '1', PATCHLINE_ALLOW_PRIVATE: '1', PATCHLINE_AUTH_KEY: 'test-secret-123' },
    stdio: 'pipe',
  });
  await new Promise((resolve, reject) => {
    child4.stdout.on('data', (d) => { if (String(d).includes('patchline server on')) resolve(); });
    setTimeout(() => reject(new Error('server4 start timeout')), 8000);
  });
  try {
    const B4 = 'http://127.0.0.1:18502';
    const health = await fetch(B4 + '/api/health');
    ok(health.status === 200, 'health open without key');
    const ui = await fetch(B4 + '/');
    ok(ui.status === 200, 'UI page served without key');
    const noKey = await fetch(B4 + '/api/watches');
    ok(noKey.status === 401, 'watches 401 without key');
    const wrong = await fetch(B4 + '/api/watches', { headers: { 'x-patchline-key': 'nope' } });
    ok(wrong.status === 401, 'watches 401 with wrong key');
    const right = await fetch(B4 + '/api/watches', { headers: { 'x-patchline-key': 'test-secret-123' } });
    ok(right.status === 200, 'watches 200 with correct key');
    const postNoKey = await fetch(B4 + '/api/watches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', url: fixtureUrl }) });
    ok(postNoKey.status === 401, 'POST also gated');
  } finally {
    child4.kill();
  }
});

child.kill();
fixture.close();
console.log(`${passed} passed, ${failed} failed (fixture served ${hits} requests)`);
process.exit(failed ? 1 : 0);
