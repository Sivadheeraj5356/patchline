// GitHub Actions watch runner ($0 hosting path): runs the SAME engines as the
// server, headless, inside a scheduled workflow. State lives in ./data
// (checked out from the patchline-data branch by the workflow; the workflow
// commits changes back after the run). No listen socket, no UI, no secrets
// beyond the built-in GITHUB_TOKEN.
//
//   node scripts/actions-watch.mjs [--data ./data] [--force]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fetchText, urlHash } from '../src/net.mjs';
import { parseSpecText, fromOpenAPI, isRealOpenAPI } from '../src/openapi.mjs';
import { diffSpecs, scanConsumer, buildFixes, buildPR, summarize } from '../src/engines.mjs';
import { fetchRepoArchive } from '../src/archive.mjs';

const DATA = process.env.PATCHLINE_DATA || (process.argv.includes('--data') ? process.argv[process.argv.indexOf('--data') + 1] : './data');
const FORCE = process.argv.includes('--force');
for (const d of [DATA, join(DATA, 'snapshots')]) mkdirSync(d, { recursive: true });
const loadJson = (n, fb) => { try { return JSON.parse(readFileSync(join(DATA, n), 'utf8')); } catch { return fb; } };
const saveJson = (n, v) => writeFileSync(join(DATA, n), JSON.stringify(v, null, 2));

const watches = loadJson('watches.json', []);
const events = loadJson('events.json', []);
const normalize = (text, name) => { const d = parseSpecText(text, { sourceName: name }); return isRealOpenAPI(d) ? fromOpenAPI(d) : d; };

let checked = 0, changed = 0, errors = 0;
for (const w of watches) {
  // Hand-seeded watches (committed to patchline-data) may omit the interval;
  // fall back to the same 60-minute polite default the server enforces.
  if (!Number.isFinite(w.intervalMinutes) || w.intervalMinutes <= 0) w.intervalMinutes = 60;
  if (!FORCE && w.nextCheckAt && Date.parse(w.nextCheckAt) > Date.now()) continue;
  w.lastCheckAt = new Date().toISOString();
  try {
    const got = await fetchText(w.url, { metaDir: join(DATA, 'snapshots') });
    if (got.notModified) { w.lastResult = 'not-modified'; checked++; continue; }
    const h = urlHash(w.url);
    const prevPath = join(DATA, 'snapshots', `${h}.txt`);
    const hadPrev = existsSync(prevPath);
    const prevText = hadPrev ? readFileSync(prevPath, 'utf8') : null;
    if (hadPrev && createHash('sha256').update(prevText).digest('hex') === createHash('sha256').update(got.text).digest('hex')) {
      w.lastResult = 'unchanged'; checked++;
    } else if (!hadPrev) {
      w.lastResult = 'baseline-saved'; checked++;
    } else {
      const oldSpec = normalize(prevText, `${w.name} (previous snapshot)`);
      const newSpec = normalize(got.text, w.url);
      const changes = diffSpecs(oldSpec, newSpec);
      const event = {
        id: randomUUID(), watchId: w.id, watchName: w.name, at: w.lastCheckAt,
        oldVersion: oldSpec.info?.version || null, newVersion: newSpec.info?.version || null,
        summary: summarize(changes), changes,
      };
      if (w.repoUrl) {
        try {
          const files = await fetchRepoArchive(w.repoUrl);
          const usages = scanConsumer(files, changes);
          const fixes = buildFixes(files, changes);
          event.impact = {
            repoUrl: w.repoUrl, scannedFiles: files.length, affectedLines: usages.length,
            proposedEdits: fixes.reduce((n, f) => n + f.edits.length, 0),
            inferredSuggestions: fixes.reduce((n, f) => n + (f.suggested || []).length, 0),
            manualSpots: fixes.reduce((n, f) => n + f.manual.length, 0),
            usages: usages.slice(0, 100).map((u) => ({ file: u.file, line: u.line, change: u.change.type })),
            pr: buildPR({ oldVersion: event.oldVersion, newVersion: event.newVersion, apiTitle: oldSpec.info?.title || w.name, changes, fixes }).slice(0, 50000),
          };
        } catch (e) { event.impact = { repoUrl: w.repoUrl, error: e.message }; }
      }
      events.unshift(event);
      w.lastResult = `changed: ${event.summary.breaking} breaking, ${event.summary.additive} additive, ${event.summary.warnings} warnings`;
      changed++;
    }
    writeFileSync(prevPath, got.text);
    saveJson(`snapshots/${h}.meta.json`, { etag: got.etag, lastModified: got.lastModified });
    w.nextCheckAt = new Date(Date.now() + w.intervalMinutes * 60000).toISOString();
  } catch (e) {
    w.lastResult = `error: ${e.message}`; errors++;
  }
}
saveJson('watches.json', watches);
saveJson('events.json', events.slice(0, 200));
console.log(`patchline watch run: ${checked} checked, ${changed} changed, ${errors} errors (${watches.length} watches)`);
