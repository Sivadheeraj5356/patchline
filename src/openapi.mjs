// Real OpenAPI 3.x support: YAML/JSON parsing, local $ref resolution,
// and normalization into Patchline's internal spec shape.
//
// The internal shape matches what engines.mjs already consumes (paths ->
// method -> { operationId, parameters, requestSchema, responses: {code: {schema}} }),
// extended with optional extras: op.deprecated, op.security, doc._securitySchemes.

import { createRequire } from 'node:module';

// yaml is an npm dependency on the server/CLI side. The browser UI accepts
// JSON directly or fetches specs through the server (which handles YAML).
const require = createRequire(import.meta.url);
let YAML = null;
try {
  YAML = require('yaml');
} catch {
  YAML = null; // browser / no-dep context: JSON only
}

export function parseSpecText(text, { sourceName = 'spec' } = {}) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  if (!YAML) {
    throw new Error(`${sourceName}: YAML input needs the server/CLI (yaml package); paste JSON or fetch via URL in the hosted app.`);
  }
  return YAML.parse(trimmed);
}

function resolvePointer(doc, ref) {
  if (!ref.startsWith('#/')) {
    throw new Error(`External $ref "${ref}" is not supported yet; inline the schema or host a bundled spec.`);
  }
  const parts = ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = doc;
  for (const part of parts) {
    if (node == null || typeof node !== 'object' || !(part in node)) {
      throw new Error(`Unresolvable $ref "${ref}": missing "${part}".`);
    }
    node = node[part];
  }
  return node;
}

// Deep-resolve local $refs with a cycle guard. Cycles (common in recursive
// schemas) are cut: the repeated ref is replaced by a marker so diffing can
// still compare the acyclic prefix.
export function resolveRefs(doc) {
  const walk = (node, stack) => {
    if (Array.isArray(node)) return node.map((x) => walk(x, stack));
    if (node && typeof node === 'object') {
      if (typeof node.$ref === 'string') {
        if (stack.includes(node.$ref)) return { type: 'object', 'x-patchline-circular': node.$ref };
        const target = resolvePointer(doc, node.$ref);
        const siblings = { ...node };
        delete siblings.$ref;
        return { ...walk(target, [...stack, node.$ref]), ...walk(siblings, stack) };
      }
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, stack);
      return out;
    }
    return node;
  };
  return walk(doc, []);
}

function firstJsonSchema(mediaHolder) {
  if (!mediaHolder) return null;
  if (mediaHolder.schema) return mediaHolder.schema; // already simplified shape
  const content = mediaHolder.content;
  if (content && typeof content === 'object') {
    if (content['application/json']?.schema) return content['application/json'].schema;
    const first = Object.values(content).find((c) => c && c.schema);
    if (first) return first.schema;
  }
  return null;
}

// allOf: merge properties/required of all members (shallow, object schemas).
function mergeAllOf(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (!Array.isArray(schema.allOf)) return schema;
  const merged = { type: 'object', properties: {}, required: [] };
  for (const member of schema.allOf) {
    const m = mergeAllOf(member) || {};
    if (m.type && m.type !== 'object') merged.type = m.type;
    Object.assign(merged.properties, m.properties || {});
    for (const r of m.required || []) if (!merged.required.includes(r)) merged.required.push(r);
    for (const k of ['enum', 'format', 'description']) if (m[k] !== undefined) merged[k] = m[k];
  }
  const rest = { ...schema };
  delete rest.allOf;
  Object.assign(merged.properties, rest.properties || {});
  for (const r of rest.required || []) if (!merged.required.includes(r)) merged.required.push(r);
  if (rest.type) merged.type = rest.type;
  return merged;
}

// oneOf/anyOf: keep the union as x-patchline-union so the differ can flag
// member additions/removals without pretending it is one object shape.
function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema.allOf)) schema = mergeAllOf(schema);
  const out = { ...schema };
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const key = Array.isArray(schema.oneOf) ? 'oneOf' : 'anyOf';
    out['x-patchline-union'] = { kind: key, members: schema[key].map((m) => summarizeSchema(m)) };
    delete out.oneOf;
    delete out.anyOf;
  }
  if (out.properties) {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, normalizeSchema(v)]));
  }
  if (out.items) out.items = normalizeSchema(out.items);
  return out;
}

function summarizeSchema(s) {
  if (!s || typeof s !== 'object') return 'unknown';
  if (s.type === 'object' && s.properties) return `object{${Object.keys(s.properties).join(',')}}`;
  if (s.type === 'array') return `array<${summarizeSchema(s.items)}>`;
  return s.type || 'unknown';
}

// Convert a real (or already-simplified) OpenAPI doc into the internal shape.
export function fromOpenAPI(input) {
  const doc = resolveRefs(input);
  const paths = {};
  for (const [p, item] of Object.entries(doc.paths || {})) {
    if (!item || typeof item !== 'object') continue;
    const pathParams = Array.isArray(item.parameters) ? item.parameters : [];
    const methods = {};
    for (const [m, op] of Object.entries(item)) {
      if (!['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'].includes(m.toLowerCase())) continue;
      if (!op || typeof op !== 'object') continue;
      const params = [...pathParams, ...(Array.isArray(op.parameters) ? op.parameters : [])];
      const responses = {};
      for (const [code, resp] of Object.entries(op.responses || {})) {
        responses[code] = {
          description: resp?.description || '',
          schema: normalizeSchema(firstJsonSchema(resp)),
        };
      }
      const requestSchema = normalizeSchema(firstJsonSchema(op.requestBody)) || op.requestSchema || null;
      methods[m] = {
        operationId: op.operationId || null,
        summary: op.summary || null,
        deprecated: !!op.deprecated,
        security: op.security !== undefined ? op.security : null, // null = inherit doc default
        parameters: params,
        requestSchema,
        responses,
      };
    }
    if (Object.keys(methods).length) paths[p] = methods;
  }
  const out = {
    openapi: doc.openapi || doc.swagger || null,
    info: doc.info || {},
    paths,
    _securitySchemes: doc.components?.securitySchemes || {},
    _securityDefault: doc.security || [],
  };
  return out;
}

export function isRealOpenAPI(doc) {
  return !!(doc && typeof doc === 'object' && (doc.openapi || doc.swagger));
}
