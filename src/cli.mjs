#!/usr/bin/env node
// Patchline CLI: analyze an API spec change against a real codebase.
//
//   node src/cli.mjs analyze --old <file|url> --new <file|url> [--repo <dir|git-url>] [--files a.js,b.py]
//                            [--json out.json] [--md out.md] [--write]
//
// Defaults to a dry run: report only, no files modified. --write applies the
// auto-proposable edits in place (review-flagged spots are never auto-edited).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseSpecText, fromOpenAPI, isRealOpenAPI } from './openapi.mjs';
import { diffSpecs, scanConsumer, buildFixes, buildPR, summarize } from './engines.mjs';
import { walkRepo, clonePublicRepo } from './repo.mjs';

function args() {
  const a = process.argv.slice(2);
  const out = { _: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) out[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
    else out._.push(a[i]);
  }
  return out;
}

async function loadSpec(ref) {
  let text;
  if (/^https?:\/\//.test(ref)) {
    const res = await fetch(ref, { headers: { 'user-agent': 'patchline/0.2 (+https://github.com/patchline)' } });
    if (!res.ok) throw new Error(`fetch ${ref}: HTTP ${res.status}`);
    text = await res.text();
  } else {
    text = readFileSync(ref, 'utf8');
  }
  const doc = parseSpecText(text, { sourceName: ref });
  return isRealOpenAPI(doc) ? fromOpenAPI(doc) : doc;
}

function applyFixes(files, fixes) {
  const byName = new Map(fixes.map((f) => [f.file, f]));
  let written = 0;
  for (const f of files) {
    const fx = byName.get(f.name);
    if (!fx || !fx.edits.length) continue;
    const lines = f.content.split('\n');
    for (const e of fx.edits) lines[e.line - 1] = e.after;
    writeFileSync(f.path, lines.join('\n'));
    written += fx.edits.length;
  }
  return written;
}

function gitIn(dir, ...a) { return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim(); }

const cli = args();
if (cli._[0] !== 'analyze' || !cli.old || !cli.new) {
  console.error('usage: node src/cli.mjs analyze --old <file|url> --new <file|url> [--repo <dir|git-url>] [--json out] [--md out] [--write] [--branch name] [--apply-inferred]');
  process.exit(2);
}

const oldSpec = await loadSpec(cli.old);
const newSpec = await loadSpec(cli.new);
const changes = diffSpecs(oldSpec, newSpec);

let repoDir = null, cleanup = null;
if (cli.repo && /^https?:\/\//.test(cli.repo)) {
  repoDir = await clonePublicRepo(cli.repo);
  cleanup = repoDir;
} else if (cli.repo) {
  repoDir = cli.repo;
}

let files = [];
if (repoDir) files = walkRepo(repoDir);
if (cli.files) {
  files = cli.files.split(',').map((p) => ({ name: p, path: p, content: readFileSync(p, 'utf8') }));
}

const usages = files.length ? scanConsumer(files, changes) : [];
const fixes = files.length ? buildFixes(files, changes, { applyInferred: !!cli['apply-inferred'] }) : [];
const pr = buildPR({
  oldVersion: oldSpec.info?.version || 'old',
  newVersion: newSpec.info?.version || 'new',
  apiTitle: oldSpec.info?.title || 'API',
  changes, fixes,
});

const report = { summary: summarize(changes), changes, usages, fixes, pr };
if (cli.json) { mkdirSync(dirname2(cli.json), { recursive: true }); writeFileSync(cli.json, JSON.stringify(report, null, 2)); }
if (cli.md) writeFileSync(cli.md, pr);
if (cli.write && files.length) {
  const n = applyFixes(files, fixes);
  console.error(`applied ${n} edit(s) in place`);
  // Optional: prepare a reviewable branch in the repo (local only - never pushed here).
  if (cli.branch && repoDir) {
    const branch = String(cli.branch);
    gitIn(repoDir, 'checkout', '-b', branch);
    writeFileSync(join(repoDir, 'PATCHLINE_MIGRATION.md'), pr);
    gitIn(repoDir, 'add', '-A');
    gitIn(repoDir, '-c', 'user.email=patchline@local', '-c', 'user.name=Patchline', 'commit', '-m', `patchline: migrate to ${newSpec.info?.title || 'API'} ${newSpec.info?.version || 'new version'}

${pr.split('\n')[0]}

See PATCHLINE_MIGRATION.md for the full analysis.`);
    console.error(`branch "${branch}" ready in ${repoDir} with the fixes + PATCHLINE_MIGRATION.md (NOT pushed - review and push manually)`);
  }
}

function dirname2(p) { return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'; }

const s = report.summary;
console.log(`${s.breaking} breaking, ${s.additive} additive, ${s.warnings} warnings; ${s.review} flagged for review; ${usages.length} affected line(s) in ${files.length} scanned file(s)`);
if (!cli.json && !cli.md) console.log('\n' + pr);
if (cleanup) console.error(`(cloned repo left at ${cleanup})`);
