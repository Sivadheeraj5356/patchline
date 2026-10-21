// Worker proxy integration tests: miniflare runtime + a mock GitHub API.
// Covers the UI-to-job binding, auth gate, private result read-back, dedupe,
// rate limit, validation, and secret hygiene - the hosted route's proxy half.
import { createServer } from 'node:http';
import { Miniflare } from 'miniflare';

let pass = 0, fail = 0;
const failures = [];
const t = (name, cond) => { if (cond) pass++; else { fail++; failures.push(name); } };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const dispatches = [];
const KNOWN_JOB = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const ghMock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const auth = req.headers.authorization || '';
    if (req.method === 'POST' && req.url.endsWith('/actions/workflows/job.yml/dispatches')) {
      dispatches.push({ auth, body: JSON.parse(body || '{}') });
      res.writeHead(204); return res.end();
    }
    if (req.url.includes('/contents/jobs/' + KNOWN_JOB + '.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ content: b64({ job_id: KNOWN_JOB, status: 'done', result: { summary: { breaking: 2 } } }) }));
    }
    if (req.url.includes('/contents/events.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ content: b64([{ id: 'e1' }]) }));
    }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise((r) => ghMock.listen(0, '127.0.0.1', r));
const ghBase = `http://127.0.0.1:${ghMock.address().port}`;

const mf = new Miniflare({
  modules: true,
  scriptPath: 'workers/dist/patchline-worker.mjs',
  kvNamespaces: ['JOBS'],
  bindings: {
    PATCHLINE_AUTH_KEY: 'test-key',
    GITHUB_DISPATCH_PAT: 'secret-pat-marker',
    GITHUB_REPO: 'owner/patchline',
    GITHUB_API_BASE: ghBase,
    RATE_LIMIT_PER_HOUR: '2',
  },
});
const H = { 'x-patchline-key': 'test-key', 'content-type': 'application/json' };
const J = async (r) => ({ status: r.status, body: await r.json() });

// auth gate
let r = await mf.dispatchFetch('http://x/api/events');
t('no key -> 401', r.status === 401);
r = await mf.dispatchFetch('http://x/api/events', { headers: { 'x-patchline-key': 'wrong' } });
t('wrong key -> 401', r.status === 401);
r = await mf.dispatchFetch('http://x/api/health');
t('health open', r.status === 200);
r = await mf.dispatchFetch('http://x/');
t('UI served without key', r.status === 200 && (await r.text()).includes('Patchline'));

// reads from branch state (behind gate)
let j = await J(await mf.dispatchFetch('http://x/api/events', { headers: H }));
t('events read back from branch', j.status === 200 && j.body.events?.[0]?.id === 'e1');

// job validation
const badJob = (b) => mf.dispatchFetch('http://x/api/jobs', { method: 'POST', headers: H, body: JSON.stringify(b) }).then(J);
j = await badJob({ oldUrl: 'http://insecure.example.com/a.json', newUrl: 'https://b.example.com/b.json' });
t('http spec URL rejected', j.status === 400);
j = await badJob({ oldUrl: 'https://a.example.com/a.json', newUrl: 'https://b.example.com/b.json', repoUrl: 'https://gitlab.com/x/y' });
t('non-github repoUrl rejected', j.status === 400);
j = await badJob({ oldUrl: 'https://a.example.com/' + 'a'.repeat(3000), newUrl: 'https://b.example.com/b.json' });
t('oversized URL rejected', j.status === 400);

// happy path dispatch
const payload = { oldUrl: 'https://a.example.com/old.json', newUrl: 'https://a.example.com/new.json', repoUrl: 'https://github.com/mdn/js-examples' };
j = await badJob(payload);
t('job accepted -> 202', j.status === 202);
t('job id is uuid', /^[0-9a-f-]{36}$/.test(j.body.job_id || ''));
t('exactly one upstream dispatch', dispatches.length === 1);
const d = dispatches[0];
t('dispatch used the scoped PAT', d.auth === 'Bearer secret-pat-marker');
t('dispatch targets main with payload input', d.body.ref === 'main' && typeof d.body.inputs?.payload === 'string');
const inner = JSON.parse(d.body.inputs.payload);
t('inner job is the validated analyze shape', inner.type === 'analyze' && inner.oldUrl === payload.oldUrl && inner.repoUrl === payload.repoUrl && /^[0-9a-f-]{36}$/.test(inner.job_id));

// dedupe: identical payload returns same id, no second dispatch
j = await badJob(payload);
t('dedupe returns same job id', j.status === 200 && j.body.deduped === true && j.body.job_id === inner.job_id);
t('still exactly one upstream dispatch', dispatches.length === 1);

// rate limit: second distinct job ok, third refused
j = await badJob({ oldUrl: 'https://a.example.com/o2.json', newUrl: 'https://a.example.com/n2.json' });
t('second distinct job accepted', j.status === 202);
j = await badJob({ oldUrl: 'https://a.example.com/o3.json', newUrl: 'https://a.example.com/n3.json' });
t('third job in the hour -> 429', j.status === 429);

// result read-back: known job served from the branch
j = await J(await mf.dispatchFetch(`http://x/api/jobs/${KNOWN_JOB}`, { headers: H }));
t('known job result read back', j.status === 200 && j.body.status === 'done' && j.body.result.summary.breaking === 2);
// unknown job id (never dispatched) -> 404
j = await J(await mf.dispatchFetch('http://x/api/jobs/99999999-1111-2222-3333-444444444444', { headers: H }));
t('unknown job id -> 404', j.status === 404);

// secret hygiene: neither the PAT nor the gate key may appear in any response body
{
  const bodies = [];
  for (const u of ['/api/events', '/api/jobs/' + KNOWN_JOB, '/api/jobs/99999999-1111-2222-3333-444444444444', '/api/health', '/']) {
    const rr = await mf.dispatchFetch('http://x' + u, { headers: H });
    bodies.push(await rr.text());
  }
  const all = bodies.join('\n');
  t('no PAT in any response body', !all.includes('secret-pat-marker'));
  t('no gate key in any response body', !all.includes('test-key'));
}

ghMock.close();
await mf.dispose();
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) console.error('failures: ' + failures.join(', '));
process.exit(fail ? 1 : 0);
