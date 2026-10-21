// Patchline deterministic engines: spec diff, consumer impact scan, fix + PR generation.
// No network, no AI inference. All logic is rule-based and testable.

const VERSION_PREFIX = /^\/v\d+/;

export function normalizePath(p) {
  return p.replace(VERSION_PREFIX, '');
}

export function leafName(fieldPath) {
  // code refers to the leaf: "invoices[].total.amount_cents" -> "amount_cents"
  if (!fieldPath) return fieldPath;
  return fieldPath.replace(/\[\]/g, '').split('.').pop();
}

export function flattenSpec(spec) {
  const out = new Map();
  const paths = spec.paths || {};
  for (const [p, methods] of Object.entries(paths)) {
    for (const [m, op] of Object.entries(methods)) {
      const resp = op.responses || {};
      const successCodes = Object.keys(resp).filter((c) => /^2\d\d$/.test(c)).sort();
      const first = resp['200'] || resp['201'] || (successCodes[0] && resp[successCodes[0]]) || Object.values(resp)[0] || {};
      const fields = {};
      const props = first.schema?.properties || {};
      // one level of array items / object properties is enough for the demo scope
      const collect = (properties, prefix, requiredList) => {
        for (const [name, def] of Object.entries(properties || {})) {
          fields[prefix + name] = {
            type: def.type || 'object',
            required: (requiredList || []).includes(name),
            enum: def.enum || null,
          };
          if (def.type === 'array' && def.items?.properties) {
            collect(def.items.properties, prefix + name + '[].', def.items.required);
          } else if ((def.type === 'object' || !def.type) && def.properties) {
            collect(def.properties, prefix + name + '.', def.required);
          }
        }
      };
      collect(props, '', first.schema?.required);
      const reqProps = op.requestSchema?.properties || {};
      const requestFields = {};
      for (const [name, def] of Object.entries(reqProps)) {
        requestFields[name] = { type: def.type || 'object', required: (op.requestSchema?.required || []).includes(name) };
      }
      out.set(`${m.toUpperCase()} ${p}`, {
        method: m.toUpperCase(),
        path: p,
        deprecated: !!op.deprecated,
        responseCodes: Object.keys(resp),
        security: op.security !== undefined && op.security !== null ? op.security : (spec._securityDefault || []),
        normalized: normalizePath(p),
        operationId: op.operationId || null,
        params: (op.parameters || []).map((x) => ({ name: x.name, location: x.in, required: !!x.required, type: x.schema?.type || 'string', enum: x.schema?.enum || null })),
        responseFields: fields,
        requestFields,
      });
    }
  }
  return out;
}

function renameCandidate(oldFields, newFields) {
  // a field present in old but absent in new, where a new field of same type appeared -> rename guess
  const removed = Object.keys(oldFields).filter((k) => !(k in newFields));
  const added = Object.keys(newFields).filter((k) => !(k in oldFields));
  const pairs = [];
  const usedAdded = new Set();
  for (const r of removed) {
    const match = added.find((a) => !usedAdded.has(a) && newFields[a].type === oldFields[r].type);
    if (match) { pairs.push([r, match]); usedAdded.add(match); }
  }
  return { pairs, removedOnly: removed.filter((r) => !pairs.some(([a]) => a === r)), addedOnly: added.filter((a) => !usedAdded.has(a)) };
}

export function diffSpecs(oldSpec, newSpec) {
  const oldMap = flattenSpec(oldSpec);
  const newMap = flattenSpec(newSpec);
  const changes = [];
  const matched = new Set();

  // match endpoints across version prefixes
  const newByNormalized = new Map();
  for (const [key, ep] of newMap) {
    const nk = `${ep.method} ${ep.normalized}`;
    if (!newByNormalized.has(nk)) newByNormalized.set(nk, []);
    newByNormalized.get(nk).push([key, ep]);
  }

  for (const [key, ep] of oldMap) {
    const nk = `${ep.method} ${ep.normalized}`;
    const candidates = (newByNormalized.get(nk) || []).filter(([k]) => !matched.has(k));
    if (candidates.length === 0) {
      changes.push({ kind: 'breaking', type: 'endpoint_removed', endpoint: key, detail: `${key} no longer exists in v${newSpec.info.version}.`, migration: 'Manual review: no direct replacement. Check whether another endpoint covers this workflow.' });
      continue;
    }
    const [newKey, nep] = candidates[0];
    matched.add(newKey);
    if (!ep.deprecated && nep.deprecated) {
      changes.push({ kind: 'warning', type: 'endpoint_deprecated', endpoint: key, detail: `${newKey} is now marked deprecated in v${newSpec.info.version}.`, migration: 'Plan a move off this endpoint before its sunset; no immediate breakage.', from: key, to: null });
    }
    const oldCodes = (ep.responseCodes || []).filter((c) => /^2\d\d$/.test(c));
    const newCodes = new Set((nep.responseCodes || []).filter((c) => /^2\d\d$/.test(c)));
    for (const code of oldCodes) {
      if (!newCodes.has(code)) {
        changes.push({ kind: 'breaking', type: 'response_code_removed', endpoint: key, detail: `${key} no longer returns HTTP ${code}.`, migration: 'Manual review: check whether clients branch on this status code and what replaced it.', from: code, to: null });
      }
    }
    if (JSON.stringify(ep.security || []) !== JSON.stringify(nep.security || [])) {
      changes.push({ kind: 'breaking', type: 'security_changed', endpoint: key, detail: `Authentication requirements changed on ${newKey}.`, migration: 'Manual review: compare old and new security requirements and update client credentials/scopes.', from: null, to: null });
    }
    if (ep.path !== nep.path) {
      changes.push({ kind: 'breaking', type: 'base_path_changed', endpoint: key, detail: `Base path moved ${ep.path} -> ${nep.path}.`, migration: `Replace URL prefix ${ep.path.match(VERSION_PREFIX)?.[0] || ''} with ${nep.path.match(VERSION_PREFIX)?.[0] || ''}.`, from: ep.path, to: nep.path });
    }
    // params
    const oldP = Object.fromEntries(ep.params.map((x) => [x.name, x]));
    const newP = Object.fromEntries(nep.params.map((x) => [x.name, x]));
    const pr = renameCandidate(
      Object.fromEntries(ep.params.map((x) => [x.name, { type: x.type }])),
      Object.fromEntries(nep.params.map((x) => [x.name, { type: x.type }]))
    );
    for (const [a, b] of pr.pairs) {
      changes.push({ kind: 'breaking', type: 'param_renamed', endpoint: key, detail: `Query parameter "${a}" is now "${b}" on ${newKey}.`, migration: `Rename "${a}" to "${b}" at call sites.`, from: a, to: b });
    }
    for (const r of pr.removedOnly) {
      changes.push({ kind: 'breaking', type: 'param_removed', endpoint: key, detail: `Parameter "${r}" was removed from ${key}.`, migration: 'Remove the parameter or map it to new behavior manually.', from: r, to: null });
    }
    // same-name params: required flip and type change
    for (const [name, op_] of Object.entries(oldP)) {
      const np_ = newP[name];
      if (!np_) continue;
      if (!op_.required && np_.required) {
        changes.push({ kind: 'breaking', type: 'param_required_changed', endpoint: key, detail: `Parameter "${name}" on ${newKey} is now required.`, migration: `Pass "${name}" at every call site of this endpoint.`, from: name, to: null });
      }
      if (op_.type && np_.type && op_.type !== np_.type) {
        changes.push({ kind: 'breaking', type: 'param_type_changed', endpoint: key, detail: `Parameter "${name}" type changed ${op_.type} -> ${np_.type} on ${newKey}.`, migration: 'Manual review: update values sent for this parameter to the new type.', from: op_.type, to: np_.type, param: name });
      }
    }
    // enum values on params retained by name
    for (const [name, op_] of Object.entries(oldP)) {
      const np_ = newP[name];
      if (np_ && op_.enum && np_.enum) {
        const lost = op_.enum.filter((v) => !np_.enum.includes(v));
        const gained = np_.enum.filter((v) => !op_.enum.includes(v));
        for (const v of lost) {
          changes.push({ kind: 'breaking', type: 'enum_value_removed', endpoint: key, detail: `"${name}" value "${v}" was removed${gained.length ? ` (new value "${gained[0]}" appears to replace it)` : ''}.`, migration: gained.length ? `Replace "${v}" with "${gained[0]}".` : 'Choose a supported value manually.', from: v, to: gained[0] || null, param: name });
        }
      }
    }
    // response fields
    const fr = renameCandidate(ep.responseFields, nep.responseFields);
    for (const [a, b] of fr.pairs) {
      changes.push({ kind: 'breaking', type: 'response_field_renamed', endpoint: key, detail: `Response field "${a}" is now "${b}" on ${newKey}.`, migration: `Rename reads of "${a}" to "${b}".`, from: a, to: b });
    }
    for (const r of fr.removedOnly) {
      changes.push({ kind: 'breaking', type: 'response_field_removed', endpoint: key, detail: `Response field "${r}" was removed from ${key}.`, migration: 'Stop reading this field or source it elsewhere.', from: r, to: null });
    }
    for (const a of fr.addedOnly) {
      changes.push({ kind: 'additive', type: 'response_field_added', endpoint: newKey, detail: `New response field "${a}" on ${newKey}.`, migration: 'Optional: adopt when useful.', from: null, to: a });
    }
    // response fields retained by name: type changes
    for (const [name, of_] of Object.entries(ep.responseFields)) {
      const nf_ = nep.responseFields[name];
      if (nf_ && of_.type && nf_.type && of_.type !== nf_.type) {
        changes.push({ kind: 'breaking', type: 'response_field_type_changed', endpoint: key, detail: `Response field "${name}" type changed ${of_.type} -> ${nf_.type} on ${newKey}.`, migration: 'Manual review: update code that reads this field to handle the new type.', from: of_.type, to: nf_.type, field: name });
      }
    }
    // request fields
    const qr = renameCandidate(ep.requestFields, nep.requestFields);
    for (const [a, b] of qr.pairs) {
      changes.push({ kind: 'breaking', type: 'request_field_renamed', endpoint: key, detail: `Request field "${a}" is now "${b}" on ${newKey}.`, migration: `Rename writes of "${a}" to "${b}".`, from: a, to: b });
    }
    for (const r of qr.removedOnly) {
      changes.push({ kind: 'breaking', type: 'request_field_removed', endpoint: key, detail: `Request field "${r}" was removed from ${key}.`, migration: 'Manual review: stop sending this field; check whether the API now rejects or ignores it.', from: r, to: null });
    }
    for (const a of qr.addedOnly) {
      const req = nep.requestFields[a]?.required;
      changes.push(req
        ? { kind: 'breaking', type: 'request_field_added_required', endpoint: key, detail: `New required request field "${a}" on ${newKey}.`, migration: 'Manual review: every call to this endpoint must now send a valid value for this field.', from: null, to: a }
        : { kind: 'additive', type: 'request_field_added', endpoint: newKey, detail: `New optional request field "${a}" on ${newKey}.`, migration: 'Optional: adopt when useful.', from: null, to: a });
    }
    // request fields retained by name: type changes
    for (const [name, of_] of Object.entries(ep.requestFields)) {
      const nf_ = nep.requestFields[name];
      if (nf_ && of_.type && nf_.type && of_.type !== nf_.type) {
        changes.push({ kind: 'breaking', type: 'request_field_type_changed', endpoint: key, detail: `Request field "${name}" type changed ${of_.type} -> ${nf_.type} on ${newKey}.`, migration: 'Manual review: update code that writes this field to send the new type.', from: of_.type, to: nf_.type, field: name });
      }
    }
    // response enum changes
    for (const [name, of] of Object.entries(ep.responseFields)) {
      const nf = nep.responseFields[name];
      if (nf && of.enum && nf.enum) {
        const lost = of.enum.filter((v) => !nf.enum.includes(v));
        const gained = nf.enum.filter((v) => !of.enum.includes(v));
        for (const v of lost) {
          changes.push({ kind: 'breaking', type: 'enum_value_removed', endpoint: key, detail: `Response field "${name}" value "${v}" was removed${gained.length ? ` (new value "${gained[0]}" appears to replace it)` : ''}.`, migration: gained.length ? `Map "${v}" to "${gained[0]}".` : 'Map manually to a supported value.', from: v, to: gained[0] || null, field: name });
        }
      }
    }
  }
  // doc-level security schemes removed
  const oldSchemes = Object.keys(oldSpec._securitySchemes || {});
  const newSchemes = new Set(Object.keys(newSpec._securitySchemes || {}));
  for (const s of oldSchemes) {
    if (!newSchemes.has(s)) {
      changes.push({ kind: 'breaking', type: 'security_scheme_removed', endpoint: '(document)', detail: `Security scheme "${s}" was removed.`, migration: 'Manual review: clients authenticating with this scheme must move to a supported one.', from: s, to: null });
    }
  }
  // endpoints only in new spec
  for (const [key, ep] of newMap) {
    if (!matched.has(key)) {
      const wasMatchedAsPair = [...oldMap.values()].some((o) => `${o.method} ${o.normalized}` === `${ep.method} ${ep.normalized}`);
      if (!wasMatchedAsPair) {
        changes.push({ kind: 'additive', type: 'endpoint_added', endpoint: key, detail: `New endpoint ${key} is available.`, migration: 'Optional: adopt when useful.', from: null, to: key });
      }
    }
  }
  // judgment-required changes are flagged for review; everything else is auto-proposable
  const REVIEW_TYPES = new Set(['endpoint_removed', 'response_code_removed', 'security_changed', 'security_scheme_removed', 'response_field_type_changed', 'request_field_type_changed', 'param_type_changed', 'request_field_removed', 'request_field_added_required']);
  return changes.map((c) => ({ review: REVIEW_TYPES.has(c.type), ...c }));
}

// ---- consumer impact scan ----

export function scanConsumer(files, changes) {
  // files: [{name, content}]. Find lines affected by each breaking change.
  const usages = [];
  const breaking = changes.filter((c) => c.kind === 'breaking');
  for (const f of files) {
    const lines = f.content.split('\n');
    lines.forEach((text, i) => {
      for (const c of breaking) {
        let hit = false;
        if (c.type === 'endpoint_removed' || c.type === 'base_path_changed') {
          const p = (c.endpoint.split(' ')[1] || '').replace(/\{[^}]+\}/g, '');
          if (p && text.includes(p)) hit = true;
        }
        if (c.type === 'param_renamed' || c.type === 'param_removed') {
          if (new RegExp(`['"\\s{]${c.from}['"\\s:]`).test(text)) hit = true;
        }
        if (c.type === 'response_field_renamed' || c.type === 'response_field_removed' || c.type === 'request_field_renamed' || c.type === 'request_field_removed' || c.type === 'response_field_type_changed' || c.type === 'request_field_type_changed') {
          const leaf = leafName(c.from || c.field);
          if (leaf && new RegExp(`[.\\s{'"]${leaf}[\\s,}'":]`).test(text)) hit = true;
        }
        if (c.type === 'enum_value_removed') {
          if (new RegExp(`['"\`]${c.from}['"\`]`).test(text)) hit = true;
        }
        if (hit) usages.push({ file: f.name, line: i + 1, text: text.trimEnd(), change: c });
      }
    });
  }
  return usages;
}

// ---- fix generation ----

export function buildFixes(files, changes) {
  const breaking = changes.filter((c) => c.kind === 'breaking');
  const removedPaths = breaking.filter((c) => c.type === 'endpoint_removed').map((c) => c.endpoint.split(' ')[1]);
  const fixes = [];
  for (const f of files) {
    const lines = f.content.split('\n');
    const edits = [];
    lines.forEach((text, i) => {
      // Never auto-edit a line that calls a removed endpoint; manual review owns it.
      if (removedPaths.some((p) => p && text.includes(p))) return;
      let after = text;
      const applied = [];
      for (const c of breaking) {
        if (c.type === 'base_path_changed' && c.from && c.to) {
          // only rewrite full matched endpoint paths, never a bare version prefix:
          // a removed sibling endpoint (e.g. /v1/charges) must stay untouched + flagged.
          if (after.includes(c.from)) {
            after = after.split(c.from).join(c.to);
            applied.push(`path ${c.from} -> ${c.to}`);
          }
        } else if ((c.type === 'param_renamed' || c.type === 'response_field_renamed' || c.type === 'request_field_renamed') && c.from && c.to) {
          const fromLeaf = leafName(c.from), toLeaf = leafName(c.to);
          const re = new RegExp(`\\b${fromLeaf}\\b`, 'g');
          if (re.test(after)) { after = after.replace(re, toLeaf); applied.push(`rename ${fromLeaf} -> ${toLeaf}`); }
        } else if (c.type === 'enum_value_removed' && c.from && c.to) {
          const re = new RegExp(`(['"\`])${c.from}\\1`, 'g');
          if (re.test(after)) { after = after.replace(re, `$1${c.to}$1`); applied.push(`enum ${c.from} -> ${c.to}`); }
        }
      }
      if (applied.length) edits.push({ line: i + 1, before: text, after, applied });
    });
    // manual-review flags: endpoint_removed references
    const manual = [];
    lines.forEach((text, i) => {
      for (const c of breaking) {
        if (c.type === 'endpoint_removed') {
          const p = (c.endpoint.split(' ')[1] || '');
          if (p && text.includes(p)) manual.push({ line: i + 1, text: text.trim(), reason: c.detail });
        }
      }
    });
    if (edits.length || manual.length) fixes.push({ file: f.name, edits, manual });
  }
  return fixes;
}

export function buildPR({ oldVersion, newVersion, apiTitle, changes, fixes }) {
  const breaking = changes.filter((c) => c.kind === 'breaking');
  const additive = changes.filter((c) => c.kind === 'additive');
  const editCount = fixes.reduce((n, f) => n + f.edits.length, 0);
  const manualCount = fixes.reduce((n, f) => n + f.manual.length, 0);
  const reviewCount = changes.filter((c) => c.review).length;
  const L = [];
  L.push(`## Migrate ${apiTitle} ${oldVersion} -> ${newVersion}`);
  L.push('');
  L.push(`Generated by Patchline (deterministic rules, no AI inference). ${breaking.length} breaking and ${additive.length} additive changes detected (${reviewCount} change(s) need human judgment); ${editCount} call-site edit(s) proposed, ${manualCount} code spot(s) flagged for manual review.`);
  L.push('');
  L.push('### Breaking changes');
  for (const c of breaking) L.push(`- **${c.type}** (${c.endpoint}): ${c.detail} _Fix:_ ${c.migration}`);
  if (additive.length) {
    L.push('');
    L.push('### Additive (no action required)');
    for (const c of additive) L.push(`- **${c.type}** (${c.endpoint}): ${c.detail}`);
  }
  L.push('');
  L.push('### Proposed edits');
  for (const f of fixes) {
    L.push(`#### ${f.file}`);
    L.push('```diff');
    for (const e of f.edits) {
      L.push(`@@ line ${e.line} (${e.applied.join('; ')})`);
      L.push(`- ${e.before.trim()}`);
      L.push(`+ ${e.after.trim()}`);
    }
    L.push('```');
    for (const mn of f.manual) L.push(`- :warning: Manual review at line ${mn.line}: \`${mn.text}\` - ${mn.reason}`);
  }
  L.push('');
  L.push('### Verification checklist');
  L.push('- [ ] CI passes with the new API version');
  L.push('- [ ] Contract tests cover renamed fields and enum mappings');
  L.push('- [ ] Manual-review spots resolved or ticketed');
  return L.join('\n');
}

export function summarize(changes) {
  const breaking = changes.filter((c) => c.kind === 'breaking').length;
  const additive = changes.filter((c) => c.kind === 'additive').length;
  const warnings = changes.filter((c) => c.kind === 'warning').length;
  const review = changes.filter((c) => c.review).length;
  return { breaking, additive, warnings, review, total: changes.length };
}
