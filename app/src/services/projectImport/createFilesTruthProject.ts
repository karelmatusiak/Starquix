/**
 * Files-truth project creation (Phase 2 Task 2.5): a project IS an Astro
 * folder in Dexie `projectFiles`, run by the desktop app as the local runtime.
 *
 *  - import: copy the picked folder in (skip-dirs + caps from processFolder
 *    reused; no theme, no doc pages), normalized for editorial layouts:
 *    `.md` posts → `.mdx` when they compile, MDX + Tailwind utilities
 *    ensured (normalizeForEditorial, design D5);
 *  - new:    copy a minimal scaffold in (tailwind + mdx, one page, one layout).
 *
 * Phase 6: THE creation paths (the doc-truth converter is gone).
 */
import { saveProjectLibraryTheme } from '@/services/projectLibraryTheme';
import { DEFAULT_LIBRARY_THEME } from '@/utils/libraryThemes';
import { v4 as uuidv4 } from 'uuid';
import { db } from '@/db';
import { putProjectFiles, deleteAllProjectFiles } from '@/db/projectFiles';
import { markFilesTruth, unmarkFilesTruth } from '@/utils/localMode';
import type { ImportEntry } from './processFolder';
import { normalizeImportedEntries } from './normalizeForEditorial';
import { librarySource } from '@/services/listConversion';
import { ImportValidationError, prepareImportMetadata, stripPickedFolderPaths } from './importValidation';

/** The picked folder's own name is segment 0 of every webkitRelativePath. */
export function stripPickedFolder(entries: ImportEntry[]): ImportEntry[] {
  const paths = stripPickedFolderPaths(entries.map((entry) => entry.path));
  return entries.map((entry, index) => ({ ...entry, path: paths[index] }));
}

/** Validate an Astro folder the way the host's validateAstroProject does. */
export function validateAstroFolder(entries: ImportEntry[]): { ok: true } | { ok: false; reason: string; code: 'missing-package' | 'unreadable-package' | 'not-astro' } {
  const pkg = entries.find((e) => e.path === 'package.json');
  if (!pkg) return { ok: false, reason: 'No package.json — not a project folder', code: 'missing-package' };
  let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try { parsed = JSON.parse(new TextDecoder().decode(pkg.content)); } catch { return { ok: false, reason: 'Unreadable package.json', code: 'unreadable-package' }; }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'Unreadable package.json', code: 'unreadable-package' };
  if (!parsed.dependencies?.astro && !parsed.devDependencies?.astro) return { ok: false, reason: 'astro is not a dependency — not an Astro project', code: 'not-astro' };
  return { ok: true };
}

export interface FilesTruthImportResult { projectId: string; fileCount: number; skipped: number }

export async function importFilesTruthProject(rawEntries: ImportEntry[], name: string): Promise<FilesTruthImportResult> {
  const prepared = prepareImportMetadata(rawEntries.map((entry) => ({
    ...entry,
    size: entry.content.byteLength,
  })));
  const picked = prepared.entries.map((entry) => ({ path: entry.path, content: entry.source.content }));
  const v = validateAstroFolder(picked);
  if (!v.ok) throw new ImportValidationError(v.code, v.reason);
  const entries = await normalizeImportedEntries(picked, { blogSlotLibrary: await librarySource('BlogSlot') });
  const projectId = `browser_${uuidv4()}`;
  await persistFilesTruthProject(projectId, name, entries);
  return { projectId, fileCount: entries.length, skipped: prepared.skipped };
}

async function persistFilesTruthProject(projectId: string, name: string, entries: ImportEntry[]): Promise<void> {
  const now = new Date();
  await db.transaction('rw', db.projects, db.projectFiles, db.projectThemes, async () => {
    await db.projects.add({ id: projectId, name, pagesTree: [], filesTruth: true, createdAt: now, updatedAt: now });
    await putProjectFiles(projectId, entries);
    // New and imported projects start on Starquix; no record = a project from before themes (Classic).
    await saveProjectLibraryTheme(projectId, DEFAULT_LIBRARY_THEME);
  });
  markFilesTruth(projectId);
}

/** A minimal, clean Astro project — nothing of ours inside (the wrapper
 *  injects our plugin at boot). Text only; keys are project-relative. */
export const SCAFFOLD_FILES: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'starquix-site', type: 'module', version: '0.0.1',
    scripts: { dev: 'astro dev', build: 'astro build', preview: 'astro preview' },
    dependencies: { '@astrojs/mdx': '^8.1.3', '@astrojs/tailwind': '^6.0.2', astro: '^7.4.7', tailwindcss: '^3.4.0' },
    // @astrojs/tailwind's peer range stops at Astro 5; Astro 7 needs Node ≥22.23.4 on the host (Vercel reads engines).
    overrides: { '@astrojs/tailwind': { astro: '$astro' } },
    engines: { node: '>=22.23.4' },
  }, null, 2) + '\n',
  'astro.config.mjs': [
    "import { defineConfig } from 'astro/config';",
    "import tailwind from '@astrojs/tailwind';",
    "import mdx from '@astrojs/mdx';",
    '',
    'export default defineConfig({',
    '  integrations: [tailwind(), mdx()],',
    '});',
    '',
  ].join('\n'),
  'tailwind.config.mjs': [
    '/** @type {import("tailwindcss").Config} */',
    'export default {',
    "  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],",
    '  theme: { extend: {} },',
    '  plugins: [],',
    '};',
    '',
  ].join('\n'),
  'src/pages/index.astro': [
    '<html lang="cs">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '    <title>Domů</title>',
    '  </head>',
    '  <body></body>',
    '</html>',
    '',
  ].join('\n'),
  'src/content/.gitkeep': '',
  '.gitignore': 'node_modules\ndist\n.astro\n',
};

export async function createScaffoldProject(name: string): Promise<string> {
  const projectId = `browser_${uuidv4()}`;
  const enc = new TextEncoder();
  const scaffold = Object.entries(SCAFFOLD_FILES).map(([path, text]) => ({ path, content: enc.encode(text) }));
  const prepared = prepareImportMetadata(scaffold.map((entry) => ({ ...entry, size: entry.content.byteLength })));
  const entries = prepared.entries.map((entry) => ({ path: entry.path, content: entry.source.content }));
  await persistFilesTruthProject(projectId, name, entries);
  return projectId;
}

/** Delete-project half for files-truth rows (the caller removes the row). */
export async function deleteFilesTruthData(projectId: string): Promise<void> {
  await deleteAllProjectFiles(projectId);
  unmarkFilesTruth(projectId);
}
