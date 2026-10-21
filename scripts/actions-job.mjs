// One-off interactive job runner ($0 hosted-interactive path): executed by the
// job workflow (ci/job.workflow.yml, staged for owner web-UI commit) with a
// single dispatch payload written to a job file. Runs the SAME engines as the
// server - one "analyze" job = spec diff + optional consumer impact + PR draft,
// exactly the product's interactive flow (steps 02-04). Writes the result to
// <data>/jobs/<job_id>.json for the hosted UI to read back. No listen socket;
// the workflow's GITHUB_TOKEN is never written into the result.
//
//   node scripts/actions-job.mjs --job ./job.json [--data ./data]
//
// Security contract (test-covered):
// - job_id: strict uuid shape only - it becomes a filename, no traversal.
// - type: the literal "analyze" (enum of one, no free-form commands).
// - URLs: https only (loopback http only under the test-only
//   PATCHLINE_ALLOW_PRIVATE=1; net.mjs re-enforces at fetch time), length
//   capped; repoUrl must be a github.com repo via the bounded extractor.
// - No shell is invoked on any input; inputs are data to the engines only.
// - Dedupe: an existing jobs/<id>.json makes the run a no-op - retries never
//   double-run compute or double-write.
// - Result size is capped; oversize results are truncated with a flag.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchText } from '../src/net.mjs';
import { parseSpecText, fromOpenAPI, isRealOpenAPI } from '../src/openapi.mjs';
import { diffSpecs, scanConsumer, buildFixes, buildPR, summarize } from '../src/engines.mjs';
import { fetchRepoArchive } from '../src/archive.mjs';

const arg = (n) => process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : null;
const JOB_PATH = process.env.PATCHLINE_JOB || arg('--job');
const DATA = process.env.PATCHLINE_DATA || arg('--data') || './data';
if (!JOB_PATH) { console.error('usage: --job <job.json>'); process.exit(2); }

const MAX_URL_LEN = 2048;
const MAX_RESULT_BYTES = 200 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const fail = (msg) => { console.error('job rejected: ' + msg); process.exit(2); };
const validUrl = (u) => {
  if (typeof u !== 'string' || u.length > MAX_URL_LEN) return false;
  let p; try { p = new URL(u); } catch { return false; }
  if (p.protocol === 'https:') return true;
  return p.protocol === 'http:' && (p.hostname === '127.0.0.1' || p.hostname === 'localhost');
};

const job = JSON.parse(readFileSync(JOB_PATH, 'utf8'));
if (!UUID_RE.test(String(job.job_id || ''))) fail('job_id must be a uuid');
if (job.type !== 'analyze') fail('type must be "analyze"');
const needUrl = (k, required = true) => {
  const u = job[k];
  if (u == null) { if (required) fail(`missing ${k}`); return null; }
  if (!validUrl(u)) fail(`${k} is not an allowed URL`);
  return u;
};
const oldUrl = needUrl('oldUrl');
const newUrl = needUrl('newUrl');
const repoUrl = needUrl('repoUrl', false);
if (repoUrl && !repoUrl.startsWith('https://github.com/')) fail('repoUrl must be a https://github.com/ repository');

const jobsDir = join(DATA, 'jobs');
mkdirSync(jobsDir, { recursive: true });
const outPath = join(jobsDir, `${job.job_id}.json`);
if (existsSync(outPath)) { console.log(`job ${job.job_id} already has a result - dedupe skip`); process.exit(0); }

const normalize = (text, name) => { const d = parseSpecText(text, { sourceName: name }); return isRealOpenAPI(d) ? fromOpenAPI(d) : d; };

const result = { job_id: job.job_id, type: job.type, status: 'done', finishedAt: null, result: null, error: null, truncated: false };
try {
  const [a, b] = [await fetchText(oldUrl), await fetchText(newUrl)];
  const oldSpec = normalize(a.text, oldUrl);
  const newSpec = normalize(b.text, newUrl);
  const changes = diffSpecs(oldSpec, newSpec);
  result.result = { summary: summarize(changes), changes: changes.slice(0, 500) };
  if (repoUrl) {
    const files = await fetchRepoArchive(repoUrl, { token: process.env.GH_SCAN_TOKEN || null });
    const usages = scanConsumer(files, changes);
    const fixes = buildFixes(files, changes);
    result.result.impact = {
      repoUrl, scannedFiles: files.length, affectedLines: usages.length,
      proposedEdits: fixes.reduce((n, f) => n + f.edits.length, 0),
      inferredSuggestions: fixes.reduce((n, f) => n + (f.suggested || []).length, 0),
      manualSpots: fixes.reduce((n, f) => n + f.manual.length, 0),
      usages: usages.slice(0, 100).map((u) => ({ file: u.file, line: u.line })),
      pr: buildPR({ oldVersion: oldSpec.info?.version, newVersion: newSpec.info?.version, apiTitle: oldSpec.info?.title || 'API', changes, fixes }).slice(0, 50000),
    };
  }
} catch (e) {
  result.status = 'error';
  result.error = String(e.message || e).slice(0, 500);
}
result.finishedAt = new Date().toISOString();

let out = JSON.stringify(result, null, 2);
if (out.length > MAX_RESULT_BYTES) {
  result.truncated = true;
  if (result.result && Array.isArray(result.result.changes)) result.result.changes = result.result.changes.slice(0, 50);
  if (result.result && result.result.impact) result.result.impact.usages = (result.result.impact.usages || []).slice(0, 25);
  out = JSON.stringify(result, null, 2).slice(0, MAX_RESULT_BYTES);
}
writeFileSync(outPath, out);
console.log(`job ${job.job_id} ${result.status} -> ${outPath} (${out.length} bytes)`);
