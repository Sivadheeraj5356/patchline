// Static snapshot export (component C render step): bakes the current
// watches/events into a single self-contained index.html running the real UI
// in read-only static mode. Produces the exact artifact a hosted viewer
// would serve. No network, no secrets; reads only the local data dir.
//
//   node scripts/export-static.mjs [--data ./data] [--out ./dist]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, fb) => process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : fb;
const DATA = process.env.PATCHLINE_DATA || arg('--data', './data');
const OUT = arg('--out', './dist');
const load = (n, fb) => { try { return JSON.parse(readFileSync(join(DATA, n), 'utf8')); } catch { return fb; } };

const snap = {
  exportedAt: new Date().toISOString(),
  minIntervalMinutes: 60,
  watches: load('watches.json', []).map((w) => ({ id: w.id, name: w.name, url: w.url, repoUrl: w.repoUrl || null, intervalMinutes: w.intervalMinutes, lastCheckAt: w.lastCheckAt, lastResult: w.lastResult, nextCheckAt: w.nextCheckAt })),
  events: load('events.json', []),
};

let html = readFileSync(join(root, 'ui/index.html'), 'utf8');
const inject = `<script>window.__PATCHLINE_STATIC__ = ${JSON.stringify(snap).replace(/</g, '\\u003c')};</script>`;
if (!html.includes('</head>')) throw new Error('no </head> in ui/index.html');
html = html.replace('</head>', inject + '\n<meta name="robots" content="noindex,nofollow">\n<!-- PRIVATE: contains the owner\'s watch/event state. Serve ONLY behind the Patchline access gate, never as a public static asset. -->\n</head>');
// Read-only banner under the header
html = html.replace('<div class="wrap">', `<div class="wrap">\n<div style="margin:12px 0;padding:10px 14px;border:1px solid #30363d;border-radius:8px;background:#161b22;color:#9da7b3;font-size:13px;">Static snapshot exported ${snap.exportedAt} - read-only. Adding watches, running checks and ad-hoc analysis need the local server (<code>npm start</code>).</div>`);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'index.html'), html);
console.log(`exported ${snap.watches.length} watches, ${snap.events.length} events -> ${join(OUT, 'index.html')} (${html.length} bytes)`);
