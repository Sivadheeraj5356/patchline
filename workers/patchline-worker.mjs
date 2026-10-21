// Patchline hosted worker (candidate route, not deployed): thin proxy host.
// - Serves the static UI (inlined at build time by scripts/build-worker.mjs).
// - Same timing-safe shared-secret gate as the local server on every /api route.
// - NEVER fetches user spec URLs itself and never runs the engines: interactive
//   work is dispatched to the GitHub Actions job workflow; heavy fetch/scan runs
//   on Actions where the $0 budget hard-block applies.
// - Job results are read back privately from the patchline-data branch via the
//   GitHub contents API, cached briefly in KV.
// Env bindings: PATCHLINE_AUTH_KEY (secret), GITHUB_DISPATCH_PAT (secret,
// repo-scoped Actions:write+Contents:read), GITHUB_REPO "owner/repo",
// GITHUB_API_BASE (default https://api.github.com), RATE_LIMIT_PER_HOUR
// (default 10), KV namespace JOBS.

const UI_HTML = /*__PATCHLINE_UI__*/'__PATCHLINE_UI_PLACEHOLDER__';

const enc = new TextEncoder();
const eq = (a, b) => {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
const json = (code, body, extra = {}) =>
  new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json', ...extra } });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_URL_LEN = 2048;
const validSpecUrl = (u) => {
  if (typeof u !== 'string' || !u.length || u.length > MAX_URL_LEN) return false;
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
};

async function gh(env, path, opts = {}) {
  const base = env.GITHUB_API_BASE || 'https://api.github.com';
  const res = await fetch(base + path, {
    ...opts,
    headers: {
      authorization: 'Bearer ' + env.GITHUB_DISPATCH_PAT,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'patchline-worker',
      ...(opts.headers || {}),
    },
  });
  return res;
}

async function readBranchJson(env, path) {
  const cached = await env.JOBS.get('cache:' + path, 'json');
  if (cached) return { status: 200, body: cached };
  const res = await gh(env, `/repos/${env.GITHUB_REPO}/contents/${path}?ref=patchline-data`);
  if (res.status !== 200) return { status: res.status, body: null };
  const meta = await res.json();
  const body = JSON.parse(atob(meta.content.replace(/\n/g, '')));
  await env.JOBS.put('cache:' + path, JSON.stringify(body), { expirationTtl: 60 });
  return { status: 200, body };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/' || p === '/index.html') {
      return new Response(UI_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (p === '/api/health') return json(200, { ok: true, hosted: true });

    // The static snapshot (baked private state) is served ONLY behind the
    // gate, from KV (written at deploy time). The openly served UI shell
    // above never contains baked state.
    if (p === '/snapshot') {
      if (!eq(request.headers.get('x-patchline-key'), env.PATCHLINE_AUTH_KEY)) {
        return json(401, { error: 'unauthorized' });
      }
      const html = await env.JOBS.get('snapshot:index.html');
      if (!html) return json(404, { error: 'no snapshot published yet' });
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' } });
    }

    // every other /api route is behind the shared-secret gate
    if (!eq(request.headers.get('x-patchline-key'), env.PATCHLINE_AUTH_KEY)) {
      return json(401, { error: 'unauthorized' });
    }

    if (p === '/api/watches' && request.method === 'GET') {
      const r = await readBranchJson(env, 'watches.json');
      return r.status === 200 ? json(200, { watches: r.body, minIntervalMinutes: 60 }) : json(r.status === 404 ? 200 : 502, { watches: [], note: 'no hosted state yet' });
    }
    if (p === '/api/events' && request.method === 'GET') {
      const r = await readBranchJson(env, 'events.json');
      return r.status === 200 ? json(200, { events: r.body }) : json(r.status === 404 ? 200 : 502, { events: [], note: 'no hosted state yet' });
    }

    if (p === '/api/jobs' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json(400, { error: 'invalid JSON body' }); }
      if (JSON.stringify(body).length > 8192) return json(413, { error: 'payload too large' });
      if (!validSpecUrl(body.oldUrl) || !validSpecUrl(body.newUrl)) return json(400, { error: 'oldUrl and newUrl must be https URLs' });
      if (body.repoUrl != null && (typeof body.repoUrl !== 'string' || body.repoUrl.length > MAX_URL_LEN || !body.repoUrl.startsWith('https://github.com/'))) {
        return json(400, { error: 'repoUrl must be a https://github.com/ repository' });
      }
      // global rate limit behind the gate: N jobs per rolling hour
      const limit = Number(env.RATE_LIMIT_PER_HOUR || 10);
      const bucket = 'rate:' + new Date().toISOString().slice(0, 13);
      const used = (await env.JOBS.get(bucket, 'json')) || 0;
      if (used >= limit) return json(429, { error: 'hourly job limit reached', limit });
      // dedupe identical in-flight requests by payload hash
      const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode([body.oldUrl, body.newUrl, body.repoUrl || ''].join('\n')));
      const hash = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
      const existing = await env.JOBS.get('dedupe:' + hash, 'json');
      if (existing) return json(200, { job_id: existing.job_id, status: existing.status, deduped: true });

      const job = { job_id: crypto.randomUUID(), type: 'analyze', oldUrl: body.oldUrl, newUrl: body.newUrl };
      if (body.repoUrl) job.repoUrl = body.repoUrl;
      const res = await gh(env, `/repos/${env.GITHUB_REPO}/actions/workflows/job.yml/dispatches`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: 'main', inputs: { payload: JSON.stringify(job) } }),
      });
      if (res.status !== 204) return json(502, { error: 'dispatch failed', upstream: res.status });
      const rec = { job_id: job.job_id, status: 'dispatched', at: new Date().toISOString() };
      await env.JOBS.put('job:' + job.job_id, JSON.stringify(rec), { expirationTtl: 86400 });
      await env.JOBS.put('dedupe:' + hash, JSON.stringify(rec), { expirationTtl: 3600 });
      await env.JOBS.put(bucket, JSON.stringify(used + 1), { expirationTtl: 3700 });
      return json(202, rec);
    }

    const m = p.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
    if (m && request.method === 'GET') {
      if (!UUID_RE.test(m[1])) return json(400, { error: 'bad job id' });
      const r = await readBranchJson(env, `jobs/${m[1]}.json`);
      if (r.status === 200) return json(200, r.body);
      const rec = await env.JOBS.get('job:' + m[1], 'json');
      if (rec) return json(200, { job_id: m[1], status: 'pending', dispatchedAt: rec.at });
      return json(404, { error: 'unknown job id' });
    }

    return json(404, { error: 'not found' });
  },
};
