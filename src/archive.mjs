// Server-safe consumer-repo access: pinned archive fetch + bounded in-memory
// tar extraction. Replaces git clone on server paths: DNS is resolved and
// pinned per redirect hop by net.mjs (no second resolution window), and the
// extractor never touches the filesystem, never follows links, never
// executes anything. Read-only by construction.
import { gunzipSync } from 'node:zlib';
import { fetchBinary } from './net.mjs';

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;   // compressed
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;     // decompressed sum (bomb guard)
const MAX_FILE_BYTES = 512 * 1024;            // matches repo.mjs MAX_FILE
const MAX_FILES = 2000;                       // matches server scan cap
const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.java', '.php', '.kt', '.cs']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '__pycache__', '.venv', 'venv', 'coverage']);

// Map a repo URL to an archive URL. Production support: github.com repos via
// codeload, plus direct .tar.gz/.tgz URLs on any public host. Other git hosts
// get a clear error instead of a silent fallback to git clone.
export function archiveUrlFor(repoUrl) {
  const u = new URL(repoUrl);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('repoUrl must be http(s)');
  if (u.hostname === 'github.com') {
    const m = u.pathname.replace(/\/$/, '').match(/^\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!m) throw new Error(`cannot map GitHub URL to an archive: ${repoUrl}`);
    return `https://codeload.github.com/${m[1]}/${m[2]}/tar.gz/HEAD`;
  }
  // any other public host: the URL itself must serve a tar.gz archive
  // (validated by gunzip + the bounded extractor after the pinned fetch)
  return repoUrl;
}

function safeEntryName(raw) {
  // reject traversal, absolute paths, drive letters, backslash tricks
  const name = raw.replace(/\\/g, '/');
  if (!name || name.startsWith('/') || /^[A-Za-z]:\//.test(name)) return null;
  const parts = name.split('/');
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

// Minimal ustar reader. Files only; directories are implied; every other
// entry type (symlink, hardlink, device, fifo) is skipped - links are never
// followed because nothing is written to disk.
export function extractTar(buf, { maxFiles = MAX_FILES, maxTotal = MAX_TOTAL_BYTES, maxFile = MAX_FILE_BYTES } = {}) {
  const files = [];
  let total = 0;
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive zero block
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const sizeOct = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const type = String.fromCharCode(header[156]);
    const size = parseInt(sizeOct || '0', 8);
    if (Number.isNaN(size) || size < 0) throw new Error('corrupt tar header (size)');
    const name = safeEntryName(prefix ? `${prefix}/${rawName}` : rawName);
    off += 512;
    if (type === '0' || type === '\0') {
      if (!name) throw new Error(`unsafe entry name in archive: ${rawName}`);
      if (size > maxFile) throw new Error(`archive entry too large: ${name} (${size} bytes)`);
      total += size;
      if (total > maxTotal) throw new Error('archive decompresses beyond the total size cap');
      files.push({ name, content: buf.subarray(off, off + size).toString('utf8') });
      if (files.length > maxFiles) throw new Error(`archive exceeds ${maxFiles} files`);
    }
    // skip non-file entries entirely (links, devices) - never followed
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

// Fetch + unpack + filter to scannable source files. Strips the single
// top-level archive directory GitHub adds (owner-repo-ref/).
export async function fetchRepoArchive(repoUrl, { token = null } = {}) {
  const archiveUrl = archiveUrlFor(repoUrl);
  // credentials attach ONLY to GitHub's own archive host - never leak a
  // token to an arbitrary repoUrl host
  const headers = token && new URL(archiveUrl).hostname === 'codeload.github.com'
    ? { authorization: `Bearer ${token}` } : {};
  const gz = await fetchBinary(archiveUrl, { maxBytes: MAX_ARCHIVE_BYTES, headers });
  if (gz.length > MAX_ARCHIVE_BYTES) throw new Error(`archive too large (${gz.length} bytes compressed)`);
  let tar;
  try { tar = gunzipSync(gz, { maxOutputLength: MAX_TOTAL_BYTES + 1 }); }
  catch { throw new Error('archive is not valid gzip (or exceeds the decompression cap)'); }
  if (tar.length > MAX_TOTAL_BYTES) throw new Error('archive decompresses beyond the total size cap');
  const entries = extractTar(tar);
  const stripped = entries.map((e) => ({ name: e.name.replace(/^[^/]+\//, ''), content: e.content }));
  const files = stripped.filter((e) => {
    if (e.name.includes('/') === false && !CODE_EXTS.has(ext(e.name))) return false;
    if (e.name.split('/').some((seg) => SKIP_DIRS.has(seg))) return false;
    return CODE_EXTS.has(ext(e.name));
  }).slice(0, MAX_FILES);
  return files;
}

const ext = (n) => { const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i); };
