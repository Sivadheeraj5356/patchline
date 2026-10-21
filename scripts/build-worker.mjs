// Inline the real UI into the worker bundle (workers/dist/patchline-worker.mjs)
// so the deployed worker serves byte-identical UI without a separate asset step.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'workers/patchline-worker.mjs'), 'utf8');
const ui = readFileSync(join(root, 'ui/index.html'), 'utf8');
if (!src.includes("'__PATCHLINE_UI_PLACEHOLDER__'")) throw new Error('placeholder missing');
mkdirSync(join(root, 'workers/dist'), { recursive: true });
writeFileSync(join(root, 'workers/dist/patchline-worker.mjs'), src.replace("'__PATCHLINE_UI_PLACEHOLDER__'", JSON.stringify(ui)));
console.log('workers/dist/patchline-worker.mjs built (' + ui.length + ' bytes of UI inlined)');
