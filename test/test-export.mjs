// Static snapshot export: bakes data into a self-contained read-only UI page.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let passed = 0, failed = 0;
const ok = (name, cond) => { if (cond) { passed++; } else { failed++; console.error('FAIL: ' + name); } };

const dir = mkdtempSync(join(tmpdir(), 'pl-export-'));
writeFileSync(join(dir, 'watches.json'), JSON.stringify([{ id: 'w1', name: 'demo', url: 'https://api.example.com/openapi.json', intervalMinutes: 60, lastCheckAt: '2026-10-22T00:00:00Z', lastResult: 'changed: 2 breaking' }]));
writeFileSync(join(dir, 'events.json'), JSON.stringify([{ id: 'e1', watchId: 'w1', watchName: 'demo', at: '2026-10-22T00:00:00Z', oldVersion: '1.0', newVersion: '1.1', summary: { breaking: 2, additive: 0, warnings: 0, review: 0, total: 2 }, changes: [] }]));
const outDir = join(dir, 'out');
const log = execFileSync(process.execPath, ['scripts/export-static.mjs', '--data', dir, '--out', outDir], { encoding: 'utf8' });
ok('export reports counts', log.includes('1 watches') && log.includes('1 events'));
ok('dist/index.html written', existsSync(join(outDir, 'index.html')));
const html = readFileSync(join(outDir, 'index.html'), 'utf8');
ok('bakes static snapshot', html.includes('window.__PATCHLINE_STATIC__'));
ok('snapshot contains the watch', html.includes('"name":"demo"') || html.includes('\\"name\\":\\"demo\\"'));
ok('read-only banner present', html.includes('read-only'));
ok('escapes script-breaking chars', !html.includes('</script><script>alert') );
// XSS guard: a watch name with </script> must be neutralized
writeFileSync(join(dir, 'watches.json'), JSON.stringify([{ id: 'w2', name: 'x</script><script>alert(1)</script>', url: 'https://a.example.com/s.json' }]));
execFileSync(process.execPath, ['scripts/export-static.mjs', '--data', dir, '--out', outDir], { encoding: 'utf8' });
const html2 = readFileSync(join(outDir, 'index.html'), 'utf8');
const baked = html2.split('window.__PATCHLINE_STATIC__ = ')[1].split('</script>')[0];
ok('baked payload has no raw </script>', !baked.includes('</script>'));

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
