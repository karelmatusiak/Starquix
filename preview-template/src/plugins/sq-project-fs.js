/**
 * sq-project-fs — THE files-truth project handlers (local mode, task-132/133;
 * files-truth unification 2026-08-28 Phase 1).
 *
 * Pure functions over `(root, fs, path)`, plain JS by construction: this module
 * runs BOTH on the host Vite server (app/src/vite-plugin/server/* delegate to
 * it, TS types in sq-project-fs.d.ts) AND inside any `astro dev` the sq plugin
 * is armed in with `bridgeJsPath` (the instance gets only the plugin dir's
 * `.js` files, so nothing TS can be imported). No child_process, no osascript: the folder
 * PICK and instance lifecycle stay with whoever spawned the process.
 *
 * Every function here was moved VERBATIM (types stripped) from
 * app/src/vite-plugin/server/{localProject,componentFiles}.ts,
 * app/src/vite-plugin/{component,layout}-discovery.ts and
 * app/src/utils/{localMode,slugify}.ts — the existing tests of those modules
 * are the parity oracle (they import the TS re-exports).
 *
 * Plan: docs/archive/plans/2026-08-28-files-truth-wc-unification-plan.md Task 1.2.
 */
import { existsSync, readdirSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { readFile, unlink, mkdir, rename, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { escapeAstroBraces } from './sq-prop-fallback.js';
import { withSourceFileLock, withSourceFileLocks } from './sq-file-write-lock.js';
import { writeFileAtomic } from './sq-atomic-write.js';
import { libraryTags } from './sq-library-tags.js';

/** THE way a writer here replaces a user's file (audit 2026-10-18 follow-up).
 *  `compute(current)` runs under the file's source lock, so a source-command
 *  CAS or an HMR write never lands between its read and this write; the text it
 *  returns (undefined = leave the file) goes through a sibling temp + rename, so
 *  a crash never leaves torn bytes. `current` is null for a missing file. */
function rewriteFile(abs, compute) {
  return withSourceFileLock(abs, () => {
    const next = compute(existsSync(abs) ? readFileSync(abs, 'utf8') : null);
    if (next !== undefined) writeFileAtomic(abs, next);
  });
}

// ── shared client/server rules (mirrors app/src/utils/{slugify,localMode}.ts) ──

/** Lowercase, fold Czech (and other Latin) diacritics, collapse the rest to hyphens. */
export function slugify(text) {
  const folded = text.normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/gi, 'l');
  const result = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return result || 'untitled';
}

/** Deterministic doc-page id for a discovered route (same as utils/localMode). */
export function localPageId(route) {
  return route === '/' ? 'index' : route.slice(1).replace(/[^a-zA-Z0-9[\]_-]+/g, '-');
}

/** task-148: THE page-delete rule (same as utils/localMode.resolveLocalPageDeletion). */
export function resolveLocalPageDeletion(pages, pageId) {
  if (pages.length <= 1) {
    return { ok: false, error: 'This is the last page — a site needs at least one.' };
  }
  const matches = pages.filter(p => localPageId(p.route) === pageId);
  if (matches.length === 0) {
    return { ok: false, error: 'No page file matches this page — nothing to delete.' };
  }
  if (matches.length > 1) {
    return { ok: false, error: `More than one file matches this page (${matches.map(m => m.file).join(', ')}) — delete it from your editor.` };
  }
  const page = matches[0];
  if (page.dynamic) {
    return { ok: false, error: `${page.file} is a dynamic route — it renders every instance, so deleting it here is refused.` };
  }
  if (!page.file.endsWith('.astro')) {
    return { ok: false, error: `${page.file} is not a .astro page — delete it from your editor.` };
  }
  return { ok: true, route: page.route, file: page.file };
}

/** task-143: where component default-image bytes live (importable). */
export const SQ_DEFAULTS_DIR = 'src/assets/sq-defaults';

// ── pages ────────────────────────────────────────────────────────────────────

/** THE src/pages file → route mapping (project-relative posix path in). */
export function routeForPageFile(relFile) {
  const rel = relFile.replace(/\\/g, '/').replace(/^src\/pages\//, '');
  const ext = path.extname(rel);
  let route = '/' + rel.slice(0, rel.length - ext.length);
  // task-240: `[...page].astro` is Astro's pagination idiom — its first page
  // IS the parent route (/blog for blog/[...page].astro): one static page.
  route = route.replace(/\/\[\.\.\.page\]$/, '') || '/';
  return route.endsWith('/index') ? route.slice(0, -'/index'.length) || '/' : route;
}

/** task-240: rename a page file inside src/pages (pagination route move: a
 *  listing becomes `<route>/[...page].astro` and back). Never overwrites. */
export function moveLocalPage(dir, from, to, prepare = false, overlay) {
  if (typeof from !== 'string' || typeof to !== 'string') throw new Error('missing from/to');
  const absFrom = resolvePageFilePath(dir, from);
  const absTo = resolvePageFilePath(dir, to);
  const view = pagePlanningView(dir, prepare && overlay);
  if (!view.isFile(absFrom)) throw new Error('no such page file');
  if (view.exists(absTo)) throw new Error(`${to} already exists`);
  if (prepare) return { from, to, files: [
    { file: from, beforeSource: view.read(from), afterSource: null },
    { file: to, beforeSource: null, afterSource: view.read(from) },
  ] };
  mkdirSync(path.dirname(absTo), { recursive: true });
  renameSync(absFrom, absTo);
  const rel = (abs) => path.relative(path.resolve(dir), abs).replace(/\\/g, '/');
  return { ok: true, from: rel(absFrom), to: rel(absTo) };
}

/** Walk src/pages/** and map files to routes. .md/.mdx listed but not editable (P0; P3 lifts). */
export function discoverLocalPages(dir) {
  const pagesRoot = path.join(dir, 'src', 'pages');
  if (!existsSync(pagesRoot)) return [];
  const pages = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const ext = path.extname(entry.name);
      if (!['.astro', '.md', '.mdx'].includes(ext)) continue;
      const rel = path.relative(pagesRoot, full);
      const route = routeForPageFile(path.join('src', 'pages', rel));
      const page = {
        route,
        file: path.join('src', 'pages', rel).replace(/\\/g, '/'),
        editable: ext === '.astro',
      };
      if (route.includes('[')) page.dynamic = true;
      pages.push(page);
    }
  };
  walk(pagesRoot);
  // stable order: index first, then by route
  return pages.sort((a, b) => (a.route === '/' ? -1 : b.route === '/' ? 1 : a.route.localeCompare(b.route)));
}

/** Reverse import graph over src/**‍/*.{astro,md,mdx}: imported file → its
 *  importers (both project-relative).
 *  ponytail: relative import specifiers only (no aliases). */
export function importGraph(dir) {
  const srcRoot = path.join(dir, 'src');
  const sourceFiles = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.(astro|md|mdx)$/.test(entry.name)) sourceFiles.push(path.relative(dir, full).replace(/\\/g, '/'));
    }
  };
  if (existsSync(srcRoot)) walk(srcRoot);
  const importersOf = new Map();
  for (const f of sourceFiles) {
    let text = '';
    try { text = readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/from\s+['"]([^'"]+\.astro)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const resolved = path.normalize(path.join(path.dirname(f), spec)).replace(/\\/g, '/');
      const list = importersOf.get(resolved);
      if (list) list.push(f);
      else importersOf.set(resolved, [f]);
    }
  }
  return importersOf;
}

/** task-143: pages that (transitively) render a component — importGraph walked
 *  from the component up to src/pages/** (page usage) or src/content/**
 *  (content usage). ponytail: content slug = lowercased filename (astro's default). */
export function findComponentUsages(dir, relFile) {
  if (!existsSync(path.join(dir, 'src')) || !relFile.startsWith('src/')) return { usages: [], contentUsages: [] };
  const importersOf = importGraph(dir);
  const pages = discoverLocalPages(dir);
  const pageByFile = new Map(pages.map(p => [p.file, p]));
  const seen = new Set([relFile]);
  const queue = [relFile];
  const found = new Set();
  const contentUsages = [];
  while (queue.length) {
    const cur = queue.shift();
    const page = pageByFile.get(cur);
    if (page) { found.add(page); continue; }
    const contentMatch = cur.match(/^src\/content\/([^/]+)\/(.+)\.(md|mdx)$/);
    if (contentMatch) {
      contentUsages.push({ file: cur, collection: contentMatch[1], slug: contentMatch[2].toLowerCase() });
      continue; // content entries are leaves — nothing imports them
    }
    for (const importer of importersOf.get(cur) ?? []) {
      if (!seen.has(importer)) { seen.add(importer); queue.push(importer); }
    }
  }
  return { usages: pages.filter(p => found.has(p)), contentUsages };
}

// ── component default image (task-143) ───────────────────────────────────────

const SQ_DEFAULT_VAR = (prop) => `__sqDefault_${prop}`;
const SQ_DEFAULT_IMPORT_RE = (prop) =>
  new RegExp(`\\nimport ${SQ_DEFAULT_VAR(prop)} from '([^']*)';`);

/** The prop name feeding the nth image tag with a bare-identifier src. */
export function findImagePropAt(source, imgIndex) {
  const tags = [...source.matchAll(/<(?:Image|img|Picture|picture)\b[^<]{0,600}?src=\{\s*([A-Za-z_$][\w$]*)\s*\}/g)];
  const hit = tags[imgIndex];
  if (!hit) throw new Error(`no image tag with a plain prop src at index ${imgIndex}`);
  return hit[1];
}

/** Set or clear a component's default image. asset = project-relative path of
 *  an image under src/ (importable); null clears. Returns the previous
 *  default's asset path for undo. */
export async function writeComponentDefaultImage(dir, componentRel, imgIndex, asset) {
  if (!componentRel.startsWith('src/')) throw new Error(`unknown component ${componentRel}`);
  let set;
  await rewriteFile(path.join(dir, componentRel), (source) => {
    if (source === null) throw new Error(`unknown component ${componentRel}`);
    set = setDefaultImage(source, componentRel, imgIndex, asset);
    return set.source;
  });
  return { ok: true, prop: set.prop, asset: asset ?? '', previous: set.previous };
}

function setDefaultImage(source, componentRel, imgIndex, asset) {
  const prop = findImagePropAt(source, imgIndex);
  const destructureRe = /((?:const|let)\s*\{)([^}]*)(\}\s*=\s*Astro\.props)/;
  const dm = source.match(destructureRe);
  if (!dm) throw new Error('component has no Astro.props destructure — cannot set a default');
  if (!new RegExp(`\\b${prop}\\b`).test(dm[2])) throw new Error(`prop '${prop}' not in the Astro.props destructure`);
  const varName = SQ_DEFAULT_VAR(prop);

  // Previous default (ours): recover its asset path from the import specifier.
  const prevImport = source.match(SQ_DEFAULT_IMPORT_RE(prop));
  const previous = prevImport
    ? path.normalize(path.join(path.dirname(componentRel), prevImport[1])).replace(/\\/g, '/')
    : null;

  source = source.replace(SQ_DEFAULT_IMPORT_RE(prop), '');
  source = source.replace(destructureRe, (_a, pre, inner, post) => {
    let next = inner.replace(new RegExp(`(\\b${prop}\\b)\\s*=\\s*[^,}]+`), '$1');
    if (asset) next = next.replace(new RegExp(`\\b${prop}\\b`), `${prop} = ${varName}`);
    return pre + next + post;
  });
  if (asset) {
    const importSpec = path.relative(path.dirname(componentRel), asset).replace(/\\/g, '/');
    const spec = importSpec.startsWith('.') ? importSpec : './' + importSpec;
    if (!source.startsWith('---')) throw new Error('component has no frontmatter fence');
    source = source.replace('---', `---\nimport ${varName} from '${spec}';`);
  }
  return { source, prop, previous };
}

/** Default-image bytes land under src/assets/sq-defaults/ (importable). */
export function writeDefaultImageAsset(dir, name, data) {
  const candidate = writeUniqueFile(path.join(dir, SQ_DEFAULTS_DIR), name, 'image', data);
  return `${SQ_DEFAULTS_DIR}/${candidate}`;
}

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

/** Stream a request body into a Buffer with the size cap enforced (413 +
 *  destroy on overflow). ONE copy of the cap/abort semantics. */
export function readBinaryBody(req, res, json, onDone) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_ASSET_BYTES) { json(res, 413, { error: 'asset too large' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (size > MAX_ASSET_BYTES) return;
    onDone(Buffer.concat(chunks));
  });
}

/** Sanitize a filename and write bytes into destDir, -1/-2… suffix on
 *  collision. Returns the final basename. */
function writeUniqueFile(destDir, name, fallbackStem, data) {
  const base = path.basename(name).replace(/[^\w.-]+/g, '_');
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length) || fallbackStem;
  mkdirSync(destDir, { recursive: true });
  let candidate = stem + ext;
  for (let i = 1; existsSync(path.join(destDir, candidate)); i++) candidate = `${stem}-${i}${ext}`;
  writeFileSync(path.join(destDir, candidate), data);
  return candidate;
}

/** task-145: local-mode Add Page writes a REAL file. Never overwrites. */
export function createLocalPage(dir, name, prepare = false, overlay) {
  const view = pagePlanningView(dir, prepare && overlay);
  const pagesRoot = path.join(dir, 'src', 'pages');
  if (!existsSync(pagesRoot)) throw new Error('src/pages not found — not an Astro project root');
  const base = slugify(name);
  if (!base) throw new Error(`Cannot derive a route from "${name}"`);
  const taken = (s) =>
    view.exists(path.join(pagesRoot, `${s}.astro`)) ||
    ['.md', '.mdx'].some(ext => view.exists(path.join(pagesRoot, `${s}${ext}`))) ||
    view.exists(path.join(pagesRoot, s)); // directory route (slug/index.*)
  let slug = base;
  let n = 2;
  while (taken(slug)) {
    if (n > 99) throw new Error(`A page for /${base} already exists`);
    slug = `${base}-${n++}`;
  }
  const file = path.join(pagesRoot, `${slug}.astro`);
  const title = slug === base ? (name.trim() || slug) : `${name.trim() || base} ${n - 1}`;
  const content = `---
---
<html lang="cs">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeAstroBraces(title)}</title>
  </head>
  <body>
    <main></main>
  </body>
</html>
`;
  if (prepare) return { route: `/${slug}`, file: `src/pages/${slug}.astro`, editable: true,
    files: [{ file: `src/pages/${slug}.astro`, beforeSource: null, afterSource: content }] };
  writeFileSync(file, content);
  return { route: `/${slug}`, file: `src/pages/${slug}.astro`, editable: true };
}

/** task-148: local-mode page DELETE removes the REAL src/pages file. pageId
 *  in, never a path — resolved from the same discovery walk. */
export function deleteLocalPage(dir, pageId, prepare = false, overlay) {
  const view = pagePlanningView(dir, prepare && overlay);
  const pages = view.pages();
  const resolved = resolveLocalPageDeletion(pages, pageId);
  if (!resolved.ok) throw new Error(resolved.error);
  const abs = resolvePageFilePath(dir, resolved.file);
  if (!view.isFile(abs)) throw new Error('No page file on disk — nothing to delete.');
  const content = view.read(resolved.file);
  if (prepare) return { route: resolved.route, file: resolved.file, content,
    files: [{ file: resolved.file, beforeSource: content, afterSource: null }] };
  rmSync(abs);
  return { route: resolved.route, file: resolved.file, editable: true, content };
}

/** Resolve a project-relative page path strictly inside <dir>/src/pages. */
export function resolvePageFilePath(dir, relFile) {
  const pagesRoot = path.resolve(dir, 'src', 'pages');
  const abs = path.resolve(dir, relFile);
  if (!abs.startsWith(pagesRoot + path.sep)) throw new Error('page file is outside src/pages');
  return abs;
}

/** task-148: the ⌘Z half — write a deleted page's bytes back verbatim. */
export function restoreLocalPage(dir, route, content, file, prepare = false, overlay) {
  if (!route.startsWith('/')) throw new Error('route must start with /');
  if (typeof content !== 'string') throw new Error('missing page content');
  const derived = `src/pages${route === '/' ? '/index' : route}.astro`;
  const rel = file ?? derived;
  const abs = resolvePageFilePath(dir, rel);
  if (!rel.endsWith('.astro')) throw new Error('only .astro pages can be restored');
  if (routeForPageFile(path.relative(dir, abs).replace(/\\/g, '/')) !== route) {
    throw new Error(`${rel} does not serve route ${route}`);
  }
  if (pagePlanningView(dir, prepare && overlay).exists(abs)) throw new Error(`${rel} already exists — refusing to overwrite it`);
  if (prepare) return { route, file: rel, files: [{ file: rel, beforeSource: null, afterSource: content }] };
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return { route, file: path.relative(dir, abs).replace(/\\/g, '/') };
}

/** Gap 23: local-mode page RENAME moves the REAL src/pages file. */
export function renameLocalPage(dir, pageId, name, prepare = false, overlay) {
  const view = pagePlanningView(dir, prepare && overlay);
  const pages = view.pages();
  const matches = pages.filter(p => localPageId(p.route) === pageId);
  if (matches.length === 0) throw new Error('No page file matches this page — nothing to rename.');
  if (matches.length > 1) {
    throw new Error(`More than one file matches this page (${matches.map(m => m.file).join(', ')}) — rename it in your editor.`);
  }
  const page = matches[0];
  if (page.dynamic) throw new Error(`${page.file} is a dynamic route — rename it in your editor.`);
  if (!page.file.endsWith('.astro')) throw new Error(`${page.file} is not a .astro page — rename it in your editor.`);
  if (page.route === '/') throw new Error('The home page is index.astro — renaming it would change your site root.');
  if (path.posix.basename(page.file) === 'index.astro') {
    throw new Error(`${page.file} takes its route from its folder name — rename the folder in your editor.`);
  }
  const slug = slugify(name);
  if (!slug) throw new Error(`Cannot derive a route from "${name}"`);
  const newRel = path.posix.join(path.posix.dirname(page.file), `${slug}.astro`);
  if (newRel === page.file) {
    return { oldRoute: page.route, oldFile: page.file, ...page, ...(prepare ? { files: [] } : {}) }; // same slug
  }
  const oldAbs = resolvePageFilePath(dir, page.file);
  const newAbs = resolvePageFilePath(dir, newRel);
  if (!view.isFile(oldAbs)) throw new Error('No page file on disk — nothing to rename.');
  const newStem = newAbs.slice(0, -'.astro'.length);
  if (view.exists(newAbs) || view.exists(`${newStem}.md`) || view.exists(`${newStem}.mdx`) || view.exists(newStem)) {
    throw new Error(`A page for ${routeForPageFile(newRel)} already exists`);
  }
  if (prepare) return { oldRoute: page.route, oldFile: page.file, route: routeForPageFile(newRel), file: newRel,
    files: [{ file: page.file, beforeSource: view.read(page.file), afterSource: null },
      { file: newRel, beforeSource: null, afterSource: view.read(page.file) }] };
  renameSync(oldAbs, newAbs);
  return { oldRoute: page.route, oldFile: page.file, route: routeForPageFile(newRel), file: newRel, editable: true };
}

/** Read-only accepted overlay for lifecycle planning. Never changes the disk;
 * actual writes still require the journal command's locked baseline CAS. */
function pagePlanningView(dir, overlay) {
  const sources = new Map();
  for (const [file, content] of Object.entries(overlay || {})) {
    if (!file.startsWith('src/pages/') || file.split('/').some(part => !part || part === '.' || part === '..')
      || /[\\\0]/.test(file) || (content !== null && typeof content !== 'string')) throw new Error('Invalid projected page source');
    sources.set(file, content);
  }
  return {
    isFile(abs) {
      const file = path.relative(path.resolve(dir), abs).replace(/\\/g, '/');
      return sources.has(file) ? sources.get(file) !== null : existsSync(abs) && statSync(abs).isFile();
    },
    exists(abs) {
      const file = path.relative(path.resolve(dir), abs).replace(/\\/g, '/');
      if (sources.has(file)) return sources.get(file) !== null;
      if ([...sources].some(([name, content]) => content !== null && name.startsWith(file + '/'))) return true;
      return existsSync(abs);
    },
    read(file) { return sources.has(file) ? sources.get(file) : readFileSync(path.join(dir, file), 'utf8'); },
    pages() {
      const pages = new Map(discoverLocalPages(dir).map(page => [page.file, page]));
      for (const [file, content] of sources) {
        if (content === null) pages.delete(file);
        else {
          const route = routeForPageFile(file);
          pages.set(file, { file, route, editable: file.endsWith('.astro'), ...(route.includes('[') ? { dynamic: true } : {}) });
        }
      }
      return [...pages.values()];
    },
  };
}

// ── assets ───────────────────────────────────────────────────────────────────

/** Create a bundled public dependency at its original URL. Validate lexical
 * paths and reject symlinks (including dangling links) present at each checked
 * segment. Exclusive wx creation protects the leaf from replacement.
 * Assumes no other filesystem actor renames or replaces ancestor directories
 * during this operation. These pathname checks are not a sandbox or an atomic
 * ancestor-confinement guarantee; an ancestor swap can redirect the write and
 * leave its journal pathname inaccurate. */
export function createBundledAsset(dir, file, data) {
  if (typeof file !== 'string' || !/^public\/assets\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(file)
    || file.split('/').some(part => part === '.' || part === '..')) {
    throw new ComponentFileError('invalid bundled asset path', 400);
  }
  const root = realpathSync(dir);
  const parts = file.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const leaf = index === parts.length - 1;
    if (stat) {
      if (stat.isSymbolicLink() || (leaf ? !stat.isFile() : !stat.isDirectory())) {
        throw new ComponentFileError('bundled asset path is not a regular file tree', 400);
      }
      if (leaf) return { file, created: false };
    } else if (!leaf) {
      mkdirSync(current);
    }
  }
  try { writeFileSync(current, data, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = lstatSync(current);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ComponentFileError('bundled asset target is not a regular file', 400);
    return { file, created: false };
  }
  return { file, created: true };
}

export function writeLocalAsset(dir, name, data) {
  const candidate = writeUniqueFile(path.join(dir, 'public', 'uploads'), name, 'asset', data);
  return { src: `/uploads/${candidate}` };
}

/** Frontmatter-image upload: bytes land INSIDE the collection
 *  (`src/content/<coll>/images/uploads/`), src relative to the POST FILE. */
export function writeLocalContentAsset(dir, postFile, name, data) {
  const postAbs = resolveLocalContentPath(dir, postFile);
  const contentRoot = path.resolve(dir, 'src', 'content');
  const collection = path.relative(contentRoot, postAbs).split(path.sep)[0];
  const destDir = path.join(contentRoot, collection, 'images', 'uploads');
  const candidate = writeUniqueFile(destDir, name, 'asset', data);
  const rel = path.relative(path.dirname(postAbs), path.join(destDir, candidate)).split(path.sep).join('/'); // an MDX src: forward slashes
  return { src: rel.startsWith('.') ? rel : `./${rel}` };
}

// ── gap-61: files-truth font persistence ─────────────────────────────────────

const FONT_FILE_RE = /\.(woff2?|ttf|otf)$/i;

/** Bytes → public/fonts/. Idempotent re-pick of identical bytes. */
export function writeLocalFontFile(dir, name, data) {
  if (!FONT_FILE_RE.test(name)) throw new Error(`not a font file: ${name}`);
  const destDir = path.join(dir, 'public', 'fonts');
  const base = path.basename(name).replace(/[^\w.-]+/g, '_');
  const existing = path.join(destDir, base);
  if (existsSync(existing) && readFileSync(existing).equals(data)) {
    return { src: `/fonts/${base}` };
  }
  const candidate = writeUniqueFile(destDir, name, 'font', data);
  return { src: `/fonts/${candidate}` };
}

/** 32-bit FNV-1a over the exact family string. */
function fontFamilyHash(family) {
  let h = 0x811c9dc5;
  for (let k = 0; k < family.length; k++) {
    h ^= family.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function fontMarker(family) {
  const sanitized = family.replace(/[^\w -]+/g, '_');
  const id = sanitized === family ? sanitized : `${sanitized}.${fontFamilyHash(family)}`;
  return { start: `/* sq-font:${id} start */`, end: `/* sq-font:${id} end */` };
}

const SQ_FONTS_HEADER =
  '/* Managed by Starquix. Safe to edit outside the marker blocks — each\n' +
  ' * sq-font block is replaced wholesale when that family is re-picked. */\n';

/** Marker-merge one family's CSS into public/sq-fonts.css. */
export async function mergeLocalFontCss(dir, family, css) {
  const full = path.join(dir, 'public', 'sq-fonts.css');
  const { start, end } = fontMarker(family);
  const block = `${start}\n${css}\n${end}\n`;
  mkdirSync(path.dirname(full), { recursive: true });
  await rewriteFile(full, (cur) => {
    if (cur === null) return `${SQ_FONTS_HEADER}\n${block}`;
    const i = cur.lastIndexOf(start);
    const j = i === -1 ? -1 : cur.indexOf(end, i + start.length);
    return j !== -1
      ? cur.slice(0, i) + block + cur.slice(j + end.length).replace(/^\n/, '')
      : `${cur.replace(/\n*$/, '\n\n')}${block}`;
  });
  return { file: 'public/sq-fonts.css' };
}

const SQ_FONTS_LINK = '<link rel="stylesheet" href="/sq-fonts.css" data-sq-fonts>';

function astroBodyStart(txt) {
  if (!txt.startsWith('---')) return 0;
  const close = txt.indexOf('\n---', 3);
  return close === -1 ? -1 : close + 4;
}

function fontsLinkAnchor(txt) {
  const bodyStart = astroBodyStart(txt);
  if (bodyStart === -1) return -1;
  const body = txt.slice(bodyStart);
  const opener = body.match(/<head[\s>]/i);
  if (!opener || opener.index === undefined) return -1;
  const close = body.slice(opener.index).match(/<\/head\s*>/i);
  if (!close || close.index === undefined) return -1;
  return bodyStart + opener.index + close.index;
}

/** One marked <link> before </head> in every head-owning src/**.astro. Idempotent. */
export async function ensureLocalFontsLink(dir) {
  let linked = false;
  const updatedFiles = [];
  const files = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name.endsWith('.astro')) files.push(full);
    }
  };
  walk(path.join(dir, 'src'));
  for (const full of files) {
    await rewriteFile(full, (txt) => {
      if (txt === null) return undefined;
      if (txt.includes('sq-fonts.css')) { linked = true; return undefined; }
      const at = fontsLinkAnchor(txt);
      if (at === -1) return undefined;
      linked = true;
      updatedFiles.push(path.relative(dir, full).replace(/\\/g, '/'));
      return `${txt.slice(0, at)}${SQ_FONTS_LINK}\n${txt.slice(at)}`;
    });
  }
  return { linked, updatedFiles };
}

// ── content ──────────────────────────────────────────────────────────────────

/** task-138: {repo-relative path -> raw} for every .md/.mdx under src/content. */
export function listLocalContentFiles(dir) {
  const root = path.join(dir, 'src', 'content');
  if (!existsSync(root)) return {};
  const files = {};
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.mdx?$/.test(entry.name)) continue;
      files[path.relative(dir, full).replace(/\\/g, '/')] = readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return files;
}

const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico)$/i;
const VIDEO_RE = /\.(mp4|webm|mov)$/i;

/** task-135: the folder's real media — public/** (served) and src/assets/** (import-based). */
export function listLocalAssets(dir) {
  const items = [];
  const walk = (root, toUrl) => {
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) { walk(full, toUrl); continue; }
      const rel = path.relative(dir, full).replace(/\\/g, '/');
      const kind = IMAGE_RE.test(entry.name) ? 'image' : VIDEO_RE.test(entry.name) ? 'video' : 'file';
      items.push({ file: rel, url: toUrl(rel), kind, size: statSync(full).size });
    }
  };
  walk(path.join(dir, 'public'), rel => '/' + rel.replace(/^public\//, ''));
  walk(path.join(dir, 'src', 'assets'), () => null);
  return items;
}

// ── task-142: data-aware image swap ──────────────────────────────────────────

/** Bound assets must live inside {dir}/src (never node_modules). */
export function resolveBoundAsset(dir, assetPath) {
  const full = path.resolve(dir, assetPath);
  const srcRoot = path.resolve(dir, 'src');
  if (!full.startsWith(srcRoot + path.sep) || full.includes(`${path.sep}node_modules${path.sep}`)) {
    throw new Error('bound asset outside src/');
  }
  return full;
}

/** Repoint every src/content reference resolving to oldAbs onto newName. */
export async function repointContentRefs(dir, oldAbs, newName) {
  const oldBase = path.basename(oldAbs);
  const updated = [];
  const contentRoot = path.join(dir, 'src', 'content');
  if (!existsSync(contentRoot)) return updated;
  const escaped = oldBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const token = new RegExp(`[^\\s"'\`()\\[\\]]*${escaped}(?=[\\s"'\`()\\[\\]]|$)`, 'g');
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.(mdx?|markdown|ya?ml|json)$/i.test(entry.name)) files.push(full);
    }
  };
  walk(contentRoot);
  for (const full of files) {
    await rewriteFile(full, (raw) => {
      if (raw === null || !raw.includes(oldBase)) return undefined;
      let changed = false;
      const next = raw.replace(token, (m) => {
        if (path.resolve(path.dirname(full), m) !== oldAbs) return m;
        changed = true;
        return m.slice(0, m.length - oldBase.length) + newName;
      });
      if (!changed) return undefined;
      updated.push(path.relative(dir, full).replace(/\\/g, '/'));
      return next;
    });
  }
  return updated;
}

export async function rebindLocalAsset(dir, oldAssetPath, name, data) {
  const oldAbs = resolveBoundAsset(dir, oldAssetPath);
  if (!existsSync(oldAbs)) throw new Error('bound asset not found');
  const targetDir = path.dirname(oldAbs);
  const candidate = writeUniqueFile(targetDir, name, 'asset', data);
  const newAbs = path.join(targetDir, candidate);
  const updatedFiles = await repointContentRefs(dir, oldAbs, candidate);
  if (updatedFiles.length === 0) {
    rmSync(newAbs); // nothing referenced the old asset — don't leave an orphan
    throw new Error(`no content reference found for ${path.basename(oldAbs)}`);
  }
  return { newAsset: path.relative(dir, newAbs).replace(/\\/g, '/'), updatedFiles };
}

/** Undo/redo: repoint refs onto a file already on disk in the SAME directory. */
export async function rebindToExisting(dir, fromAssetPath, toAssetPath) {
  const fromAbs = resolveBoundAsset(dir, fromAssetPath);
  const toAbs = resolveBoundAsset(dir, toAssetPath);
  if (!existsSync(toAbs)) throw new Error('target asset not found');
  if (path.dirname(fromAbs) !== path.dirname(toAbs)) throw new Error('assets must share a directory');
  const updatedFiles = await repointContentRefs(dir, fromAbs, path.basename(toAbs));
  if (updatedFiles.length === 0) throw new Error('no content reference found');
  return { newAsset: path.relative(dir, toAbs).replace(/\\/g, '/'), updatedFiles };
}

/** Resolve a repo-relative asset path strictly inside public/ or src/assets. */
export function resolveLocalAssetFile(dir, rel) {
  const full = path.resolve(dir, rel);
  const roots = [path.resolve(dir, 'public'), path.resolve(dir, 'src', 'assets')];
  if (!roots.some(r => full.startsWith(r + path.sep))) {
    throw new Error('path outside asset roots');
  }
  return full;
}

/** Components the content editor may copy into a user's project (allowlist). */
export const SQ_INSERTABLE_COMPONENTS = ['Media', 'Stack'];

/** task-207 D6/A17: per-component marker saying "this sq/ copy is CURRENT". */
export const SQ_UPGRADE_MARKERS = { Media: 'sq-media-v2', Stack: 'sq-stack-v5' };

/** System components no surface may list (editorial layouts P2): the editor drives them. */
export const SQ_HIDDEN = ['Stack'];
const isHiddenScanPath = (p) => SQ_HIDDEN.some((n) => p === `src/components/sq/${n}.astro`);

/** task-207 D12: a component NAME, never a path. */
export const SQ_COMPONENT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

export function projectHasMdx(dir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return !!(pkg.dependencies?.['@astrojs/mdx'] ?? pkg.devDependencies?.['@astrojs/mdx']);
  } catch {
    return false;
  }
}

/** Resolve a repo-relative file/dir strictly INSIDE src/content. */
export function resolveLocalContentPath(dir, rel) {
  const full = path.resolve(dir, rel);
  const contentRoot = path.resolve(dir, 'src', 'content');
  if (!full.startsWith(contentRoot + path.sep)) {
    throw new Error('path outside src/content');
  }
  if (!existsSync(full) && full.endsWith('.md') && existsSync(`${full}x`)) {
    return `${full}x`;
  }
  return full;
}

/**
 * Generic TEXT file write inside src/ or public/ (files-truth Phase 3.2:
 * `src/styles/sq-variables.css` and friends). Never node_modules or .sq/.
 * Returns the project-relative path written.
 */
export async function writeLocalFile(dir, file, content) {
  if (typeof file !== 'string' || typeof content !== 'string') throw new Error('missing file/content');
  const abs = path.resolve(dir, file);
  const root = path.resolve(dir);
  const inSrc = abs.startsWith(path.join(root, 'src') + path.sep);
  const inPublic = abs.startsWith(path.join(root, 'public') + path.sep);
  // The site's own settings the editor owns a line of (SEO: `site:`, the sitemap integration + its package).
  const rootConfig = path.dirname(abs) === root && /^(astro\.config\.(mjs|mts|ts|js|cjs)|package\.json)$/.test(path.basename(abs));
  // The contact endpoint generated with a Czech site. Nothing else under functions/.
  const contactFn = path.relative(root, abs).replace(/\\/g, '/') === 'functions/api/kontakt.js';
  if (!inSrc && !inPublic && !rootConfig && !contactFn) throw new Error('path outside src/ or public/');
  if (/[\\/](node_modules|\.sq)[\\/]/.test(abs + path.sep)) throw new Error('path refused');
  mkdirSync(path.dirname(abs), { recursive: true });
  await rewriteFile(abs, () => content);
  return { ok: true, file: path.relative(root, abs).replace(/\\/g, '/') };
}

/**
 * ensure-sq-component: copy one of OUR components into the user's project on
 * first insert. `sqComponentsDir` = where our templates live (host:
 * preview-template/src/components; in-plugin: beside this module).
 */
export async function ensureSqComponent(dir, name, sqComponentsDir) {
  if (!SQ_COMPONENT_NAME.test(name || '')) {
    return { status: 400, body: { error: `invalid component name: ${name}` } };
  }
  if (!projectHasMdx(dir)) {
    return { status: 400, body: { error: '@astrojs/mdx is not installed in this project' } };
  }
  const file = `src/components/sq/${name}.astro`;
  const full = path.join(dir, file);
  const source = path.join(sqComponentsDir, `${name}.astro`);
  const ours = SQ_INSERTABLE_COMPONENTS.includes(name);
  if (!existsSync(full)) {
    if (!ours) return { status: 400, body: { error: `not an insertable component: ${name}` } };
    if (!existsSync(source)) return { status: 500, body: { error: `missing template ${name}.astro` } };
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileAtomic(full, readFileSync(source, 'utf8'));
    return { status: 200, body: { file, created: true, extra: ensureSqCompanions(dir, name) } };
  }
  const marker = ours ? SQ_UPGRADE_MARKERS[name] : undefined;
  let upgraded = false;
  if (marker && existsSync(source)) {
    await rewriteFile(full, (current) => {
      if (current === null) throw new Error(`${file} was removed`);
      if (current.includes(marker)) return undefined;
      writeFileAtomic(`${full}.bak`, current);
      upgraded = true;
      return readFileSync(source, 'utf8');
    });
  }
  if (upgraded) return { status: 200, body: { file, created: false, upgraded: true, extra: ensureSqCompanions(dir, name) } };
  const extra = ours ? ensureSqCompanions(dir, name) : [];
  return { status: 200, body: { file, created: false, promoted: !ours, ...(extra.length ? { extra } : {}) } };
}

/** Files one of OUR components imports (Stack → sq-utilities.css). Created
 *  empty when missing, never overwritten; returns the created paths. */
export const SQ_COMPANIONS = { Stack: ['src/components/sq/sq-utilities.css'] };
function ensureSqCompanions(dir, name) {
  const created = [];
  for (const rel of SQ_COMPANIONS[name] ?? []) {
    const full = path.join(dir, rel);
    if (existsSync(full)) continue;
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, '');
    created.push(rel);
  }
  return created;
}

// ── component FILE ops (mirrors server/componentFiles.ts) ────────────────────

export class ComponentFileError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Resolve `componentPath` inside `rootDir`, refusing anything that escapes it. */
export function resolveInRoot(rootDir, componentPath) {
  const root = path.resolve(rootDir);
  const abs = path.resolve(root, componentPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new ComponentFileError('Path outside components directory', 400);
  }
  return abs;
}

/** Create `<rootDir>/<subDir>/<name>.astro`. Returns the path relative to rootDir.
 *  Never overwrites another file of that name (409); the same bytes are a no-op. */
export async function createComponentFile(rootDir, name, astroContent, subDir = '') {
  if (!name || !astroContent) throw new ComponentFileError('Missing name or astroContent', 400);
  const dir = resolveInRoot(rootDir, subDir);
  await mkdir(dir, { recursive: true });
  const abs = resolveInRoot(rootDir, path.join(subDir, `${name}.astro`));
  await rewriteFile(abs, (current) => {
    if (current !== null && current !== astroContent) {
      throw new ComponentFileError(`A file named "${name}.astro" already exists`, 409);
    }
    return current === null ? astroContent : undefined;
  });
  return path.relative(path.resolve(rootDir), abs).split(path.sep).join('/');
}

/** Rename in place. Returns the NEW path relative to rootDir. */
export async function renameComponentFile(rootDir, componentPath, newName) {
  if (!newName) throw new ComponentFileError('Missing newName', 400);
  const abs = resolveInRoot(rootDir, componentPath);
  if (!existsSync(abs)) throw new ComponentFileError('Component file not found', 404);
  const next = resolveInRoot(rootDir, path.join(path.dirname(componentPath), `${newName}.astro`));
  return withSourceFileLocks([abs, next], async () => {
    if (next !== abs && existsSync(next)) {
      throw new ComponentFileError(`A component named "${newName}" already exists`, 409);
    }
    if (next !== abs) await rename(abs, next);
    return path.relative(path.resolve(rootDir), next).split(path.sep).join('/');
  });
}

/** Delete, returning the previous bytes so the caller can offer undo. */
export async function deleteComponentFile(rootDir, componentPath) {
  const abs = resolveInRoot(rootDir, componentPath);
  return withSourceFileLock(abs, async () => {
    if (!existsSync(abs)) throw new ComponentFileError('Component file not found', 404);
    const content = await readFile(abs, 'utf-8');
    await unlink(abs);
    return content;
  });
}

/** task-207 Task 12: promote INTO `sq/` (or back out). */
export async function moveComponentToSystemDir(rootDir, componentPath, promote, reservedNames = []) {
  const abs = resolveInRoot(rootDir, componentPath);
  if (!existsSync(abs)) throw new ComponentFileError('Component file not found', 404);

  const base = path.basename(componentPath);
  const name = base.replace(/\.astro$/, '');
  const inSystemDir = path.basename(path.dirname(componentPath)) === 'sq'; // the editor's POSIX path, on Windows too
  if (promote === inSystemDir) {
    throw new ComponentFileError(
      promote ? 'Already a system component' : 'Not a system component',
      409,
    );
  }
  if (promote && reservedNames.includes(name)) {
    throw new ComponentFileError(`${name} is a system component name`, 409);
  }

  const dir = path.dirname(componentPath);
  const nextDir = promote ? path.join(dir, 'sq') : path.dirname(dir);
  const next = resolveInRoot(rootDir, path.join(nextDir, base));
  return withSourceFileLocks([abs, next], async () => {
    if (existsSync(next)) {
      throw new ComponentFileError(`A component named "${name}" already exists there`, 409);
    }
    await mkdir(path.dirname(next), { recursive: true });
    await rename(abs, next);
    return path.relative(path.resolve(rootDir), next).split(path.sep).join('/');
  });
}

/** Layout name guard (mirrors localComponentFiles.assertLayoutName). */
export function assertLayoutName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    throw new ComponentFileError('Invalid layout name', 400);
  }
  return name;
}

// ── folders manifest (mirrors server/folders.ts) ─────────────────────────────

const EMPTY_MANIFEST = { version: 1, roots: [], folders: {} };

export async function readFolderManifest(file) {
  try {
    return JSON.parse(await readFile(file, 'utf-8'));
  } catch (error) {
    // An absent optional manifest is empty. Parse/read failures must reach
    // the route boundary, or a new edit can overwrite recoverable folders.
    if (error?.code === 'ENOENT') return EMPTY_MANIFEST;
    throw error;
  }
}

export async function writeFolderManifest(file, manifest) {
  await mkdir(path.dirname(file), { recursive: true });
  // Locked: source-command file batches write this file too.
  await rewriteFile(file, () => `${JSON.stringify(manifest, null, 2)}\n`);
}

export const localFoldersFile = (dir) => path.join(dir, '.starquix', 'folders.json');

// ── component + layout discovery (mirrors {component,layout}-discovery.ts) ───

export async function discoverComponents(componentsDir, baseDir) {
  const resolvedBase = baseDir || componentsDir;
  const results = [];
  let entries;
  try {
    entries = await readdir(componentsDir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(componentsDir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const sub = await discoverComponents(fullPath, resolvedBase);
        results.push(...sub);
      }
    } else if (entry.name.endsWith('.astro') && !entry.name.startsWith('_')) {
      try {
        const component = await parseComponent(fullPath, resolvedBase);
        if (component) results.push(component);
      } catch (err) {
        console.warn(`[scan-components] Failed to parse ${fullPath}:`, err);
      }
    }
  }
  return results;
}

async function parseComponent(filePath, baseDir) {
  const content = await readFile(filePath, 'utf-8');
  const relativePath = path.relative(baseDir, filePath).split(path.sep).join('/');
  const name = path.basename(filePath, '.astro');
  const category = extractCategory(content, filePath, baseDir);
  const frontmatter = extractFrontmatter(content);
  const props = extractProps(frontmatter);
  const slots = extractSlots(content);
  const dependencies = extractDependencies(frontmatter);
  const pageTemplate = extractPageTemplate(content);
  const defaultChildren = extractDefaultChildren(content);
  const contentBound = extractContentBound(frontmatter);
  const { theme, section } = libraryTags(content);
  return {
    name, path: relativePath, absolutePath: filePath, category, props, slots,
    dependencies, frontmatter, pageTemplate, defaultChildren, contentBound, theme, section,
  };
}

export function extractContentBound(frontmatter) {
  return /getCollection\s*\(|['"]astro:content['"]/.test(frontmatter);
}

export function extractPageTemplate(content) {
  const m = content.match(/@page-template\s+([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

export function extractCategory(content, filePath, baseDir) {
  const categoryMatch = content.match(/@category[ \t]+([^\n*@]+)/);
  if (categoryMatch) return categoryMatch[1].trim();
  const rel = path.relative(baseDir, path.dirname(filePath)).split(path.sep).join('/');
  if (rel && rel !== '.') {
    const parts = rel.split('/');
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  }
  return 'Uncategorized';
}

export function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : '';
}

export function extractProps(frontmatter) {
  const interfaceMatch = frontmatter.match(/interface\s+Props\s*\{([^}]*)\}/s);
  if (!interfaceMatch) return [];
  const body = interfaceMatch[1];
  const props = [];
  const propRegex = /(\w+)(\??):\s*([^;\n]+)/g;
  let m;
  while ((m = propRegex.exec(body)) !== null) {
    props.push({ name: m[1], type: m[3].trim(), required: m[2] !== '?' });
  }
  const destructMatch = frontmatter.match(/const\s*\{([^}]*)\}\s*=\s*Astro\.props/s);
  if (destructMatch) {
    const destructBody = destructMatch[1];
    const defaultRegex = /(\w+)\s*=\s*(['"`])(.*?)\2/g;
    let dm;
    while ((dm = defaultRegex.exec(destructBody)) !== null) {
      const prop = props.find((p) => p.name === dm[1]);
      if (prop) prop.defaultValue = dm[3];
    }
  }
  return props;
}

export function extractSlots(content) {
  const slots = [];
  const slotRegex = /<slot\s+name=["']([^"']+)["']/g;
  let m;
  while ((m = slotRegex.exec(content)) !== null) slots.push(m[1]);
  if (/<slot\s*\/?>/.test(content) || /<slot>/.test(content)) {
    if (!slots.includes('default')) slots.unshift('default');
  }
  return slots;
}

export function extractDefaultChildren(content) {
  const m = content.match(/@default-children\s+([^\n*]+)/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, slotName] = entry.split(':').map((s) => s.trim());
      return slotName ? { name, slotName } : { name, slotName: undefined };
    });
}

export function extractDependencies(frontmatter) {
  const deps = [];
  const importRegex = /import\s+\w+\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = importRegex.exec(frontmatter)) !== null) {
    if (m[1].endsWith('.astro') || m[1].startsWith('.')) deps.push(m[1]);
  }
  return deps;
}

function stripFrontmatter(src) {
  return src.replace(/^---[\s\S]*?---\s*/, '').trim();
}

export async function discoverLayouts(layoutsDir) {
  let entries;
  try {
    entries = await readdir(layoutsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.astro')) continue;
    if (entry.name.startsWith('_')) continue;
    const fullPath = path.join(layoutsDir, entry.name);
    const content = await readFile(fullPath, 'utf-8');
    const frontmatter = extractFrontmatter(content);
    results.push({
      name: path.basename(entry.name, '.astro'),
      path: path.relative(layoutsDir, fullPath),
      absolutePath: fullPath,
      props: extractProps(frontmatter),
      slots: extractSlots(content),
      frontmatter,
      body: stripFrontmatter(content),
    });
  }
  return results;
}

/** task-136: scan a project's own src/components + dynamic page routes as
 *  "Page designs" — the `/__sq/scan-components?source=local` payload. */
export async function scanComponents(dir) {
  const components = (await discoverComponents(path.join(dir, 'src', 'components')))
    .filter((comp) => !isHiddenScanPath(`src/components/${comp.path}`));
  const results = await Promise.all(components.map(async (comp) => {
    let html = '';
    try {
      const raw = await readFile(comp.absolutePath, 'utf-8');
      html = raw.replace(/^---[\s\S]*?---\s*/, '').trim();
    } catch { /* unreadable — listed without preview */ }
    return {
      name: comp.name,
      path: `src/components/${comp.path}`,
      source: 'user-project',
      html,
      category: comp.category,
      props: comp.props,
      slots: comp.slots,
      dependencies: comp.dependencies,
      frontmatter: comp.frontmatter,
      pageTemplate: null,
      defaultChildren: comp.defaultChildren,
      contentBound: comp.contentBound,
      theme: comp.theme,
      section: comp.section,
    };
  }));
  const pagesRoot = path.join(dir, 'src', 'pages');
  const pageDesigns = [];
  const walkPages = async (rel) => {
    const abs = path.join(pagesRoot, rel);
    if (!existsSync(abs)) return;
    for (const e of await readdir(abs, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walkPages(r);
      else if (e.name.endsWith('.astro') && e.name.includes('[')) {
        let html = '';
        try {
          const raw = await readFile(path.join(pagesRoot, r), 'utf-8');
          html = raw.replace(/^---[\s\S]*?---\s*/, '').trim();
        } catch { /* unreadable — listed without preview */ }
        pageDesigns.push({
          name: r.replace(/\.astro$/, ''),
          path: `src/pages/${r}`,
          source: 'user-project',
          html,
          category: 'Page designs',
          props: [],
          slots: [],
          dependencies: [],
          frontmatter: '',
          pageTemplate: null,
          defaultChildren: [],
          contentBound: false,
        });
      }
    }
  };
  await walkPages('');
  return [...results, ...pageDesigns];
}

/** task-137: a project's own src/layouts — the `/__sq/scan-layouts?source=local` payload. */
export function scanLayouts(dir) {
  return discoverLayouts(path.join(dir, 'src', 'layouts'));
}
