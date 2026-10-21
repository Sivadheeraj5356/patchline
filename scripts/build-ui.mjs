// Splice the current engine source into the UI template so the browser app
// always runs the same tested code (file://-friendly: no module imports).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const engines = readFileSync(join(root, 'src/engines.mjs'), 'utf8')
  .replace(/^export /gm, '');
const template = readFileSync(join(root, 'ui/template.html'), 'utf8');
if (!template.includes('/*__PATCHLINE_ENGINES__*/')) throw new Error('marker missing in template');
writeFileSync(join(root, 'ui/index.html'), template.replace('/*__PATCHLINE_ENGINES__*/', engines.trimEnd()));
console.log('ui/index.html built from ui/template.html + src/engines.mjs');
