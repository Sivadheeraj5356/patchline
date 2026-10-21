import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flattenSpec, diffSpecs, scanConsumer, buildFixes, buildPR, summarize, normalizePath } from '../src/engines.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = join(root, 'fixtures');
const oldSpec = JSON.parse(readFileSync(join(fx, 'billing-api-v1.json'), 'utf8'));
const newSpec = JSON.parse(readFileSync(join(fx, 'billing-api-v2.json'), 'utf8'));
const files = readdirSync(join(fx, 'consumer')).map((n) => ({ name: n, content: readFileSync(join(fx, 'consumer', n), 'utf8') }));

let pass = 0, fail = 0;
const failures = [];
function t(name, cond) { if (cond) pass++; else { fail++; failures.push(name); } }

// flattenSpec
const flat = flattenSpec(oldSpec);
t('flatten finds 3 v1 operations', flat.size === 3);
t('flatten captures params', flat.get('GET /v1/invoices').params.length === 2);
t('flatten captures nested response fields', 'invoices[].amount_cents' in flat.get('GET /v1/invoices').responseFields);
t('normalizePath strips version', normalizePath('/v12/things') === '/things');

// diffSpecs
const changes = diffSpecs(oldSpec, newSpec);
const types = changes.map((c) => c.type);
t('detects endpoint_removed for POST /v1/charges', changes.some((c) => c.type === 'endpoint_removed' && c.endpoint === 'POST /v1/charges'));
t('detects base_path_changed', types.includes('base_path_changed'));
t('detects param_renamed limit->page_size', changes.some((c) => c.type === 'param_renamed' && c.from === 'limit' && c.to === 'page_size'));
t('detects response_field_renamed amount_cents->total_cents', changes.some((c) => c.type === 'response_field_renamed' && c.from === 'invoices[].amount_cents' && c.to === 'invoices[].total_cents'));
t('detects enum_value_removed pending->open', changes.some((c) => c.type === 'enum_value_removed' && c.from === 'pending' && c.to === 'open'));
t('detects request_field_renamed', changes.some((c) => c.type === 'request_field_renamed' && c.from === 'amount_cents' && c.to === 'total_cents'));
t('detects endpoint_added balance', changes.some((c) => c.type === 'endpoint_added' && c.endpoint.includes('/balance')));
t('additive changes are not marked breaking', changes.filter((c) => c.kind === 'additive').every((c) => ['endpoint_added', 'response_field_added'].includes(c.type)));
t('no false breaking on unchanged createInvoice status field', !changes.some((c) => c.type === 'response_field_removed' && c.from === 'id'));

// scanConsumer
const usages = scanConsumer(files, changes);
t('scan flags /v1/invoices usage in invoices.js', usages.some((u) => u.file === 'invoices.js' && u.text.includes("'/v1/invoices'")));
t('scan flags limit param usage', usages.some((u) => u.file === 'invoices.js' && u.text.includes('limit: 20')));
t('scan flags pending enum usage', usages.some((u) => u.file === 'invoices.js' && u.text.includes("'pending'")));
t('scan flags amount_cents usage', usages.some((u) => u.file === 'invoices.js' && u.text.includes('amount_cents')));
t('scan flags removed /v1/charges', usages.some((u) => u.file === 'charges.js' && u.text.includes('/v1/charges')));
t('scan does not flag clean client.js headers', !usages.some((u) => u.file === 'client.js' && u.text.includes('Content-Type')));

// buildFixes - default: inferred renames/enum guesses are SUGGESTED, not applied
const fixes = buildFixes(files, changes);
const inv = fixes.find((f) => f.file === 'invoices.js');
t('fix renames path prefix in invoices.js', inv.edits.some((e) => e.after.includes("'/v2/invoices'")));
t('inferred rename limit->page_size suggested not applied', !inv.edits.some((e) => e.after.includes('page_size: 20')) && inv.suggested.some((s) => s.after.includes('page_size: 20')));
t('inferred enum pending->open suggested not applied', !inv.edits.some((e) => e.after.includes("'open'")) && inv.suggested.some((s) => s.after.includes("'open'")));
t('inferred rename amount_cents->total_cents suggested not applied', !inv.edits.some((e) => e.after.includes('total_cents / 100')) && inv.suggested.some((s) => s.after.includes('total_cents / 100')));

// buildFixes with applyInferred: the apply mechanism itself still works when a human opts in
const fixesAI = buildFixes(files, changes, { applyInferred: true });
const invAI = fixesAI.find((f) => f.file === 'invoices.js');
t('applyInferred applies limit->page_size', invAI.edits.some((e) => e.after.includes('page_size: 20')));
t('applyInferred maps pending->open', invAI.edits.some((e) => e.after.includes("'open'")));
t('applyInferred renames amount_cents->total_cents', invAI.edits.some((e) => e.after.includes('total_cents / 100')));

// ambiguous renames must NOT pair (false-positive guard)
const amb1 = { paths: { '/v1/x': { get: { responses: { '200': { schema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } } } } } } } } };
const amb2 = { paths: { '/v1/x': { get: { responses: { '200': { schema: { type: 'object', properties: { c: { type: 'integer' }, d: { type: 'integer' } } } } } } } } };
const ambChanges = diffSpecs(amb1, amb2);
t('ambiguous rename produces no rename guess', !ambChanges.some((c) => c.type === 'response_field_renamed'));
t('ambiguous fields reported as removed+added separately', ambChanges.filter((c) => c.type === 'response_field_removed').length === 2 && ambChanges.filter((c) => c.type === 'response_field_added').length === 2);
const ambEnum1 = { paths: { '/v1/y': { get: { parameters: [{ name: 's', in: 'query', schema: { type: 'string', enum: ['x'] } }], responses: {} } } } };
const ambEnum2 = { paths: { '/v1/y': { get: { parameters: [{ name: 's', in: 'query', schema: { type: 'string', enum: ['p', 'q'] } }], responses: {} } } } };
const ambEnum = diffSpecs(ambEnum1, ambEnum2);
t('enum with multiple candidates gets no inferred replacement', ambEnum.some((c) => c.type === 'enum_value_removed' && c.from === 'x' && !c.to && !c.inferred));
const chg = fixes.find((f) => f.file === 'charges.js');
t('charges.js flagged manual review (endpoint removed)', chg && chg.manual.length >= 1);
t('no auto-edit claimed for removed endpoint', !chg.edits.some((e) => e.after.includes('/v2/charges')));
t('zero auto-edits on lines calling a removed endpoint', chg.edits.length === 0);

// buildPR
const pr = buildPR({ oldVersion: '1.8.1', newVersion: '2.0.0', apiTitle: 'Northwind Billing API', changes, fixes });
t('PR mentions version migration', pr.includes('1.8.1 -> 2.0.0'));
t('PR lists breaking changes section', pr.includes('### Breaking changes'));
t('PR includes diff block', pr.includes('```diff'));
t('PR includes manual review warning', pr.includes('Manual review'));
t('PR includes verification checklist', pr.includes('Verification checklist'));

// summarize
const s = summarize(changes);
t('summary counts add up', s.breaking + s.additive === s.total && s.breaking >= 5);


// ---- reconciliation hardening tests (cross-side ambiguity, dedupe, endpoint scope) ----
{
  // response field 'status' renamed but request field 'status' retained:
  // text matching cannot tell a read from a write -> no inferred rename
  const mkOp = (reqProps, respProps) => ({
    params: [], responses: { '200': { schema: { properties: respProps } } }, requestSchema: { properties: reqProps },
  });
  const v1 = { info: { version: '1' }, paths: { '/v1/x': { get: mkOp({ status: { type: 'string' } }, { status: { type: 'string' }, id: { type: 'string' } }) } } };
  const v2 = { info: { version: '2' }, paths: { '/v2/x': { get: mkOp({ status: { type: 'string' } }, { state: { type: 'string' }, id: { type: 'string' } }) } } };
  const ch = diffSpecs(v1, v2);
  t('cross-side ambiguous rename suppressed (no response_field_renamed)', !ch.some((c) => c.type === 'response_field_renamed' && c.from === 'status'));
  t('cross-side ambiguity falls back to removed+added', ch.some((c) => c.type === 'response_field_removed' && c.from === 'status') && ch.some((c) => c.type === 'response_field_added' && c.to === 'state'));

  // consistent cross-side rename (both sides amount_cents->total_cents) stays inferred
  const w1 = { info: { version: '1' }, paths: { '/v1/y': { post: mkOp({ amount_cents: { type: 'integer' } }, { amount_cents: { type: 'integer' } }) } } };
  const w2 = { info: { version: '2' }, paths: { '/v2/y': { post: mkOp({ total_cents: { type: 'integer' } }, { total_cents: { type: 'integer' } }) } } };
  const ch2 = diffSpecs(w1, w2);
  t('consistent cross-side rename kept on response side', ch2.some((c) => c.type === 'response_field_renamed' && c.from === 'amount_cents' && c.to === 'total_cents'));
  t('consistent cross-side rename kept on request side', ch2.some((c) => c.type === 'request_field_renamed' && c.from === 'amount_cents' && c.to === 'total_cents'));
}
{
  // duplicate suggestions: same file/line/replacement from two changes (GET+POST schema) collapses to one
  const files2 = [{ name: 'a.js', content: "const r = await api.get('/v1/invoices', { limit: 20 });\n" }];
  const mkChange = (endpoint) => ({ kind: 'breaking', type: 'param_renamed', endpoint, from: 'limit', to: 'page_size', inferred: true, migration: 'm' });
  const fxd = buildFixes(files2, [mkChange('GET /v1/invoices'), mkChange('POST /v1/invoices')]);
  t('identical suggestion from two changes deduped to one', fxd[0].suggested.length === 1);

  // cross-endpoint scope: a file that only calls /v1/other is not flagged for /v1/invoices changes
  const files3 = [{ name: 'b.js', content: "await api.get('/v1/other', { limit: 5 });\n" }];
  const ch3 = [mkChange('GET /v1/invoices')]; ch3.allEndpoints = ['/invoices/', '/other'];
  const usages3 = scanConsumer(files3, ch3);
  t('no usage flagged in file calling a different endpoint', usages3.length === 0);
  const fxd3 = buildFixes(files3, ch3);
  t('no suggestion or edit in file calling a different endpoint', fxd3.length === 0 || (fxd3[0].suggested.length === 0 && fxd3[0].edits.length === 0));
}
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
