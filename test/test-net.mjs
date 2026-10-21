// SSRF guard + redirect behavior tests for the shared egress module.
import { createServer } from 'node:http';
import { assertPublicUrl, fetchText, isPrivateIP } from '../src/net.mjs';
import { clonePublicRepo } from '../src/repo.mjs';

let pass = 0, fail = 0;
const failures = [];
const t = (name, cond) => { if (cond) pass++; else { fail++; failures.push(name); } };
const expectThrow = async (name, fn, re) => {
  try { await fn(); t(name + ' (should throw)', false); }
  catch (e) { t(name, re ? re.test(e.message) : true); }
};

// classification
t('127.0.0.1 is private', isPrivateIP('127.0.0.1'));
t('10.x is private', isPrivateIP('10.1.2.3'));
t('172.16-31 is private', isPrivateIP('172.20.0.1') && !isPrivateIP('172.15.0.1') && !isPrivateIP('172.32.0.1'));
t('192.168 is private', isPrivateIP('192.168.1.1'));
t('169.254 link-local is private', isPrivateIP('169.254.1.1'));
t('::1 is private', isPrivateIP('::1'));
t('fc00::/7 is private', isPrivateIP('fd00::1'));
t('v4-mapped v6 loopback is private', isPrivateIP('::ffff:127.0.0.1'));
t('public 8.8.8.8 is not private', !isPrivateIP('8.8.8.8'));

// guard: literal IPs, scheme, DNS-resolved private
delete process.env.PATCHLINE_ALLOW_PRIVATE;
await expectThrow('refuses literal loopback URL', () => assertPublicUrl('http://127.0.0.1:9/spec.json'), /non-public/);
await expectThrow('refuses literal private 10.x URL', () => assertPublicUrl('http://10.0.0.5/'), /non-public/);
await expectThrow('refuses non-http scheme', () => assertPublicUrl('file:///etc/passwd'), /only http/);
await expectThrow('refuses hostname resolving to private (localhost)', () => assertPublicUrl('http://localhost:9/'), /non-public/);

// pinning: under test mode, resolved addresses are returned and the dispatcher pins to them
process.env.PATCHLINE_ALLOW_PRIVATE = '1';
{
  const { pinned, dispatcher, pinnedLookup } = await assertPublicUrl('http://localhost:9/');
  t('returns pinned addresses', Array.isArray(pinned) && pinned.length > 0 && pinned.every((p) => p.address));
  t('dispatcher present for hostname targets', !!dispatcher);
  t('pinned addresses are loopback here', pinned.every((p) => isPrivateIP(p.address)));
  const one = await new Promise((res, rej) => pinnedLookup('localhost', {}, (e, a, f) => (e ? rej(e) : res(a))));
  t('lookup callback returns a validated address', pinned.some((p) => p.address === one));
  const all = await new Promise((res, rej) => pinnedLookup('localhost', { all: true }, (e, arr) => (e ? rej(e) : res(arr))));
  t('lookup all-mode returns exactly the validated set', JSON.stringify(all) === JSON.stringify(pinned));
  await dispatcher.close();
}

// redirect behavior with a local fixture (test mode): hop-by-hop following + hop cap
const target = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
await new Promise((r) => target.listen(0, '127.0.0.1', r));
const targetPort = target.address().port;
let redirectHits = 0;
const redirector = createServer((req, res) => { redirectHits++; res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/final.json` }); res.end(); });
await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
const redirPort = redirector.address().port;
{
  const got = await fetchText(`http://127.0.0.1:${redirPort}/start.json`);
  t('redirect hop followed to final body', got.text === '{"ok":true}');
  t('redirector was hit exactly once', redirectHits === 1);
}
// infinite redirector exceeds the hop cap
const looper = createServer((req, res) => { res.writeHead(302, { location: `/loop-${Math.random()}` }); res.end(); });
await new Promise((r) => looper.listen(0, '127.0.0.1', r));
await expectThrow('redirect loop exceeds hop cap', () => fetchText(`http://127.0.0.1:${looper.address().port}/x`), /too many redirects/);

// without test mode the same localhost fetch is refused (server-parity path)
delete process.env.PATCHLINE_ALLOW_PRIVATE;
await expectThrow('fetch refuses private target without test mode', () => fetchText(`http://127.0.0.1:${targetPort}/final.json`), /non-public/);
// a redirector (first hop) is refused before any request is made when private
await expectThrow('redirect source refused when private', () => fetchText(`http://127.0.0.1:${redirPort}/start.json`), /non-public/);

// clone guard: private/scheme rejection happens before git is spawned
await expectThrow('clone refuses private IP URL', () => clonePublicRepo('http://127.0.0.1/repo.git'), /non-public/);
await expectThrow('clone refuses non-http URL', () => clonePublicRepo('file:///tmp/repo'), /http/);
await expectThrow('clone refuses hostname resolving private', () => clonePublicRepo('http://localhost:9/repo.git'), /non-public/);

target.close(); redirector.close(); looper.close();
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
