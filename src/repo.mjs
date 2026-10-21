// Repo access shared by CLI and server: walk a local tree or shallow-clone a public git URL.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

export const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.java', '.php', '.kt', '.cs']);
export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '__pycache__', '.venv', 'venv', 'coverage']);
const MAX_FILE = 512 * 1024;

export function walkRepo(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkRepo(p, base, out);
    else if (CODE_EXTS.has(extname(name)) && st.size < MAX_FILE) {
      out.push({ name: relative(base, p), path: p, content: readFileSync(p, 'utf8') });
    }
  }
  return out;
}

export function clonePublicRepo(url) {
  if (!/^https?:\/\//.test(url)) throw new Error('repo URL must be http(s)');
  const dir = mkdtempSync(join(tmpdir(), 'patchline-clone-'));
  // bounded clone: https only, no credential prompts, no submodules, redirects
  // limited to the initial request (git's own redirect chain is outside our URL
  // validation), no local protocol escapes, scrubbed env
  execFileSync('git', [
    '-c', 'http.followRedirects=initial',
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
    '-c', 'core.askpass=',
    'clone', '--depth', '1', '--single-branch', '--no-recurse-submodules', '--no-tags', url, dir,
  ], {
    stdio: 'pipe',
    timeout: 120000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' },
  });
  return dir;
}
