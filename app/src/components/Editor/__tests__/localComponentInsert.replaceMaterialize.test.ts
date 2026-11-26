// Gap 7 (WC/local parity): DragGutter "Replace" used to silently degrade to a
// plain insert in local mode — the new component was added, the old element
// kept, the toast lied "Added". insertLocalComponent now takes `replaceKey`:
// the insert is anchored AFTER the replaced element and the element is removed
// in the same guarded sequence; un-removable targets keep the insert with an
// honest toast.
//
// Gaps 11/36: built-in/theme components were flat-refused in local mode.
// With `localProjectPath` they are MATERIALIZED — real bytes fetched through
// /__sq/component-html?raw=1, relative .astro deps copied flattened with
// specifiers rewritten, name collisions reuse the user's file — then inserted
// through the unchanged user-project path.
//
// Files-truth migration (2026-09): since fdd2d12f the whole gesture —
// materialized component files, import, insert, replace-remove — is ONE
// durable file batch over the projected source (prepareSourceGesture +
// acceptFileChanges), materialized to the instance afterwards. There is no
// viteStructuralWriter call and no /component-create POST to observe, so these
// tests run the real transforms and the real /__sq/local/* route table over a
// temp disk (projectFsRuntime) and assert on the files that land.
import 'fake-indexeddb/auto'; // before any module that constructs the Dexie db
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ScannedElement } from '@/context/SelectionContext';

/** Per-test fault injection for the pure structural transform. */
const transformFault: { kind: string | null } = { kind: null };
vi.mock('@/services/durableEdits/structuralTransform', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/services/durableEdits/structuralTransform')>();
  return {
    ...real,
    applyStructuralTransform: (source: string, op: Parameters<typeof real.applyStructuralTransform>[1]) => {
      if (transformFault.kind === op.kind) throw new Error(`${op.kind} refused`);
      return real.applyStructuralTransform(source, op);
    },
  };
});

vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() });
  return { default: toast };
});

import toast from 'react-hot-toast';
import { insertLocalComponent, materializeLibraryComponent } from '../localComponentInsert';
import { clearSnapshotCache } from '@/services/snapshotLoader';
import { listUnmaterialized } from '@/services/durableEdits/store';
import type { UsageTargetNode } from '@/utils/localUsageTarget';
import bundledSnapshot from '../../../../public/astro-snapshot.json';
import { openDurableInsertProject, type DurableInsertProject } from './localInsertDurableHarness';

const PAGE = 'src/pages/index.astro';
const CARD = 'src/components/Card.astro';
const HERO_FILE = 'src/components/hero.astro';
const IMPORT_LINE = "import Hero from '../components/hero.astro';";

/** <section class="old"> at 5:3 is the replace target; <p> must survive. */
const PAGE_SRC = `---
const title = 'Home';
---
<main>
  <section class="old"></section>
  <p>keep</p>
</main>
`;
const PAGE_REPLACED = `---
${IMPORT_LINE}
const title = 'Home';
---
<main>
  <Hero />
  <p>keep</p>
</main>
`;

const heroComponent = {
  name: 'hero',
  path: HERO_FILE,
  source: 'user-project' as const,
  html: '<section></section>',
  category: 'Other',
  props: [],
  slots: [],
  dependencies: [],
};

const el = (over: Partial<ScannedElement> = {}): ScannedElement => ({
  key: `${PAGE}:5:3`,
  tagName: 'section',
  classes: '',
  sourceLocation: { file: PAGE, line: 5, column: 3 },
  rect: { top: 0, left: 0, width: 10, height: 10 },
  parentKey: null,
  hasSourceTracking: true,
  ...over,
});

let project: DurableInsertProject;
const onDisk = async (file = PAGE) => { await project.flush(); return project.read(file); };
const exists = (file: string) => existsSync(join(project.runtime.root, file));
const acceptedBatches = async () => (await listUnmaterialized(project.projectId)).length;

// ── page fetch router: only the dev raw built-in source + the prod snapshot
// are page fetches; /__sq/local/* goes through the real route table. ───────
let fetchCalls: string[] = [];
let librarySources: Record<string, string> = {};
let libraryContentTypes: Record<string, string> = {};

function installFetchMock() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    if (url.startsWith('/__sq/component-html?')) {
      const libPath = new URL(url, 'http://localhost').searchParams.get('path') ?? '';
      const src = librarySources[libPath];
      return src === undefined
        ? new Response('not found', { status: 404 })
        : new Response(src, {
            status: 200,
            headers: { 'content-type': libraryContentTypes[libPath] ?? 'text/plain' },
          });
    }
    if (url === '/astro-snapshot.json') {
      return new Response(JSON.stringify(bundledSnapshot), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('unexpected', { status: 500 });
  }));
}

/** The production branch reads built-ins from the validated snapshot. */
function productionMaterializer() {
  vi.stubEnv('PROD', true);
  vi.stubEnv('VITE_SNAPSHOT_VERSION', bundledSnapshot.version);
  clearSnapshotCache();
  return materializeLibraryComponent;
}

async function open(files: Record<string, string> = {}) {
  project = await openDurableInsertProject({ [PAGE]: PAGE_SRC, [HERO_FILE]: '<section></section>\n', ...files });
}

beforeEach(async () => {
  vi.stubEnv('PROD', false);
  vi.clearAllMocks();
  transformFault.kind = null;
  fetchCalls = [];
  librarySources = {};
  libraryContentTypes = {};
  await open();
  installFetchMock();
});

afterEach(async () => {
  await project.close();
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); clearSnapshotCache();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('gap 7 — replaceKey (DragGutter Replace in local mode)', () => {
  it('same-file replace: insert AFTER the target, then remove it (lineDelta-adjusted)', async () => {
    const pushUndo = vi.fn();
    const selection = el();
    const r = await insertLocalComponent({
      component: heroComponent, selection, scannedElements: [selection], pageFile: PAGE,
      replaceKey: selection.key, pushUndo,
    });
    expect(r.ok).toBe(true);
    const forward = pushUndo.mock.calls[0][0].structuralOp.forward;
    // Insert anchored AFTER the replaced element (never inside it), shifted by
    // the import's lineDelta 1; then the remove of the element's own (shifted)
    // start — strictly after the insert in the same gesture.
    expect(forward).toMatchObject([
      { kind: 'import', pageFile: PAGE, name: 'Hero', remove: false },
      { kind: 'insert', loc: { file: PAGE, line: 6, column: 3 }, markup: '<Hero />', position: 'after' },
      { kind: 'remove', loc: { file: PAGE, line: 6, column: 3 }, allowRootRemoval: true },
    ]);
    expect(await onDisk()).toBe(PAGE_REPLACED);
    // (The "Replaced with" success toast was retired in 426889ee.)
  });

  // fdd2d12f: insert + remove are ONE accepted batch, so undo is ONE record
  // (forward [import, insert, remove], inverse reversed) — the old two-record
  // "undo restores in two steps" contract is retired with it.
  it('pushes ONE undo record whose inverse restores the removed element verbatim first', async () => {
    const pushUndo = vi.fn();
    const selection = el();
    await insertLocalComponent({
      component: heroComponent, selection, scannedElements: [selection], pageFile: PAGE,
      replaceKey: selection.key, pushUndo,
    });
    expect(pushUndo).toHaveBeenCalledTimes(1);
    const { inverse } = pushUndo.mock.calls[0][0].structuralOp;
    expect(inverse[0]).toEqual({
      kind: 'restore',
      loc: { file: PAGE, line: 6, column: 1 },
      text: '  <section class="old"></section>\n',
    });
    expect(inverse.map((op: { kind: string }) => op.kind)).toEqual(['restore', 'restore-region', 'import']);
  });

  it('pre-existing import (added:false): NO lineDelta shift on insert or remove', async () => {
    await project.close();
    await open({ [PAGE]: PAGE_SRC.replace("---\nconst", `---\n${IMPORT_LINE}\nconst`) });
    const pushUndo = vi.fn();
    // With the import already present the section sits at 6:3.
    const selection = el({ key: `${PAGE}:6:3`, sourceLocation: { file: PAGE, line: 6, column: 3 } });
    await insertLocalComponent({
      component: heroComponent, selection, scannedElements: [selection], pageFile: PAGE,
      replaceKey: selection.key, pushUndo,
    });
    expect(pushUndo.mock.calls[0][0].structuralOp.forward).toMatchObject([
      { kind: 'insert', loc: { file: PAGE, line: 6, column: 3 }, markup: '<Hero />', position: 'after' },
      { kind: 'remove', loc: { file: PAGE, line: 6, column: 3 }, allowRootRemoval: true },
    ]);
    expect(await onDisk()).toBe(PAGE_REPLACED);
  });

  // fdd2d12f: a remove that cannot be prepared now fails the WHOLE gesture
  // ('Replacement could not be prepared') — the old "insert KEPT + honest
  // toast" degraded state no longer exists; nothing half-lands.
  it('remove failure: the whole replace is refused atomically — nothing written, no undo record', async () => {
    transformFault.kind = 'remove';
    const pushUndo = vi.fn();
    const selection = el();
    const r = await insertLocalComponent({
      component: heroComponent, selection, scannedElements: [selection], pageFile: PAGE,
      replaceKey: selection.key, pushUndo,
    });
    expect(r).toMatchObject({ ok: false, reason: 'Replacement could not be prepared' });
    expect(pushUndo).not.toHaveBeenCalled();
    expect(await acceptedBatches()).toBe(0);
    expect(await onDisk()).toBe(PAGE_SRC);
  });

  it('suffixed replaceKey (loop copy): plain insert, honest toast, NO remove', async () => {
    const pushUndo = vi.fn();
    const selection = el();
    await insertLocalComponent({
      component: heroComponent, selection, scannedElements: [selection], pageFile: PAGE,
      replaceKey: `${PAGE}:5:3#1`, pushUndo,
    });
    const kinds = pushUndo.mock.calls[0][0].structuralOp.forward.map((op: { kind: string; position?: string }) => op.position ?? op.kind);
    // Plain insert used the normal anchor (inside-end of the selection), no remove.
    expect(kinds).toEqual(['import', 'inside-end']);
    expect(await onDisk()).toContain('<section class="old">\n    <Hero />\n  </section>');
    // The degraded-replace toast fires once the batch has materialized.
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("loop copies can't be replaced")));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('cross-file replaceKey with NO usage tag: plain insert, finite shared-component explanation, NO remove', async () => {
    const pushUndo = vi.fn();
    const selection = el();
    await insertLocalComponent({
      component: heroComponent, selection, scannedElements: [selection], pageFile: PAGE,
      replaceKey: `${CARD}:3:1`, pushUndo,
    });
    expect(pushUndo.mock.calls[0][0].structuralOp.forward.map((op: { kind: string }) => op.kind)).not.toContain('remove');
    await onDisk();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining('part of a shared component')));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('cross-file replaceKey WITH a usage tag (task-148): removes the <Component /> usage in the page file', async () => {
    await project.close();
    await open({
      [PAGE]: `---\nimport Card from '../components/Card.astro';\n---\n<main>\n  <Card />\n  <p>keep</p>\n</main>\n`,
      [CARD]: '<div class="card"></div>\n',
    });
    const cardRootKey = `${CARD}:1:1`;
    const scannedByKey = new Map<string, UsageTargetNode>([
      [cardRootKey, {
        parentKey: null,
        sourceLocation: { file: CARD, line: 1, column: 1 },
        usageLocation: { file: PAGE, line: 5, column: 3 },
      }],
    ]);
    const pushUndo = vi.fn();
    const selection = el();
    await insertLocalComponent({
      component: heroComponent, selection, scannedElements: [selection], pageFile: PAGE,
      replaceKey: cardRootKey, scannedByKey, pushUndo,
    });
    // Insert after the USAGE tag, remove the usage tag — both lineDelta-shifted.
    expect(pushUndo.mock.calls[0][0].structuralOp.forward).toMatchObject([
      { kind: 'import' },
      { kind: 'insert', loc: { file: PAGE, line: 6, column: 3 }, markup: '<Hero />', position: 'after' },
      { kind: 'remove', loc: { file: PAGE, line: 6, column: 3 }, allowRootRemoval: true },
    ]);
    expect(await onDisk()).toBe(`---\nimport Card from '../components/Card.astro';\n${IMPORT_LINE}\n---\n<main>\n  <Hero />\n  <p>keep</p>\n</main>\n`);
    expect(project.read(CARD)).toBe('<div class="card"></div>\n'); // the master is untouched
  });

  it('insert failure: remove is NEVER attempted (no orphan delete)', async () => {
    transformFault.kind = 'insert';
    const selection = el();
    const r = await insertLocalComponent({
      component: heroComponent, selection, scannedElements: [selection], pageFile: PAGE,
      replaceKey: selection.key,
    });
    expect(r.ok).toBe(false);
    expect(await onDisk()).toBe(PAGE_SRC);
  });

  it('no replaceKey: behavior unchanged (regression pin — plain insert, no remove)', async () => {
    const pushUndo = vi.fn();
    const selection = el();
    await insertLocalComponent({
      component: heroComponent, selection, scannedElements: [selection], pageFile: PAGE, pushUndo,
    });
    expect(pushUndo.mock.calls[0][0].structuralOp.forward).toMatchObject([
      { kind: 'import' },
      { kind: 'insert', markup: '<Hero />', position: 'inside-end' },
    ]);
    expect(await onDisk()).toContain('<section class="old">\n    <Hero />\n  </section>\n  <p>keep</p>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('gaps 11/36 — built-in/theme materialize-on-insert', () => {
  const builtInCTA = {
    ...heroComponent,
    name: 'CTA',
    path: 'library/CTA.astro',
    source: 'built-in' as const,
  };
  const CTA_IMPORT = "import CTA from '../components/CTA.astro';";

  it('without localProjectPath: the old refusal stands (AI path unchanged)', async () => {
    const r = await insertLocalComponent({
      component: builtInCTA, selection: null, scannedElements: [], pageFile: PAGE,
    });
    expect(r.ok).toBe(false);
    expect(await acceptedBatches()).toBe(0);
    expect(await onDisk()).toBe(PAGE_SRC);
    expect(exists('src/components/CTA.astro')).toBe(false);
  });

  it('built-in: copies the REAL bytes into src/components/ then inserts normally', async () => {
    librarySources['library/CTA.astro'] = '---\nconst { title } = Astro.props;\n---\n<section class="cta">{title}</section>\n';
    const r = await insertLocalComponent({
      component: builtInCTA, selection: null, scannedElements: [], pageFile: PAGE,
      localProjectPath: project.folder,
    });
    expect(r.ok).toBe(true);
    expect(fetchCalls.some((call) => call === '/astro-snapshot.json')).toBe(false);
    // The insert flows through the NORMAL user-project path on the copied file.
    const page = await onDisk();
    expect(project.read('src/components/CTA.astro')).toBe(librarySources['library/CTA.astro']);
    expect(page).toContain(CTA_IMPORT);
    expect(page).toContain('  <CTA />\n</main>');
  });

  it('name collision: REUSES the user\'s file — never overwrites', async () => {
    await project.close();
    await open({ 'src/components/CTA.astro': '<div>mine</div>\n' });
    librarySources['library/CTA.astro'] = '---\n---\n<section class="cta"></section>\n';
    const r = await insertLocalComponent({
      component: builtInCTA, selection: null, scannedElements: [], pageFile: PAGE,
      localProjectPath: project.folder,
    });
    expect(r.ok).toBe(true);
    expect(await onDisk()).toContain(CTA_IMPORT);
    expect(project.read('src/components/CTA.astro')).toBe('<div>mine</div>\n');
  });

  it('themed: another theme\'s same-name file is never reused — the section lands as <Name><Theme>', async () => {
    await project.close();
    await open({ 'src/components/CTA.astro': '---\n/**\n * @category CTA\n * @theme classic\n * @name CTA\n */\n---\n<div>classic</div>\n' });
    librarySources['library/CTA.astro'] = '---\n/**\n * @category CTA\n * @theme starquix\n * @name CTA\n */\n---\n<section class="cta"></section>\n';
    const r = await insertLocalComponent({
      component: { ...builtInCTA, theme: 'starquix' }, selection: null, scannedElements: [], pageFile: PAGE,
      localProjectPath: project.folder,
    });
    expect(r.ok).toBe(true);
    const page = await onDisk();
    expect(project.read('src/components/CTA.astro')).toContain('<div>classic</div>');
    expect(project.read('src/components/CTAStarquix.astro')).toBe(librarySources['library/CTA.astro']);
    expect(page).toContain("import CTAStarquix from '../components/CTAStarquix.astro';");
    expect(page).toContain('<CTAStarquix />');
  });

  it('themed: a same-theme copy is reused (the user\'s edits win)', async () => {
    await project.close();
    await open({ 'src/components/CTA.astro': '---\n/**\n * @theme starquix\n * @name CTA\n */\n---\n<div>edited</div>\n' });
    librarySources['library/CTA.astro'] = '---\n/**\n * @theme starquix\n * @name CTA\n */\n---\n<section class="cta"></section>\n';
    const r = await insertLocalComponent({
      component: { ...builtInCTA, theme: 'starquix' }, selection: null, scannedElements: [], pageFile: PAGE,
      localProjectPath: project.folder,
    });
    expect(r.ok).toBe(true);
    expect(await onDisk()).toContain(CTA_IMPORT);
    expect(project.read('src/components/CTA.astro')).toContain('<div>edited</div>');
    expect(exists('src/components/CTAStarquix.astro')).toBe(false);
  });

  it('dependency closure: deps copied flattened, import specifiers rewritten', async () => {
    librarySources['library/Header.astro'] =
      "---\nimport GlobalNav from './navigation/GlobalNav.astro';\n---\n<header><GlobalNav /></header>\n";
    librarySources['library/navigation/GlobalNav.astro'] = '---\n---\n<nav></nav>\n';
    const r = await insertLocalComponent({
      component: { ...builtInCTA, name: 'Header', path: 'library/Header.astro' },
      selection: null, scannedElements: [], pageFile: PAGE,
      localProjectPath: project.folder,
    });
    expect(r.ok).toBe(true);
    await onDisk();
    expect(project.read('src/components/GlobalNav.astro')).toBe('---\n---\n<nav></nav>\n');
    const header = project.read('src/components/Header.astro');
    expect(header).toContain("from './GlobalNav.astro'");
    expect(header).not.toContain('./navigation/');
  });

  it('a dep the USER already has (even foldered) is reused and the specifier points at THEIR file', async () => {
    await project.close();
    await open({ 'src/components/nav/GlobalNav.astro': '<nav>mine</nav>\n' });
    librarySources['library/Header.astro'] =
      "---\nimport GlobalNav from './navigation/GlobalNav.astro';\n---\n<header><GlobalNav /></header>\n";
    const r = await insertLocalComponent({
      component: { ...builtInCTA, name: 'Header', path: 'library/Header.astro' },
      selection: null, scannedElements: [], pageFile: PAGE,
      localProjectPath: project.folder,
    });
    expect(r.ok).toBe(true);
    await onDisk();
    expect(exists('src/components/GlobalNav.astro')).toBe(false); // dep NOT re-created
    expect(project.read('src/components/nav/GlobalNav.astro')).toBe('<nav>mine</nav>\n');
    expect(project.read('src/components/Header.astro')).toContain("from './nav/GlobalNav.astro'");
  });

  it('dep outside the library (layouts): honest refusal, NOTHING written', async () => {
    librarySources['library/BlogPost.astro'] =
      "---\nimport Layout from '../../layouts/Layout.astro';\n---\n<Layout><slot /></Layout>\n";
    const r = await insertLocalComponent({
      component: { ...builtInCTA, name: 'BlogPost', path: 'library/BlogPost.astro' },
      selection: null, scannedElements: [], pageFile: PAGE,
      localProjectPath: project.folder,
    });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: expect.stringContaining('outside the component library') });
    expect(await acceptedBatches()).toBe(0);
    expect(await onDisk()).toBe(PAGE_SRC);
    expect(exists('src/components/BlogPost.astro')).toBe(false);
  });

  it('empty built-in template: refused BEFORE any file lands in the project', async () => {
    librarySources['library/CTA.astro'] = '---\nconst x = 1;\n---\n   \n';
    const r = await insertLocalComponent({
      component: builtInCTA, selection: null, scannedElements: [], pageFile: PAGE,
      localProjectPath: project.folder,
    });
    expect(r.ok).toBe(false);
    expect(await acceptedBatches()).toBe(0);
    expect(await onDisk()).toBe(PAGE_SRC);
    expect(exists('src/components/CTA.astro')).toBe(false);
  });

  it('theme template: its markup becomes the new component file', async () => {
    const r = await insertLocalComponent({
      component: {
        id: 't1', name: 'Fancy Hero', category: 'Hero', image: '',
        html: '<section class="fancy"></section>', themeId: 'th', componentPath: 'x',
      },
      selection: null, scannedElements: [], pageFile: PAGE,
      localProjectPath: project.folder,
    });
    expect(r.ok).toBe(true);
    expect(await onDisk()).toContain("import FancyHero from '../components/FancyHero.astro';");
    expect(project.read('src/components/FancyHero.astro')).toBe('<section class="fancy"></section>\n');
  });

  it('scan endpoint failure: honest refusal, no writes', async () => {
    project.runtime.close(); // the route table is gone: every /__sq/local/* read fails
    const { setLocalTransport } = await import('@/utils/sqLocalBase');
    setLocalTransport({ projectPath: project.folder, fetch: async () => new Response('nope', { status: 500 }) });
    const r = await insertLocalComponent({
      component: builtInCTA, selection: null, scannedElements: [], pageFile: PAGE,
      localProjectPath: project.folder,
    });
    expect(r.ok).toBe(false);
    expect(await acceptedBatches()).toBe(0);
    await open(); // fresh runtime for afterEach
  });
});

// Direct unit coverage of the materializer's reuse contract.
describe('materializeLibraryComponent', () => {
  it('production ignores the HTTP 200 editor shell and creates Hero from the bundled snapshot bytes', async () => {
    // Case-insensitive disks (macOS) would alias the fixture's hero.astro.
    await project.close();
    project = await openDurableInsertProject({ [PAGE]: PAGE_SRC });
    const materializeProductionComponent = productionMaterializer();
    librarySources['library/Hero.astro'] = [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '  <head><title>Starquix Editor</title></head>',
      '  <body><div id="root"></div></body>',
      '</html>',
    ].join('\n');
    libraryContentTypes['library/Hero.astro'] = 'text/html';
    const encoded = bundledSnapshot.files['src/components/library/Hero.astro'];
    const expectedHero = new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
    );

    const result = await materializeProductionComponent(
      { name: 'Hero', path: 'library/Hero.astro', source: 'built-in', html: '', category: 'Hero', props: [], slots: [], dependencies: [] },
      project.folder,
    );

    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({ path: 'src/components/Hero.astro', reused: false });
    await project.flush();
    expect(project.read('src/components/Hero.astro')).toBe(expectedHero);
    expect(expectedHero).toContain('Chléb z\u00A0pece'); // the Webdílna theme's Hero (Classic: library/classic/)
    expect(expectedHero).not.toContain('<div id="root"></div>');
    expect(fetchCalls.some((call) => call.startsWith('/__sq/component-html'))).toBe(false);
  });

  it('production copies the real BlogSlot dependency closure from the bundled snapshot', async () => {
    const materializeProductionComponent = productionMaterializer();
    const result = await materializeProductionComponent(
      { name: 'BlogSlot', path: 'library/BlogSlot.astro', source: 'built-in', html: '', category: 'Blog', props: [], slots: [], dependencies: [] },
      project.folder,
    );

    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({
      path: 'src/components/BlogSlot.astro',
      created: ['src/components/BlogCard.astro', 'src/components/BlogSlot.astro'],
    });
    await project.flush();
    expect(exists('src/components/BlogCard.astro')).toBe(true);
    expect(project.read('src/components/BlogSlot.astro')).toContain("from './BlogCard.astro'");
  });

  it('production refuses a built-in missing from the validated snapshot before creating a file', async () => {
    const materializeProductionComponent = productionMaterializer();
    const result = await materializeProductionComponent(
      { name: 'Missing', path: 'library/Missing.astro', source: 'built-in', html: '', category: 'Other', props: [], slots: [], dependencies: [] },
      project.folder,
    );

    expect(result).toEqual({ ok: false, reason: 'could not read the built-in source for Missing' });
    expect(await acceptedBatches()).toBe(0);
    expect(exists('src/components/Missing.astro')).toBe(false);
  });

  it.each([
    ['the editor app shell', '<!DOCTYPE html><html><body><div id="root"></div></body></html>', 'text/html'],
    ['binary bytes', '---\n---\n<section>not trusted</section>', 'application/octet-stream'],
  ])('development refuses %s returned with HTTP 200 before creating a file', async (_label, source, contentType) => {
    librarySources['library/CTA.astro'] = source;
    libraryContentTypes['library/CTA.astro'] = contentType;

    const result = await materializeLibraryComponent(
      { name: 'CTA', path: 'library/CTA.astro', source: 'built-in', html: '', category: 'Other', props: [], slots: [], dependencies: [] },
      project.folder,
    );

    expect(result).toEqual({ ok: false, reason: 'could not read the built-in source for CTA' });
    expect(await acceptedBatches()).toBe(0);
    expect(exists('src/components/CTA.astro')).toBe(false);
  });

  it('reused root reports the USER\'s path and body', async () => {
    await project.close();
    await open({ 'src/components/cards/CTA.astro': '<div>mine</div>\n' });
    const r = await materializeLibraryComponent(
      { name: 'CTA', path: 'library/CTA.astro', source: 'built-in', html: '', category: 'Other', props: [], slots: [], dependencies: [] },
      project.folder,
    );
    expect(r).toEqual({ ok: true, path: 'src/components/cards/CTA.astro', body: '<div>mine</div>', reused: true, created: [] });
  });
});
