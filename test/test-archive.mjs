// Pinned archive fetch + bounded extractor tests.
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { archiveUrlFor, extractTar, fetchRepoArchive } from '../src/archive.mjs';
import { buildTar, buildTarGz } from './tar-fixture.mjs';

let pass = 0, fail = 0;
const failures = [];
const t = (name, cond) => { if (cond) pass++; else { fail++; failures.push(name); } };
const expectThrow = async (name, fn, re) => {
  try { await fn(); t(name + ' (should throw)', false); }
  catch (e) { t(name, re ? re.test(e.message) : true); }
};

// --- archiveUrlFor ---
t('github repo URL maps to codeload tarball', archiveUrlFor('https://github.com/o/r') === 'https://codeload.github.com/o/r/tar.gz/HEAD');
t('github URL with .git suffix maps', archiveUrlFor('https://github.com/o/r.git') === 'https://codeload.github.com/o/r/tar.gz/HEAD');
t('direct .tar.gz URL passes through', archiveUrlFor('https://example.com/a.tar.gz') === 'https://example.com/a.tar.gz');
expectThrow('file:// repoUrl rejected', () => Promise.resolve(archiveUrlFor('file:///tmp/x')), /http/);
t('non-github host URL passes through to bounded fetch', archiveUrlFor('https://gitlab.com/o/r') === 'https://gitlab.com/o/r');

// --- extractTar bounds ---
{
  const tar = buildTar([
    { name: 'repo-abc123/src/app.js', content: 'const x = 1;\n' },
    { name: 'repo-abc123/README.md', content: '# hi\n' },
  ]);
  const files = extractTar(tar);
  t('extracts regular files', files.length === 2 && files[0].content === 'const x = 1;\n');
}
await expectThrow('path traversal entry rejected', () => Promise.resolve(extractTar(buildTar([{ name: 'repo/../../etc/passwd', content: 'x' }]))), /unsafe/);
await expectThrow('absolute path entry rejected', () => Promise.resolve(extractTar(buildTar([{ name: '/etc/passwd', content: 'x' }]))), /unsafe/);
{
  const tar = buildTar([
    { name: 'repo/link.js', type: '2', content: '' }, // symlink, skipped
    { name: 'repo/real.js', content: 'ok();\n' },
  ]);
  const files = extractTar(tar);
  t('symlink entries skipped, never followed', files.length === 1 && files[0].name === 'repo/real.js');
}
await expectThrow('oversize single file rejected', () => Promise.resolve(extractTar(buildTar([{ name: 'r/big.js', content: 'x'.repeat(600 * 1024) }]))), /too large/);
{
  const many = Array.from({ length: 2005 }, (_, i) => ({ name: `r/f${i}.js`, content: 'x' }));
  await expectThrow('file count cap enforced', () => Promise.resolve(extractTar(buildTar(many))), /exceeds 2000 files/);
}
{
  const big = Array.from({ length: 200 }, (_, i) => ({ name: `r/f${i}.js`, content: 'x'.repeat(400 * 1024) }));
  await expectThrow('total decompressed size cap enforced', () => Promise.resolve(extractTar(buildTar(big))), /total size cap/);
}

// --- fetchRepoArchive end-to-end under test mode (localhost fixture) ---
process.env.PATCHLINE_ALLOW_PRIVATE = '1';
const consumerGz = buildTarGz([
  { name: 'consumer-abc/src/invoices.js', content: "const t = inv.amount_cents / 100;\nawait api.get('/v2/payouts');\n" },
  { name: 'consumer-abc/node_modules/dep/index.js', content: 'skip();\n' },
  { name: 'consumer-abc/README.md', content: 'not code\n' },
]);
const srv = createServer((req, res) => {
  if (req.url === '/repo.tar.gz') { res.writeHead(200, { 'content-type': 'application/gzip' }); res.end(consumerGz); }
  else if (req.url === '/redirect') { res.writeHead(302, { location: '/repo.tar.gz' }); res.end(); }
  else { res.writeHead(404); res.end(); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
{
  const files = await fetchRepoArchive(`http://127.0.0.1:${port}/repo.tar.gz`);
  t('archive fetched and code files extracted', files.length === 1 && files[0].name === 'src/invoices.js');
  t('node_modules and non-code filtered', !files.some((f) => f.name.includes('node_modules') || f.name.endsWith('.md')));
  const viaRedirect = await fetchRepoArchive(`http://127.0.0.1:${port}/redirect`);
  t('archive fetch follows pinned redirect hop', viaRedirect.length === 1 && viaRedirect[0].content.includes('amount_cents'));
}
{
  const bomb = gzipSync(Buffer.alloc(80 * 1024 * 1024, 65)); // tiny .gz, huge output
  const srv2 = createServer((req, res) => { res.writeHead(200); res.end(bomb); });
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
  await expectThrow('decompression bomb stopped at cap', () => fetchRepoArchive(`http://127.0.0.1:${srv2.address().port}/b.tgz`), /gzip|cap/i);
  srv2.close();
}
srv.close();
delete process.env.PATCHLINE_ALLOW_PRIVATE;

console.log(`${pass} passed, ${fail} failed`);
if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
