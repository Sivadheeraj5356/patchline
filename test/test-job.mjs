// Bounded local integration tests for the interactive job runner - these
// simulate the job workflow locally (job file -> runner -> result JSON).
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

let pass = 0, fail = 0;
const failures = [];
const t = (name, cond) => { if (cond) pass++; else { fail++; failures.push(name); } };

const specA = JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1.0' }, paths: { '/a': { get: { operationId: 'getA', responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } } } } } } } } } });
const specB = JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1.1' }, paths: { '/a': { get: { operationId: 'getA', responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'integer' } } } } } } } } } } });

const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(req.url === '/old.json' ? specA : specB);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const dir = mkdtempSync(join(tmpdir(), 'pl-job-'));
const run = async (job, env = {}) => {
  const jp = join(dir, 'job-' + Math.random().toString(36).slice(2) + '.json');
  writeFileSync(jp, typeof job === 'string' ? job : JSON.stringify(job));
  try {
    const { stdout } = await execFileP(process.execPath, ['scripts/actions-job.mjs', '--job', jp, '--data', dir], { env: { ...process.env, ...env } });
    return { code: 0, out: stdout };
  } catch (e) { return { code: e.code, out: String(e.stdout || '') + String(e.stderr || '') }; }
};

const id = '11111111-2222-3333-4444-555555555555';

// 1. happy path: analyze diff job, private fixture allowed via test override
let r = await run({ job_id: id, type: 'analyze', oldUrl: base + '/old.json', newUrl: base + '/new.json' }, { PATCHLINE_ALLOW_PRIVATE: '1' });
t('analyze job exits 0', r.code === 0);
const rp = join(dir, 'jobs', id + '.json');
t('result file written', existsSync(rp));
const res = JSON.parse(readFileSync(rp, 'utf8'));
t('status done', res.status === 'done');
t('breaking change detected (name removed)', res.result.summary.breaking >= 1);
t('result carries no token material', !readFileSync(rp, 'utf8').match(/GITHUB_TOKEN|ghp_|github_pat_/));

// 2. dedupe: second run is a no-op, file untouched
const before = statSync(rp).mtimeMs;
r = await run({ job_id: id, type: 'analyze', oldUrl: base + '/old.json', newUrl: base + '/new.json' }, { PATCHLINE_ALLOW_PRIVATE: '1' });
t('dedupe run exits 0', r.code === 0);
t('dedupe reported', r.out.includes('dedupe'));
t('result file unchanged', statSync(rp).mtimeMs === before);

// 3. rejections (exit 2, no result files)
const bad = [
  ['traversal job_id', { job_id: '../../etc/passwd', type: 'analyze', oldUrl: base + '/old.json', newUrl: base + '/new.json' }],
  ['wrong type', { job_id: '22222222-2222-3333-4444-555555555555', type: 'shell', oldUrl: base + '/old.json', newUrl: base + '/new.json' }],
  ['non-github repoUrl', { job_id: '33333333-2222-3333-4444-555555555555', type: 'analyze', oldUrl: base + '/old.json', newUrl: base + '/new.json', repoUrl: 'https://evil.example.com/repo' }],
  ['oversized url', { job_id: '44444444-2222-3333-4444-555555555555', type: 'analyze', oldUrl: 'https://x.example.com/' + 'a'.repeat(3000), newUrl: base + '/new.json' }],
  ['missing oldUrl', { job_id: '55555555-2222-3333-4444-555555555555', type: 'analyze', newUrl: base + '/new.json' }],
];
for (const [name, j] of bad) {
  r = await run(j, { PATCHLINE_ALLOW_PRIVATE: '1' });
  t('rejects ' + name, r.code === 2 && !existsSync(join(dir, 'jobs', j.job_id + '.json')));
}

// 4. SSRF layering: without the test override the fetch of a private host
// fails INSIDE the runner and lands as an error-status result, not a crash
// and not a fetch.
const sid = '66666666-2222-3333-4444-555555555555';
r = await run({ job_id: sid, type: 'analyze', oldUrl: base + '/old.json', newUrl: base + '/new.json' });
t('private target without override exits 0 (error captured)', r.code === 0);
const sres = JSON.parse(readFileSync(join(dir, 'jobs', sid + '.json'), 'utf8'));
t('private target refused by SSRF guard', sres.status === 'error' && /non-public/.test(sres.error));

server.close();
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) console.error('failures: ' + failures.join(', '));
process.exit(fail ? 1 : 0);
