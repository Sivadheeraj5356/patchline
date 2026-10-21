// Tests for real OpenAPI 3.x support (src/openapi.mjs) and the extended classifiers.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpecText, resolveRefs, fromOpenAPI, isRealOpenAPI } from '../src/openapi.mjs';
import { diffSpecs, summarize } from '../src/engines.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = join(root, 'fixtures', 'openapi');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function ok(x, msg = 'expected truthy') { if (!x) throw new Error(msg); }

const v1raw = readFileSync(join(fx, 'payments-v1.json'), 'utf8');
const v2raw = readFileSync(join(fx, 'payments-v2.yaml'), 'utf8');

t('parseSpecText parses JSON', () => {
  const doc = parseSpecText(v1raw);
  eq(doc.info.title, 'Acme Payments API');
});

t('parseSpecText parses YAML', () => {
  const doc = parseSpecText(v2raw);
  eq(doc.info.version, '3.0.0');
  eq(doc.paths['/v3/invoices'].get.operationId, 'listInvoices');
});

t('resolveRefs inlines local refs', () => {
  const doc = resolveRefs(parseSpecText(v1raw));
  const inv = doc.paths['/v2/invoices/{id}'].get.responses['200'].content['application/json'].schema;
  eq(inv.properties.id.type, 'string');
  eq(inv.properties.total.properties.amount_cents.type, 'integer');
});

t('resolveRefs cuts cycles without crashing', () => {
  const cyc = { components: { schemas: { Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' } } } } }, paths: {} };
  const doc = resolveRefs(cyc);
  eq(doc.components.schemas.Node.properties.next.properties.next['x-patchline-circular'], '#/components/schemas/Node');
});

t('resolveRefs rejects external refs with a clear error', () => {
  let msg = '';
  try { resolveRefs({ paths: {}, x: { $ref: 'https://example.com/other.yaml#/x' } }); } catch (e) { msg = e.message; }
  ok(msg.includes('External $ref'), msg);
});

t('fromOpenAPI merges path-level + op-level parameters', () => {
  const spec = fromOpenAPI(parseSpecText(v1raw));
  const get = spec.paths['/v2/invoices'].get;
  const names = get.parameters.map((p) => p.name);
  ok(names.includes('X-Request-Id') && names.includes('limit') && names.includes('status'), names.join(','));
});

t('fromOpenAPI unwraps content-wrapped requestBody and responses', () => {
  const spec = fromOpenAPI(parseSpecText(v1raw));
  const post = spec.paths['/v2/invoices'].post;
  eq(post.requestSchema.required, ['customer_id']);
  eq(post.responses['201'].schema.properties.id.type, 'string');
});

t('fromOpenAPI carries deprecation + security metadata', () => {
  const spec = fromOpenAPI(parseSpecText(v2raw));
  ok(spec.paths['/v3/invoices'].get.deprecated, 'v3 listInvoices deprecated');
  eq(Object.keys(spec._securitySchemes), ['apiKey']);
});

const v1 = fromOpenAPI(parseSpecText(v1raw));
const v2 = fromOpenAPI(parseSpecText(v2raw));
const changes = diffSpecs(v1, v2);
const types = changes.map((c) => c.type);

t('diff detects base path change across version prefix', () => {
  ok(types.includes('base_path_changed'), types.join(','));
});

t('diff detects nested response field rename through $refs (amount_cents -> total_cents)', () => {
  const hit = changes.find((c) => c.type === 'response_field_renamed' && c.from?.endsWith('amount_cents') && c.to?.endsWith('total_cents'));
  ok(hit, types.join(','));
});

t('diff detects response field type change (quantity integer -> number)', () => {
  const hit = changes.find((c) => c.type === 'response_field_type_changed' && c.field?.endsWith('quantity'));
  ok(hit && hit.review === true, types.join(','));
});

t('diff detects removed response code (206)', () => {
  ok(changes.some((c) => c.type === 'response_code_removed' && c.from === '206'), types.join(','));
});

t('diff detects optional->required param flips (limit, X-Request-Id)', () => {
  const hits = changes.filter((c) => c.type === 'param_required_changed');
  ok(hits.some((c) => c.from === 'limit') && hits.some((c) => c.from === 'X-Request-Id'), JSON.stringify(hits));
});

t('diff flags newly deprecated endpoint as warning, not breaking', () => {
  const hit = changes.find((c) => c.type === 'endpoint_deprecated');
  ok(hit && hit.kind === 'warning', types.join(','));
});

t('diff flags removed security scheme for review', () => {
  const hit = changes.find((c) => c.type === 'security_scheme_removed' && c.from === 'legacyBasic');
  ok(hit && hit.review === true, types.join(','));
});

t('diff flags new required request field for review', () => {
  const hit = changes.find((c) => c.type === 'request_field_added_required' && c.to === 'idempotency_key');
  ok(hit && hit.review === true, types.join(','));
});

t('diff detects removed endpoint (payouts) as manual-review', () => {
  const hit = changes.find((c) => c.type === 'endpoint_removed' && c.endpoint.includes('payouts'));
  ok(hit && hit.review === true, types.join(','));
});

t('diff reports additive enum value (uncollectible) as non-breaking', () => {
  ok(!changes.some((c) => c.type === 'enum_value_removed' && c.from === 'uncollectible'), 'gained enum wrongly breaking');
});

t('summarize counts warnings and review flags', () => {
  const s = summarize(changes);
  ok(s.warnings >= 1 && s.review >= 4 && s.breaking >= 6, JSON.stringify(s));
});

t('isRealOpenAPI distinguishes shapes', () => {
  ok(isRealOpenAPI(parseSpecText(v1raw)), 'v1 real');
  ok(!isRealOpenAPI({ paths: {} }), 'simplified shape');
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
