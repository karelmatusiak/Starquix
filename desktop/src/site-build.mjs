// Publish build (docs/plans/2026-10-16-cloudflare-one-click-design.md): the project folder on disk → a cloned copy in a
// temp dir → Astro's build() of the copy in a forked child → the built files in memory. Astro 4's build writes into its
// root (src/env.d.ts, .astro/): building the copy keeps the project — and its running `astro dev` — untouched (ledger 41).
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { exitOf, forkRunner, killTree, pipeOutput } from './supervisor.mjs';
import { t } from './i18n.mjs';

const BUILDER = new URL('./build-runner.mjs', import.meta.url);
const NOT_COPIED = new Set(['node_modules', '.git', '.sq', 'dist']); // linked (node_modules), history, ours, a stale build
export const BUILD_MS = 5 * 60_000; // ledger 22
export const MAX_FILE = 25 * 1024 * 1024; // Cloudflare's per-asset limit (ledger 24)
const fail = (code, message, extra) => Object.assign(new Error(t(message)), { code }, extra);
/** Astro's diagnostic in one line — where + what, project-relative; never a stack, colors or the plugin tag (ledger 21). */
function diagnostic(text, dirs) {
  let t = stripVTControlCharacters(String(text));
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) { // /private/var/… before /var/…
    t = t.split(`${d}${path.sep}`).join('').split(`${d.split(path.sep).join('/')}/`).join(''); // Windows: Vite prints C:/…/
  }
  const [first = '', next = '', reason = ''] = t.split('\n').map(l => l.trim()).filter(Boolean);
  // Rolldown (Vite 8) puts the reason a line below the location: "[plugin astro:build] file:2:10" / "CompilerError: …".
  const where = next.replace(/^\[[^\]]+\]\s*/, '');
  const line = !first.endsWith(':') || !next ? first : /:\d+:\d+$/.test(where) && reason && !reason.startsWith('at ') ? `${first} ${where}: ${reason}` : `${first} ${next}`;
  return line.replace(/^\[[\w:-]+\]\s*/, '').slice(0, 300) || 'The site did not build';
}

// Served Content-Type per extension (wrangler: text/* gets utf-8; unknown = served without one).
const TYPES = { html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', txt: 'text/plain',
  md: 'text/markdown', csv: 'text/csv', xml: 'application/xml', rss: 'application/rss+xml', json: 'application/json', map: 'application/json',
  webmanifest: 'application/manifest+json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf',
  wasm: 'application/wasm', zip: 'application/zip' };
const typeOf = file => {
  const t = TYPES[path.extname(file).slice(1).toLowerCase()];
  return !t ? 'application/null' : t.startsWith('text/') ? `${t}; charset=utf-8` : t;
};

/** [{ path: '/a/b.html', bytes, type }] for every file under dist. ponytail: whole site in memory; stream from disk if sites get huge. */
export async function listSite(dist) {
  const files = [];
  for (const entry of await fs.readdir(dist, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    const rel = `/${path.relative(dist, full).split(path.sep).join('/')}`;
    if ((await fs.stat(full)).size > MAX_FILE) throw fail('file-too-big', `${rel} is over 25 MB`, { file: rel });
    files.push({ path: rel, bytes: await fs.readFile(full), type: typeOf(full) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** `use(site, tmp)` on a copy of the project in a temp dir, removed after whatever happened. */
async function inCopy(projectDir, tmpRoot, use) {
  const tmp = await fs.mkdtemp(path.join(tmpRoot, 'sq-publish-'));
  const site = path.join(tmp, 'site');
  try {
    // APFS/btrfs clone where the filesystem can (instant, no space), a plain copy elsewhere.
    await fs.cp(projectDir, site, { recursive: true, mode: constants.COPYFILE_FICLONE,
      filter: src => !NOT_COPIED.has(path.relative(projectDir, src).split(path.sep)[0]) });
    // The project's packages (the shared runtime link, or its merged folder); the prerender chunks in dist import them too.
    await fs.symlink(path.join(projectDir, 'node_modules'), path.join(site, 'node_modules'), 'junction');
    return await use(site, tmp);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}
/** `runnerFile` forked in the copy: its one message, or a failure of ours (`timeout`, `died`); the child is gone after. */
async function runChild(runnerFile, site, tmp, timeoutMs, env = {}) {
  const child = forkRunner(runnerFile, site, { SQ_BUILD_OUT: tmp, ...env });
  pipeOutput(child); // drained: a chatty child must never block on a full pipe
  const exited = exitOf(child);
  const result = await new Promise(resolve => {
    const timer = setTimeout(() => resolve({ type: 'failed', code: 'timeout' }), timeoutMs);
    const settle = m => { clearTimeout(timer); resolve(m); };
    child.on('message', m => { if (m?.type) settle(m); });
    child.once('error', e => settle({ type: 'failed', error: String(e) }));
    // 'disconnect' comes after every message the child sent: no result by then = it died.
    child.once('disconnect', () => settle({ type: 'failed', code: 'died' }));
  });
  await killTree(child, exited);
  return result;
}

/** `compat: false` builds the files as a host would (astro-upgrade.mjs proves a rewrite needs no shim). */
export async function buildSite(projectDir, { runnerFile = BUILDER, timeoutMs = BUILD_MS, tmpRoot = os.tmpdir(), compat = true } = {}) {
  return inCopy(projectDir, tmpRoot, async (site, tmp) => {
    const result = await runChild(runnerFile, site, tmp, timeoutMs, compat ? {} : { SQ_NO_COMPAT: '1' });
    if (result.type === 'failed') throw result.code === 'not-static' ? fail('not-static', 'This site needs a server')
      : fail('build-failed', diagnostic(result.code === 'timeout' ? 'The build took longer than 5 minutes'
        : result.code === 'died' ? 'The build stopped unexpectedly' : result.error, [site, await fs.realpath(site)]));
    const files = await listSite(path.join(site, 'dist'));
    if (!files.some(f => f.path.endsWith('.html'))) throw fail('build-failed', 'The site built no pages'); // ledger 26
    return files;
  });
}

const CHECKER = new URL('./check-runner.mjs', import.meta.url);
export const CHECK_MS = 2 * 60_000; // a check takes ~10 s
const MAX_ERRORS = 100;
/** Pre-publish (docs/plans/2026-10-20-prepublish-type-check-design.md): what the site's own `astro check` reports, run on
 *  a copy. `{ ran: false }` when its build runs none or it couldn't run here — never a throw: a failed check never blocks. */
export async function checkSite(projectDir, { runnerFile = CHECKER, timeoutMs = CHECK_MS, tmpRoot = os.tmpdir() } = {}) {
  const none = { ran: false, errors: [], total: 0 };
  try {
    const build = JSON.parse(await fs.readFile(path.join(projectDir, 'package.json'), 'utf8'))?.scripts?.build;
    // ponytail: the build script itself; a check reached through `npm run <x>` is not followed (ledger 10).
    if (typeof build !== 'string' || !/\bastro\s+check\b/.test(build)) return none;
    const result = await inCopy(projectDir, tmpRoot, (site, tmp) => runChild(runnerFile, site, tmp, timeoutMs));
    if (result.type !== 'checked') { console.warn('[sq-check]', result.code ?? result.type, result.error ?? ''); return none; }
    return { ran: true, errors: result.errors.slice(0, MAX_ERRORS), total: result.errors.length };
  } catch (e) {
    if (e?.code !== 'ENOENT') console.warn('[sq-check]', e?.message ?? e);
    return none;
  }
}
