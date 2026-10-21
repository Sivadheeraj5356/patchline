import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flattenSpec, diffSpecs, scanConsumer, buildFixes, buildPR, summarize, normalizePath } from './engines.mjs';

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

// buildFixes
const fixes = buildFixes(files, changes);
const inv = fixes.find((f) => f.file === 'invoices.js');
t('fix renames path prefix in invoices.js', inv.edits.some((e) => e.after.includes("'/v2/invoices'")));
t('fix renames limit->page_size', inv.edits.some((e) => e.after.includes('page_size: 20')));
t('fix maps pending->open', inv.edits.some((e) => e.after.includes("'open'")));
t('fix renames amount_cents->total_cents', inv.edits.some((e) => e.after.includes('total_cents / 100')));
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

console.log(`${pass} passed, ${fail} failed`);
if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
