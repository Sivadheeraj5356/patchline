// Shared minimal ustar/tar.gz fixture builder for tests.
import { gzipSync } from 'node:zlib';

function tarHeader(name, size, type = '0') {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0);
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0' + '00', 257);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
export function buildTar(entries) {
  const chunks = [];
  for (const e of entries) {
    const body = Buffer.from(e.content || '', 'utf8');
    chunks.push(tarHeader(e.name, e.type === '5' ? 0 : body.length, e.type || '0'));
    if (e.type !== '5') { chunks.push(body); chunks.push(Buffer.alloc((512 - (body.length % 512)) % 512, 0)); }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}
export function buildTarGz(entries) { return gzipSync(buildTar(entries)); }
