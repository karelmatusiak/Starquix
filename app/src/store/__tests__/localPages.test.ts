// task-145: local-mode page creation — file FIRST (files are truth), doc page
// second with id = localPageId(route) and name = route so the iframe mapping
// and the seeding convention both hold.
//
// Migrated 2026-09-23: fdd2d12f made page create/delete a durable file
// acceptance planned by `/__sq/local/page-plan` (the direct `/__sq/local/page`
// and `/__sq/local/page-delete` POSTs and contentOps.deletePost for post pages
// are gone from this path). "File first" now means: the instance plans the
// file change and it is durably accepted in the SAME transaction as the doc
// row — a refused plan leaves the doc untouched. Runs against the real route
// table + temp disk (projectFsRuntime) + fake-indexeddb.
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { db } from '@/db';
import { projectFsRuntime } from '@/test/projectFsRuntime';
import { setLocalTransport } from '@/utils/sqLocalBase';
import { setActiveSaveProjectId } from '@/services/pendingProjectMutations';
import { flushDurableSourceWritesThrough } from '@/services/durableEdits/sourceMaterialization';
import * as storage from '@/services/durableEdits/store';
import * as fileAcceptance from '@/services/durableEdits/fileAcceptance';
import { createLocalDocPage, deleteLocalDocPage } from '../localPages';
import { acceptVariablesCss } from '@/services/durableEdits/featureAcceptance';
import { contentOps } from '@/core/collections/content-ops';
import { localPageId, markFilesTruth } from '@/utils/localMode';
import { generateCommandTools } from '@/ai/tools/commandTools';
import { makeCtx } from '@/ai/tools/__tests__/testCtx';
import { applyCommand } from '../commands';

const HOME = '---\n---\n<html><body><main>home</main></body></html>\n';
const CONTENT = '---\n---\n<html><body><main>about</main></body></html>\n';
let projectId: string;
let folder: string;
let runtime: ReturnType<typeof projectFsRuntime> | undefined;

const start = (files: Record<string, string>) => { runtime = projectFsRuntime(projectId, files); return runtime; };
const newDoc = (): Y.Doc => {
  const doc = new Y.Doc();
  doc.getMap('meta').set('projectId', projectId);
  return doc;
};
const settle = async () => {
  const { acceptedRevision } = await storage.getDurableProjectState(projectId);
  if (acceptedRevision) await flushDurableSourceWritesThrough(projectId, acceptedRevision);
};

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  await db.delete(); await db.open();
  projectId = `browser_local_pages_${webcrypto.randomUUID()}`;
  folder = `wc://${projectId}`;
  setActiveSaveProjectId(projectId);
});
afterEach(async () => {
  await settle();
  runtime?.close(); runtime = undefined;
  setActiveSaveProjectId(null);
  vi.unstubAllGlobals();
});

describe('createLocalDocPage (task-145)', () => {
  it('writes the file via the instance, then adds the doc page keyed by route', async () => {
    const rt = start({ 'src/pages/index.astro': HOME });
    const doc = newDoc();
    const id = await createLocalDocPage(doc, folder, 'Page 4');

    expect(id).toBe(localPageId('/page-4'));
    const page = doc.getMap('pages').get(id) as Y.Map<unknown>;
    expect(page).toBeDefined();
    expect(page.get('name')).toBe('/page-4'); // route-name convention (seeding parity)
    expect(doc.getArray<string>('rootPages').toArray()).toContain(id);
    await settle();
    expect(rt.read('src/pages/page-4.astro')).toContain('<title>Page 4</title>');
  });

  // task-133 Task 9 review: the session pages list is fetched once at instance
  // boot — without this event a just-created page has no route→file mapping
  // (resolveLocalPageFile → null) and every follow-up structural write refuses.
  it('announces the created page (sq:local-page-created) so the session pages list can append it', async () => {
    start({ 'src/pages/index.astro': HOME });
    const events: Array<Record<string, unknown>> = [];
    const listener = (e: Event): void => { events.push((e as CustomEvent<Record<string, unknown>>).detail); };
    window.addEventListener('sq:local-page-created', listener);
    try {
      await createLocalDocPage(newDoc(), folder, 'About');
    } finally {
      window.removeEventListener('sq:local-page-created', listener);
    }
    expect(events).toEqual([{ route: '/about', file: 'src/pages/about.astro', editable: true }]);
  });

  // task-268: with no layout every page imports the variables file itself. A
  // page born after the variables got none (only a later variable edit would
  // add it), so it built without variables. Read from the ACCEPTED state: an
  // agent creates variables and the page back to back, before the CSS is on disk.
  it('a page created while variables exist imports them — even before the variables file is on disk', async () => {
    const rt = start({ 'src/pages/index.astro': HOME });
    await acceptVariablesCss(projectId, folder, ':root { --ink: #111; }');
    await createLocalDocPage(newDoc(), folder, 'Pricing');
    await settle();
    expect(rt.read('src/pages/pricing.astro')).toMatch(/^---\nimport '\.\.\/styles\/sq-variables\.css';\n---\n<html lang="cs">/);
  });

  it('a page file written whole (write_file) imports them too', async () => {
    const rt = start({ 'src/pages/index.astro': HOME });
    await acceptVariablesCss(projectId, folder, ':root { --ink: #111; }');
    const { rewriteLocalFile } = await import('@/utils/localElementSource');
    await rewriteLocalFile('src/pages/pricing.astro', () => '<main>Pricing</main>\n');
    expect(rt.read('src/pages/pricing.astro')).toContain("import '../styles/sq-variables.css';");
    await rewriteLocalFile('src/components/Card.astro', () => '<div />\n');
    expect(rt.read('src/components/Card.astro')).toBe('<div />\n');
  });

  it('a new page of a site with layouts gets no variables import of its own', async () => {
    const rt = start({ 'src/pages/index.astro': HOME, 'src/layouts/Base.astro': '<slot />\n' });
    await acceptVariablesCss(projectId, folder, ':root { --ink: #111; }');
    await createLocalDocPage(newDoc(), folder, 'Pricing');
    await settle();
    expect(rt.read('src/pages/pricing.astro')).not.toContain('sq-variables');
  });

  it('a new page of a site with no variables file is the plain template', async () => {
    const rt = start({ 'src/pages/index.astro': HOME });
    await createLocalDocPage(newDoc(), folder, 'Pricing');
    await settle();
    expect(rt.read('src/pages/pricing.astro')).toMatch(/^---\n---\n<html lang="cs">/);
  });

  // task-271: the AI's add_page switched the editor to the new page 80-150 ms
  // before its file was on disk; the canvas asked for the route, got Astro's
  // 404 and kept it (e2e-proven). Creation itself still resolves at acceptance
  // (pageReplay.test) — the tool waits for the file before it switches.
  it("the AI's add_page switches to the new page only once its file is on disk", async () => {
    const rt = runtime = projectFsRuntime(projectId, { 'src/pages/index.astro': HOME }, { beforeCommand: () => new Promise(resolve => setTimeout(resolve, 60)) });
    markFilesTruth(projectId);
    const ctx = makeCtx({ doc: newDoc() });
    const meta = ctx.doc.getMap('meta');
    let onDiskAtSwitch: boolean | null = null;
    meta.observe(() => {
      if (meta.get('currentPageId') === 'golf-club') onDiskAtSwitch ??= existsSync(join(rt.root, 'src/pages/golf-club.astro'));
    });
    const tools = generateCommandTools(ctx) as unknown as Record<string, { execute(args: object): Promise<{ success: boolean }> }>;
    expect((await tools.add_page.execute({ page: { id: 'page-1', name: 'Golf Club' }, __scanTimeoutMs: 20 })).success).toBe(true);
    expect(onDiskAtSwitch).toBe(true);
  });

  it('failed create announces nothing', async () => {
    start({ 'src/pages/index.astro': HOME });
    setLocalTransport({ projectPath: folder, fetch: async () => new Response(JSON.stringify({ error: 'nope' }), { status: 400 }) });
    const events: unknown[] = [];
    const listener = (e: Event): void => { events.push((e as CustomEvent).detail); };
    window.addEventListener('sq:local-page-created', listener);
    try {
      await expect(createLocalDocPage(newDoc(), folder, 'About')).rejects.toThrow('nope');
    } finally {
      window.removeEventListener('sq:local-page-created', listener);
    }
    expect(events).toEqual([]);
  });

  it('planner refusal → throws, doc untouched (no doc-only ghost page)', async () => {
    // No src/pages → "not an Astro project root".
    start({ 'README.md': 'x' });
    const doc = newDoc();
    await expect(createLocalDocPage(doc, folder, 'About')).rejects.toThrow(/src\/pages not found/);
    expect(doc.getMap('pages').size).toBe(0);
    expect(await db.durableEdits.count()).toBe(0);
  });

  it('refuses a folder of a different project before any plan', async () => {
    start({ 'src/pages/index.astro': HOME });
    const doc = newDoc();
    await expect(createLocalDocPage(doc, 'wc://browser_other', 'About')).rejects.toThrow(/different project/);
    expect(doc.getMap('pages').size).toBe(0);
  });
});

// task-148: page DELETE is the same law in reverse — the REAL file goes first,
// the doc row only follows a confirmed plan. And it is UNDOABLE: the plan
// hands back the file's bytes, which ride a structural undo entry (the same
// UndoContext stack the rest of task-133 uses), so ⌘Z can write them back.
describe('deleteLocalDocPage (task-148)', () => {
  const seed = (): Y.Doc => {
    const doc = newDoc();
    applyCommand(doc, { type: 'ADD_PAGE', page: { id: 'index', name: '/', rootElementIds: [], children: [] } });
    applyCommand(doc, { type: 'ADD_PAGE', page: { id: 'about', name: '/about', rootElementIds: [], children: [] } });
    return doc;
  };
  const startSite = () => start({ 'src/pages/index.astro': HOME, 'src/pages/about.astro': CONTENT });

  it('plans the real file removal FIRST, then the doc page; the file leaves disk', async () => {
    const rt = startSite();
    const order: string[] = [];
    const real = fileAcceptance.preparePageFilePlan;
    const plan = vi.spyOn(fileAcceptance, 'preparePageFilePlan').mockImplementation(async (f, intent) => {
      order.push('plan'); return real(f, intent);
    });
    const doc = seed();
    doc.getMap('pages').observe(() => order.push('doc'));

    await deleteLocalDocPage(doc, folder, 'about');

    expect(order).toEqual(['plan', 'doc']);
    expect(plan).toHaveBeenCalledWith(folder, { action: 'delete', pageId: 'about' });
    expect(doc.getMap('pages').has('about')).toBe(false);
    expect(doc.getMap('pages').has('index')).toBe(true);
    await settle();
    expect(existsSync(join(rt.root, 'src/pages/about.astro'))).toBe(false);
  });

  it('pushes ONE structural undo entry whose inverse carries the file bytes', async () => {
    startSite();
    const pushed: unknown[] = [];
    await deleteLocalDocPage(seed(), folder, 'about', (r) => pushed.push(r));

    expect(pushed).toEqual([{
      structuralOp: {
        forward: [{ kind: 'page-delete', folder, pageId: 'about', route: '/about', file: 'src/pages/about.astro' }],
        inverse: [{
          kind: 'page-restore', folder, pageId: 'about', route: '/about',
          file: 'src/pages/about.astro', content: CONTENT,
        }],
      },
    }]);
  });

  it('announces sq:local-page-deleted so the session pages list drops the mapping', async () => {
    startSite();
    const events: Array<Record<string, unknown>> = [];
    const listener = (e: Event): void => { events.push((e as CustomEvent<Record<string, unknown>>).detail); };
    window.addEventListener('sq:local-page-deleted', listener);
    try {
      await deleteLocalDocPage(seed(), folder, 'about');
    } finally {
      window.removeEventListener('sq:local-page-deleted', listener);
    }
    expect(events).toEqual([{ route: '/about', file: 'src/pages/about.astro' }]);
  });

  it('planner refusal → throws, doc untouched, nothing announced, NO undo entry', async () => {
    // A dynamic route cannot be deleted from here.
    const rt = start({ 'src/pages/index.astro': HOME, 'src/pages/[slug].astro': CONTENT });
    const events: unknown[] = [];
    const pushed: unknown[] = [];
    const listener = (e: Event): void => { events.push((e as CustomEvent).detail); };
    window.addEventListener('sq:local-page-deleted', listener);
    const doc = newDoc();
    applyCommand(doc, { type: 'ADD_PAGE', page: { id: 'index', name: '/', rootElementIds: [], children: [] } });
    applyCommand(doc, { type: 'ADD_PAGE', page: { id: '[slug]', name: '/[slug]', rootElementIds: [], children: [] } });
    try {
      await expect(deleteLocalDocPage(doc, folder, '[slug]', (r) => pushed.push(r))).rejects.toThrow(/dynamic/i);
    } finally {
      window.removeEventListener('sq:local-page-deleted', listener);
    }
    expect(doc.getMap('pages').has('[slug]')).toBe(true);
    expect(events).toEqual([]);
    expect(pushed).toEqual([]);
    expect(await db.durableEdits.count()).toBe(0);
    expect(rt.read('src/pages/[slug].astro')).toBe(CONTENT);
  });

  it('network failure → throws, doc untouched', async () => {
    startSite();
    setLocalTransport({ projectPath: folder, fetch: () => Promise.reject(new Error('offline')) });
    const doc = seed();
    await expect(deleteLocalDocPage(doc, folder, 'about')).rejects.toThrow(/offline/);
    expect(doc.getMap('pages').has('about')).toBe(true);
  });

  // An older instance build could plan without bytes. The doc must still
  // follow the accepted file removal (no ghost row) — but nothing undoable is
  // offered, because there is nothing to write back.
  it('a plan without bytes still deletes the doc page but pushes NO undo entry', async () => {
    startSite();
    const real = fileAcceptance.preparePageFilePlan;
    vi.spyOn(fileAcceptance, 'preparePageFilePlan').mockImplementation(async (f, intent) => {
      const planned = await real(f, intent); delete planned.content; return planned;
    });
    const pushed: unknown[] = [];
    const doc = seed();
    await deleteLocalDocPage(doc, folder, 'about', (r) => pushed.push(r));
    expect(doc.getMap('pages').has('about')).toBe(false);
    expect(pushed).toEqual([]);
  });
});

// Owner, 2026-08-10: deleting a /works/<slug> page toasted "No page file
// matches this page" — a dynamic-instance post page has no page file; its
// file IS the post MDX. Deleting the page must delete the POST.
describe('deleteLocalDocPage — dynamic-instance post pages', () => {
  const POST = '---\ntitle: Timepad\n---\nbody\n';
  const seedWithPost = (): Y.Doc => {
    const doc = newDoc();
    applyCommand(doc, { type: 'ADD_PAGE', page: { id: 'index', name: '/', rootElementIds: [], children: [] } });
    applyCommand(doc, { type: 'ADD_PAGE', page: { id: 'works-timepad-redesign', name: '/works/timepad-redesign', rootElementIds: [], children: [] } });
    return doc;
  };
  const startWithPost = () => start({
    'src/pages/index.astro': HOME,
    'src/pages/works/[slug].astro': HOME,
    'src/content/works/Timepad-Redesign.mdx': POST,
  });

  it('deletes the POST, not a page file, and drops the doc row', async () => {
    const rt = startWithPost();
    vi.spyOn(contentOps, 'fetchCollections').mockResolvedValue([
      { name: 'works', posts: [{ slug: 'Timepad-Redesign', frontmatter: {}, body: '' }], inferredFields: [] },
    ] as never);
    const plan = vi.spyOn(fileAcceptance, 'preparePageFilePlan');
    const doc = seedWithPost();

    await deleteLocalDocPage(doc, folder, 'works-timepad-redesign');

    expect(plan).toHaveBeenCalledWith(folder, { action: 'delete-post', collection: 'works', slug: 'Timepad-Redesign' });
    expect(plan).not.toHaveBeenCalledWith(folder, expect.objectContaining({ action: 'delete' }));
    expect(doc.getMap('pages').has('works-timepad-redesign')).toBe(false);
    await settle();
    expect(existsSync(join(rt.root, 'src/content/works/Timepad-Redesign.mdx'))).toBe(false);
    expect(rt.read('src/pages/works/[slug].astro')).toBe(HOME);
  });

  // Owner 2026-11-10: delete anything AND undo — a post page goes at once (no question, never a native confirm) and
  // its undo snapshot owns the post's exact bytes and the row (one ⌘Z; real replay in deleteUndo.test.tsx).
  it('deletes at once and hands the claimed undo snapshot the post bytes and the pre-delete row', async () => {
    startWithPost();
    const native = vi.spyOn(window, 'confirm');
    vi.spyOn(contentOps, 'fetchCollections').mockResolvedValue([
      { name: 'works', posts: [{ slug: 'Timepad-Redesign', frontmatter: {}, body: '' }], inferredFields: [] },
    ] as never);
    const doc = seedWithPost();
    let staged = false;
    const undoEntry = { attachFiles: vi.fn(), commit: vi.fn(),
      stage: vi.fn((s: Y.Doc) => { staged = s.getMap('pages').has('works-timepad-redesign'); }) };

    await deleteLocalDocPage(doc, folder, 'works-timepad-redesign', undefined, () => undoEntry);

    expect(undoEntry.attachFiles).toHaveBeenCalledWith([expect.objectContaining({
      file: 'src/content/works/Timepad-Redesign.mdx', beforeSource: POST, afterSource: null })]);
    expect(staged).toBe(true); // captured BEFORE the row went: ⌘Z brings the row back
    expect(undoEntry.commit).toHaveBeenCalledTimes(1);
    expect(doc.getMap('pages').has('works-timepad-redesign')).toBe(false);
    expect(native).not.toHaveBeenCalled();
  });
});
