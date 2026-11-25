import { useEffect, useRef, useCallback } from 'react';
import { t } from '@/i18n';
import * as Y from 'yjs';
import type { Project, Page, PagesTree, PageComponent } from '@/api/types';
import { isLocalProjectId, findLocalProjectEntry, localPageId, PROJECT_NOT_READY, discoverPagesFromPaths, markFilesTruth } from '@/utils/localMode';
import { listProjectFilePaths } from '@/db/projectFiles';
import { seedLocalVariables } from './localVariablesSeed';
import { classDataToYMap } from './createEditorDoc';
import type { ClassData } from './types';
import { collectionToYMap } from './collectionCommands';
import { rebuildMasters } from './masters';
import { migrateLayoutToPageLevel } from './migrations/migrateLayoutToPageLevel';
import { migrateLayoutPropsToSeo } from './migrations/migrateLayoutPropsToSeo';
import { dropLayoutMasterVersion } from './migrations/dropLayoutMasterVersion';
import { migratePostBodyBindingToElement } from './migrations/migratePostBodyBindingToElement';
import { stampHomePage } from './migrations/stampHomePage';
import { adoptOrphanPages } from './migrations/adoptOrphanPages';
import { coerceSeoValueToYjs } from './seoCoercion';
import { COMPONENT_EDITOR_PAGE_ID } from './constants';
import { db } from '@/db';
import { restoreLocalSourceScanState, sortByLocalPageOrder } from '@/utils/localPageSync';
import { loadDocLocalFirst, dropEphemeralEditorPage, repairMetaAfterRestore } from './persistence/migrateLegacyToYDoc';
import type { LocalPersistenceHandle } from './persistence/YjsLocalPersistence';

/**
 * An id with no Dexie row is not a project on this device: a stale bookmark
 * (the removed host-folder disk's `local_…` urls, 2026-09-10), a wiped
 * browser, a typo. The Editor turns this into a redirect to the Projects page
 * — never the recovery banner, which offers nothing the user can do.
 */
/** Leave the editor for Projects; a `notice` tells the user why (an unknown id needs none). */
export class ProjectNotFoundError extends Error {
  constructor(readonly projectId: string, readonly notice?: string) {
    super(notice ?? 'This project does not exist on this device.');
    this.name = 'ProjectNotFoundError';
  }
}

/** Read the legacy Dexie project shape. Import-only source since task-086. */
async function readLegacyBrowserProject(projectId: string): Promise<Project> {
  const dbProject = await db.projects.get(projectId);
  if (!dbProject) throw new Error(`Project ${projectId} not found in IndexedDB`);

  const dbPages = await db.pages.where('projectId').equals(projectId).toArray();
  const pagesMap: Record<string, { _id: string; name: string; components: any[]; metadata: any; layoutName?: string | null; layoutProps?: Record<string, string>; seo?: Record<string, unknown>; isHome?: boolean }> = {};
  for (const p of dbPages) {
    // Ephemeral editor page: never restore (see the createSavePage guard).
    // Old sessions may have persisted a stale row — drop it here too.
    if (p.id === COMPONENT_EDITOR_PAGE_ID) continue;
    pagesMap[p.id] = {
      _id: p.id,
      name: p.name,
      components: p.components || [],
      metadata: p.metadata || null,
      layoutName: p.layoutName ?? null,
      layoutProps: p.layoutProps ?? {},
      seo: p.seo ?? undefined,
      isHome: p.isHome ?? undefined,
    };
  }

  return {
    _id: projectId,
    name: dbProject.name,
    pagesTree: dbProject.pagesTree,
    pages: pagesMap,
    masters: dbProject.masters,
    contentCollections: dbProject.contentCollections,
  };
}

/**
 * Local-first browser load (task-086): bind y-indexeddb, wait for the stored
 * doc, and only run the legacy Dexie import on a project's FIRST open (the
 * migration flag lives in the doc). Idempotent self-heal migrations run on
 * both paths. Marks the project doc-durable, which turns the legacy Dexie
 * writers into no-ops. Exported for tests.
 */
export async function loadBrowserProjectLocalFirst(
  projectId: string,
  doc: Y.Doc
): Promise<{ project: Project; handle: LocalPersistenceHandle | null; source: 'fresh-migration' | 'from-local' | 'legacy-no-idb' }> {
  // Environments without IndexedDB (some test setups): pure legacy path,
  // no durability marking — behavior identical to pre-task-086.
  if (typeof indexedDB === 'undefined') {
    const project = await readLegacyBrowserProject(projectId);
    hydrateFromProject(doc, project);
    runSelfHealMigrations(doc);
    return { project, handle: null, source: 'legacy-no-idb' };
  }

  let legacyProject: Project | null = null;
  const { handle, source } = await loadDocLocalFirst(projectId, doc, async (d) => {
    legacyProject = await readLegacyBrowserProject(projectId);
    hydrateFromProject(d, legacyProject);
  });
  await restoreLocalSourceScanState(projectId);

  // The raw doc persists everything — including the ephemeral component-editor
  // page the Dexie path filtered out. Mirror that guard on every load.
  dropEphemeralEditorPage(doc);

  let project: Project;
  if (legacyProject) {
    project = legacyProject;
  } else {
    const dbRow = await db.projects.get(projectId);
    // The createEditorDoc meta seeds race the restored meta (clientID coin
    // flip) — repair before anything reads currentPageId/projectId.
    repairMetaAfterRestore(doc, projectId, dbRow?.name);
    if (!dbRow) {
      // Remote-hydrated on this device: create the Dexie row so the project
      // shows up in the projects list (the list reads db.projects only).
      await db.projects.put({
        id: projectId,
        name: (doc.getMap('meta').get('projectName') as string) || 'Untitled',
        pagesTree: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    project = {
      _id: projectId,
      name:
        dbRow?.name ??
        ((doc.getMap('meta').get('projectName') as string) || 'Untitled'),
      pagesTree: dbRow?.pagesTree ?? [],
      pages: {},
    } as Project;
  }

  runSelfHealMigrations(doc);

  return { project, handle, source };
}

/**
 * task-132 local mode: the doc page rows for a folder's discovered routes.
 *
 * Blind review 2026-08-05: local listed `/` with no `Home` pill while WC/server
 * badged theirs — the seed literal simply never carried `isHome`, and the local
 * load path skips runSelfHealMigrations (so stampHomePage never ran either).
 * A files-truth project DOES have a home page: the `/` route, backed by the
 * real src/pages/index.astro. Stamping the SAME flag every other runtime uses
 * lights the SAME badge in PageTreeNode — no local-only chrome.
 *
 * The test is on the ROUTE, not on position: a folder with no `/` route has no
 * home page, and guessing one (stampHomePage's "first root page" fallback)
 * would badge a page whose file is not index.astro.
 */
export function buildLocalSeedPages(
  localPages: Array<{ route: string }>,
): Record<string, { name: string; components: []; isHome?: true }> {
  return Object.fromEntries(localPages.map(p => [
    localPageId(p.route),
    { name: p.route, components: [] as [], ...(p.route === '/' ? { isHome: true as const } : {}) },
  ]));
}

/**
 * task-132 local mode: nest discovered concrete instances of a dynamic route
 * ('/works/petcubetracker') as CHILDREN of the page whose content links them,
 * and drop the '[slug]' placeholder page (the instances represent it — all of
 * them render the same template file, so editing any of them edits it).
 * Additive (never clears overlays); 'hydrate' origin like the seeding it
 * extends. Idempotent per path.
 */
export function seedLocalDynamicPages(
  doc: Y.Doc,
  instances: Array<{ route: string; parentRoute: string; paths: string[] }>,
): void {
  doc.transact(() => {
    const pages = doc.getMap('pages');
    const rootPages = doc.getArray<string>('rootPages');
    const meta = doc.getMap('meta');
    for (const inst of instances) {
      if (!inst.paths.length) continue;
      const placeholderId = localPageId(inst.route);
      const parent = pages.get(localPageId(inst.parentRoute)) as Y.Map<unknown> | undefined;
      const attachTo = parent ? (parent.get('children') as Y.Array<string>) : null;
      for (const path of inst.paths) {
        const id = localPageId(path);
        if (pages.has(id)) continue;
        const yPage = new Y.Map();
        yPage.set('id', id);
        yPage.set('name', path);
        yPage.set('rootElementIds', new Y.Array());
        yPage.set('children', new Y.Array<string>());
        pages.set(id, yPage);
        if (attachTo) attachTo.push([id]);
        else rootPages.push([id]);
      }
      if (pages.has(placeholderId)) {
        pages.delete(placeholderId);
        const idx = rootPages.toArray().indexOf(placeholderId);
        if (idx >= 0) rootPages.delete(idx, 1);
        if (meta.get('currentPageId') === placeholderId) {
          meta.set('currentPageId', localPageId(inst.paths[0]));
        }
      }
    }
  }, 'hydrate');
}

/**
 * The inverse of seedLocalDynamicPages: a post deleted from the Content tab
 * shrinks discovery's dynamicInstances, but seeding only ADDS — its stale page
 * row sat in the Pages tree until reload. Remove doc pages that look like
 * dynamic instances (`/x/y` names) but are no longer in any instance's paths.
 *
 * staticRoutes (the /__sq/local/pages routes, which include dynamic
 * placeholder routes like '/works/[slug]') protects real pages: a genuine
 * static /x/y page must survive. Detaches the id from its parent's children /
 * rootPages, mirroring how seeding attached it; if the pruned page was
 * current, currentPageId moves to the first remaining root page (mirroring
 * seeding's placeholder-delete repair). 'hydrate' origin like the seeding it
 * inverts.
 */
export function pruneLocalDynamicPages(
  doc: Y.Doc,
  instances: Array<{ route: string; parentRoute: string; paths: string[] }>,
  staticRoutes: string[],
): void {
  const keep = new Set<string>(staticRoutes);
  for (const inst of instances) for (const p of inst.paths) keep.add(p);
  doc.transact(() => {
    const pages = doc.getMap('pages');
    const rootPages = doc.getArray<string>('rootPages');
    const meta = doc.getMap('meta');
    const doomed: string[] = [];
    pages.forEach((page, id) => {
      const name = (page as Y.Map<unknown>).get('name');
      if (typeof name !== 'string') return;
      if (!/^\/[^/]+\/[^/]+$/.test(name)) return; // only instance-shaped names
      if (keep.has(name)) return;
      doomed.push(id);
    });
    if (!doomed.length) return;
    for (const id of doomed) {
      pages.delete(id);
      const ri = rootPages.toArray().indexOf(id);
      if (ri >= 0) rootPages.delete(ri, 1);
      pages.forEach(p => {
        const children = (p as Y.Map<unknown>).get('children') as Y.Array<string> | undefined;
        if (!children) return;
        const ci = children.toArray().indexOf(id);
        if (ci >= 0) children.delete(ci, 1);
      });
    }
    if (doomed.includes(meta.get('currentPageId') as string) && rootPages.length > 0) {
      meta.set('currentPageId', rootPages.get(0));
    }
  }, 'hydrate');
}

/** The six idempotent doc-shape self-heal migrations, in their load order. */
function runSelfHealMigrations(doc: Y.Doc): void {
  // Self-heal legacy pages built on the old synthetic-layout-instance model:
  // convert each to page.layoutName + flat content roots. Idempotent.
  migrateLayoutToPageLevel(doc);
  migrateLayoutPropsToSeo(doc);
  // Drop the dead bespoke layout-version key (replaced by the derived
  // layout-chrome element's masterVersion).
  dropLayoutMasterVersion(doc);
  // Convert legacy postPageBindings 'body' entries into real
  // collection-content slot elements. Idempotent.
  migratePostBodyBindingToElement(doc);
  // Stamp the explicit home-page flag on projects predating it (preserves
  // the legacy name-magic root route). Idempotent.
  stampHomePage(doc);
  // Adopt pages the pre-fix AI add_page tool left out of rootPages
  // (invisible orphans). Idempotent.
  adoptOrphanPages(doc);
}

interface UseProjectSyncOptions {
  projectId: string;
  doc: Y.Doc;
  onLoaded?: (project: Project) => void;
  onError?: (error: Error) => void;
}

/** Phase 6.2 auto-migration switch — tests of the doc-truth load path turn it off. */
export const autoMigration = { enabled: true };

export function useProjectSync({
  projectId,
  doc,
  onLoaded,
  onError,
}: UseProjectSyncOptions) {
  const projectRef = useRef<Project | null>(null);
  const onLoadedRef = useRef(onLoaded);
  const onErrorRef = useRef(onError);
  const hasLoadedRef = useRef(false);
  onLoadedRef.current = onLoaded;
  onErrorRef.current = onError;

  // Load the project: the local runtime seeds from files; a legacy doc-truth
  // browser_ project migrates itself to files and reloads (Phase 6.2).
  const loadProject = useCallback(async () => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    try {
      // The mirror hook resolves asynchronously in this same mount. Await
      // the authoritative row before choosing any legacy hydration/export:
      // a missing/unwritable localStorage marker never makes files disposable.
      {
        const row = await db.projects.get(projectId);
        if (row?.filesTruth) markFilesTruth(projectId);
        // No row and not a resolved files-truth project: nothing to load.
        if (!row && !isLocalProjectId(projectId)) {
          onErrorRef.current?.(new ProjectNotFoundError(projectId));
          return;
        }
      }
      // Files are truth, the doc is a disposable session working-copy: NO
      // y-indexeddb or legacy doc persistence — pages are seeded from the real
      // src/pages and rebuilt from files on every open (task-132 design §1).
      if (isLocalProjectId(projectId)) {
        const entry = findLocalProjectEntry(projectId);
        if (!entry) throw new Error(PROJECT_NOT_READY);
        // The instance is not up yet on first render — seed from the Dexie
        // projectFiles keys (same rule as the server walk, parity-tested);
        // useLocalInstance refetches once running.
        // Accepted scan evidence, awaited before onLoaded mounts the canvas: without
        // it every scan is stamped revision 0 and refused as 'not owned' (2026-11-17).
        const restored = restoreLocalSourceScanState(projectId);
        const [paths, row] = await Promise.all([listProjectFilePaths(projectId), db.projects.get(projectId)]);
        const project: Project = {
          _id: projectId,
          name: row?.name ?? entry.name,
          pagesTree: [],
          pages: buildLocalSeedPages(sortByLocalPageOrder(discoverPagesFromPaths(paths), row?.pageOrder)),
        } as unknown as Project;
        hydrateFromProject(doc, project);
        // Phase 3.2: the REAL variables file re-seeds the panel (the doc forgot).
        await seedLocalVariables(doc, projectId);
        await restored;
        projectRef.current = project;
        onLoadedRef.current?.(project);
        return;
      }

      // A doc-truth project from the retired browser runtime: the desktop app
      // cannot convert it in place (the converter ran in the browser). It comes
      // in through Export ZIP (old app) → Import (here).
      const { project, handle } = await loadBrowserProjectLocalFirst(projectId, doc);
      handle?.destroy?.();
      if (!autoMigration.enabled || !projectId.startsWith('browser_') || !(await db.projects.get(projectId))) {
        // Tests of the legacy load path only.
        projectRef.current = project;
        onLoadedRef.current?.(project);
        return;
      }
      throw new ProjectNotFoundError(projectId, t('This project was made with an older version of Starquix and cannot be opened here. Export it as a ZIP from that version, then use Import.'));
    } catch (error) {
      onErrorRef.current?.(error as Error);
    }
  }, [projectId, doc]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  return { loadProject };
}



/** Serialize Y.Map classOverrides to plain object for API */
function serializeClassOverrides(
  classOverrides: Y.Map<unknown> | undefined
): Record<string, Record<string, string[]>> {
  if (!classOverrides || classOverrides.size === 0) return {};
  return Object.fromEntries(
    Array.from(classOverrides.entries()).map(([k, v]) => [k, (v as Y.Map<unknown>).toJSON()])
  );
}

/** Serialize a Y.Map of nested Y.Maps to a plain object, or return undefined if empty */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeYMapDeep(yMap: Y.Map<unknown> | undefined): Record<string, any> | undefined {
  if (!yMap || yMap.size === 0) return undefined;
  return Object.fromEntries(
    Array.from(yMap.entries()).map(([k, v]) => [k, (v as Y.Map<unknown>).toJSON()])
  );
}

/** Serialize a Y.Map to a plain object via toJSON, or return undefined if empty */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeYMap(yMap: Y.Map<unknown> | undefined): Record<string, any> | undefined {
  if (!yMap || yMap.size === 0) return undefined;
  return yMap.toJSON();
}

/** Serialize a Y.Array to a plain array, or return undefined if empty */
function serializeYArray(yArray: Y.Array<string> | undefined): string[] | undefined {
  if (!yArray || yArray.length === 0) return undefined;
  return yArray.toArray();
}

/** Convert a plain object to a nested Y.Map structure */
function objectToYMap(obj: Record<string, unknown>): Y.Map<unknown> {
  const yMap = new Y.Map();
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      // Convert arrays to Y.Array for proper Yjs compatibility
      const yArray = new Y.Array();
      yArray.push(value);
      yMap.set(key, yArray);
    } else if (value !== null && typeof value === 'object') {
      yMap.set(key, objectToYMap(value as Record<string, unknown>));
    } else {
      yMap.set(key, value);
    }
  }
  return yMap;
}

/** Rebuild the page.seo Y.Map from a plain JSON object. Uses the same
 *  coerceSeoValueToYjs primitive as the UPDATE_PAGE_SEO command so a
 *  save -> hydrate round-trip reproduces the exact same Y structure. */
function hydrateSeoMap(yPage: Y.Map<unknown>, seo: Record<string, unknown>): void {
  const seoMap = new Y.Map();
  for (const [field, value] of Object.entries(seo)) {
    if (value === null || value === undefined) continue;
    seoMap.set(field, coerceSeoValueToYjs(value));
  }
  yPage.set('seo', seoMap);
}

/** Convert a plain string record to Y.Map<string> for markupOverrides */
function stringMapToYMap(obj: Record<string, string>): Y.Map<string> {
  const yMap = new Y.Map<string>();
  for (const [key, value] of Object.entries(obj)) {
    yMap.set(key, value);
  }
  return yMap;
}

/**
 * Validate the shape of a Project before hydration so we don't half-clear the
 * doc on bad input. Yjs `doc.transact()` does NOT roll back operations when
 * the body throws — once the clear-existing-state step runs, the doc is
 * destructively modified even if a later step fails. The defense is to refuse
 * to start hydration unless the input has the structural fields we rely on.
 *
 * Throws an Error describing the first problem found.
 */
export function validateProjectForHydration(project: unknown): asserts project is Project {
  if (!project || typeof project !== 'object') {
    throw new Error('hydrateFromProject: project is not an object');
  }
  const p = project as Partial<Project>;
  if (typeof p._id !== 'string' || p._id.length === 0) {
    throw new Error('hydrateFromProject: project._id is missing or not a string');
  }
  if (typeof p.name !== 'string') {
    throw new Error('hydrateFromProject: project.name is missing or not a string');
  }
  if (!p.pages || typeof p.pages !== 'object' || Array.isArray(p.pages)) {
    throw new Error('hydrateFromProject: project.pages is missing or not an object');
  }
  for (const [pageId, pageData] of Object.entries(p.pages)) {
    if (!pageData || typeof pageData !== 'object') {
      throw new Error(`hydrateFromProject: page "${pageId}" is not an object`);
    }
    const pd = pageData as { name?: unknown; components?: unknown };
    if (typeof pd.name !== 'string') {
      throw new Error(`hydrateFromProject: page "${pageId}" has invalid name`);
    }
    // components may be undefined (defaulted to []) but if present must be an array
    if (pd.components !== undefined && pd.components !== null && !Array.isArray(pd.components)) {
      throw new Error(`hydrateFromProject: page "${pageId}".components is not an array`);
    }
    if (Array.isArray(pd.components)) {
      for (let i = 0; i < pd.components.length; i++) {
        const c = pd.components[i];
        if (!c || typeof c !== 'object') {
          throw new Error(`hydrateFromProject: page "${pageId}".components[${i}] is not an object`);
        }
        if (typeof (c as { id?: unknown }).id !== 'string') {
          throw new Error(`hydrateFromProject: page "${pageId}".components[${i}].id is missing or not a string`);
        }
      }
    }
  }
  // pagesTree is optional; if present it must be an array of nodes with string ids
  if (p.pagesTree !== undefined && p.pagesTree !== null) {
    if (!Array.isArray(p.pagesTree)) {
      throw new Error('hydrateFromProject: project.pagesTree is not an array');
    }
    const walk = (nodes: unknown[], path: string): void => {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i] as { id?: unknown; children?: unknown };
        if (!n || typeof n !== 'object') {
          throw new Error(`hydrateFromProject: ${path}[${i}] is not an object`);
        }
        if (typeof n.id !== 'string') {
          throw new Error(`hydrateFromProject: ${path}[${i}].id is missing or not a string`);
        }
        if (n.children !== undefined && n.children !== null) {
          if (!Array.isArray(n.children)) {
            throw new Error(`hydrateFromProject: ${path}[${i}].children is not an array`);
          }
          walk(n.children as unknown[], `${path}[${i}].children`);
        }
      }
    };
    walk(p.pagesTree as unknown[], 'project.pagesTree');
  }
}

// Hydrate Yjs doc from project data
export function hydrateFromProject(doc: Y.Doc, project: Project): void {
  // Validate input BEFORE clearing any state. Yjs doc.transact() does not
  // roll back on throw, so we must refuse bad input up-front rather than
  // partway through and leave the doc half-cleared. See task-019.
  validateProjectForHydration(project);

  doc.transact(() => {
    const meta = doc.getMap('meta');
    const pages = doc.getMap('pages');
    const elements = doc.getMap('elements');

    // Set project info
    meta.set('projectId', project._id);
    meta.set('projectName', project.name);

    // Clear existing data
    pages.forEach((_, key) => pages.delete(key));
    elements.forEach((_, key) => elements.delete(key));

    // Clear source tracking maps — these accumulate entries on every iframe scan
    // and must be reset on project reload to prevent stale entries from prior sessions
    const sourceClasses = doc.getMap('sourceClasses');
    const sourceText = doc.getMap('sourceText');
    const sourceImageAttributes = doc.getMap('sourceImageAttributes');
    const sourceLinkAttributes = doc.getMap('sourceLinkAttributes');
    sourceClasses.forEach((_, key) => sourceClasses.delete(key));
    sourceText.forEach((_, key) => sourceText.delete(key));
    sourceImageAttributes.forEach((_, key) => sourceImageAttributes.delete(key));
    sourceLinkAttributes.forEach((_, key) => sourceLinkAttributes.delete(key));

    // Unified-component masters overlay: clear stale entries and rebuild from the
    // persisted project shape. Absent (lazy-seeded / pre-feature) = stays empty.
    rebuildMasters(doc, project.masters);

    // Content collections (project-import): the CollectionsPanel lists the
    // DOC's contentCollections for browser_ projects, so a collection that
    // only exists as mounted files would be invisible. Seed-once semantics —
    // hydration runs on first open only (loadBrowserProjectLocalFirst).
    const contentCollections = doc.getMap('contentCollections');
    for (const c of project.contentCollections ?? []) {
      if (!contentCollections.has(c.id)) contentCollections.set(c.id, collectionToYMap(c));
    }

    // Add pages (without hierarchy first)
    for (const [pageId, pageData] of Object.entries(project.pages)) {
      const yPage = new Y.Map();
      yPage.set('id', pageId);
      yPage.set('name', pageData.name);

      // Restore structural layout fields. Guard so absent/empty values don't
      // clobber selectPageLayout's defaults for legacy pages saved without them.
      const { layoutName, layoutProps } = pageData;
      if (layoutName) yPage.set('layoutName', layoutName);
      if (layoutProps && Object.keys(layoutProps).length > 0) yPage.set('layoutProps', layoutProps);

      // Restore page.seo (plain JSON mirror) into a nested Y.Map. Guard so
      // absent/empty seo leaves the page seo-less, matching legacy pages.
      const seo = pageData.seo;
      if (seo && Object.keys(seo).length > 0) hydrateSeoMap(yPage, seo);

      // Restore the explicit home-page flag. Guard so absent/false leaves the
      // page unflagged (stampHomePage re-derives for legacy projects).
      if (pageData.isHome) yPage.set('isHome', true);

      const rootElementIds: string[] = [];

      // Convert components to elements (defensive check for undefined)
      (pageData.components || []).forEach((component, index) => {
        const elementId = component.id;
        rootElementIds.push(elementId);

        const yElement = new Y.Map();
        yElement.set('id', elementId);
        yElement.set('pageId', pageId);
        yElement.set('parentId', null);
        yElement.set('index', index);

        // Handle instance vs legacy component types
        const componentWithType = component as {
          type?: string;
          // Local instance fields
          templateId?: string;
          overrides?: Record<string, Record<string, unknown>>;
          // Theme instance fields
          themeId?: string;
          componentPath?: string;
          classOverrides?: Record<string, Record<string, string[]>>;
          markupOverrides?: Record<string, string>;
          staticMarkup?: string;
          // Link override fields
          hrefOverrides?: Record<string, { href: string; target?: string }>;
          linkOverrides?: Record<string, Record<string, unknown>>;
          linkAttributes?: Record<string, unknown>;
          // Image override fields
          imageOverrides?: Record<string, Record<string, unknown>>;
          imageAttributes?: Record<string, unknown>;
          // Deletion and ordering overrides
          deletedSelectors?: string[];
          orderOverrides?: string[];
          // Unified overrides (Override API v2)
          unifiedOverrides?: Record<string, Record<string, unknown>>;
          // Astro source path
          astroSource?: string;
        };

        // Hydrate shared override fields onto a Yjs element
        const hydrateOverrides = (yEl: Y.Map<unknown>, c: typeof componentWithType) => {
          if (c.markupOverrides) yEl.set('markupOverrides', stringMapToYMap(c.markupOverrides));
          // hrefOverrides is a legacy field — no runtime code reads it from Yjs.
          // Migrate to unifiedOverrides so selectLinkAttributes can see the data.
          if (c.linkOverrides) yEl.set('linkOverrides', objectToYMap(c.linkOverrides));
          if (c.linkAttributes) yEl.set('linkAttributes', objectToYMap(c.linkAttributes));
          if (c.imageOverrides) yEl.set('imageOverrides', objectToYMap(c.imageOverrides));
          if (c.imageAttributes) yEl.set('imageAttributes', objectToYMap(c.imageAttributes));
          if (c.deletedSelectors?.length) yEl.set('deletedSelectors', Y.Array.from(c.deletedSelectors));
          if (c.orderOverrides?.length) yEl.set('orderOverrides', Y.Array.from(c.orderOverrides));
          if (c.hrefOverrides || c.unifiedOverrides) {
            const merged: Record<string, Record<string, unknown>> = {};
            if (c.unifiedOverrides) {
              for (const [k, v] of Object.entries(c.unifiedOverrides)) {
                merged[k] = { ...(v as Record<string, unknown>) };
              }
            }
            if (c.hrefOverrides) {
              for (const [selector, hrefData] of Object.entries(c.hrefOverrides)) {
                if (!merged[selector]) merged[selector] = {};
                if (!merged[selector].href) merged[selector].href = hrefData;
              }
            }
            yEl.set('unifiedOverrides', objectToYMap(merged));
          }
          if (c.astroSource) yEl.set('astroSource', c.astroSource);
        };

        // Identify instance type by data fields, not just the 'type' field
        // This handles legacy data that was saved without proper 'type'
        if (componentWithType.themeId) {
          // Theme instance - has themeId
          yElement.set('type', 'instance');
          yElement.set('themeId', componentWithType.themeId);
          yElement.set('componentPath', componentWithType.componentPath);
          yElement.set('classOverrides', objectToYMap(componentWithType.classOverrides || {}));
          if (componentWithType.overrides) {
            yElement.set('overrides', objectToYMap(componentWithType.overrides));
          }
          if (componentWithType.staticMarkup) {
            yElement.set('staticMarkup', componentWithType.staticMarkup);
          }
          hydrateOverrides(yElement, componentWithType);
        } else if (componentWithType.templateId) {
          // Local instance - has templateId
          yElement.set('type', 'instance');
          yElement.set('templateId', componentWithType.templateId);
          yElement.set('overrides', objectToYMap(componentWithType.overrides || {}));
          hydrateOverrides(yElement, componentWithType);
        } else if (
          (componentWithType.classOverrides && Object.keys(componentWithType.classOverrides).length > 0) ||
          componentWithType.overrides ||
          componentWithType.markupOverrides ||
          componentWithType.hrefOverrides ||
          componentWithType.linkOverrides ||
          componentWithType.imageOverrides ||
          componentWithType.imageAttributes ||
          componentWithType.linkAttributes ||
          componentWithType.deletedSelectors?.length ||
          componentWithType.orderOverrides?.length ||
          componentWithType.unifiedOverrides
        ) {
          // Built-in component with overrides (class, text, markup, or link - no themeId/templateId)
          yElement.set('type', 'instance');
          yElement.set('componentType', component.name);
          if (componentWithType.classOverrides) {
            yElement.set('classOverrides', objectToYMap(componentWithType.classOverrides));
          }
          if (componentWithType.overrides) {
            yElement.set('overrides', objectToYMap(componentWithType.overrides));
          }
          if (component.staticMarkup) {
            yElement.set('staticMarkup', component.staticMarkup);
          }
          hydrateOverrides(yElement, componentWithType);
        } else {
          // Legacy component (no overrides)
          yElement.set('type', 'component');
          yElement.set('componentType', component.name);
          if (component.staticMarkup) {
            yElement.set('staticMarkup', component.staticMarkup);
          }
          if (componentWithType.astroSource) {
            yElement.set('astroSource', componentWithType.astroSource);
          }
        }

        // Default empty classes
        const defaultClasses: ClassData = {
          base: [],
          sm: [],
          md: [],
          lg: [],
          xl: [],
          '2xl': [],
        };
        const yClasses = classDataToYMap(defaultClasses);
        yElement.set('classes', yClasses);

        elements.set(elementId, yElement);
      });

      yPage.set('rootElementIds', Y.Array.from(rootElementIds));
      yPage.set('children', new Y.Array<string>());  // Will be populated from pagesTree
      pages.set(pageId, yPage);
    }

    // Clear rootPages array
    const rootPages = doc.getArray('rootPages');
    rootPages.delete(0, rootPages.length);

    // Restore hierarchy from pagesTree (filtering out orphaned entries)
    const existingPageIds = new Set(Object.keys(project.pages));

    if (project.pagesTree && project.pagesTree.length > 0) {
      // Filter tree to only include pages that exist in project.pages
      const filterTree = (nodes: PagesTree[]): PagesTree[] => {
        return nodes
          .filter(node => existingPageIds.has(node.id))
          .map(node => ({
            ...node,
            children: filterTree(node.children)
          }));
      };

      const filteredTree = filterTree(project.pagesTree);

      // Helper to set children for a page from tree node
      const processTreeNode = (node: PagesTree) => {
        const yPage = pages.get(node.id) as Y.Map<unknown> | undefined;
        if (yPage && node.children.length > 0) {
          const childIds = node.children.map(c => c.id);
          const yChildren = yPage.get('children') as Y.Array<string>;
          yChildren.push(childIds);
          // Recursively process children
          node.children.forEach(processTreeNode);
        }
      };

      // Add root page IDs and process their children
      const rootIds = filteredTree.map(node => node.id);
      if (rootIds.length > 0) {
        rootPages.push(rootIds);
        filteredTree.forEach(processTreeNode);
      } else {
        // All pages were orphaned, fall through to default
        const pageIds = Object.keys(project.pages);
        rootPages.push(pageIds);
      }
    } else {
      // No tree structure - add all pages as root pages
      const pageIds = Object.keys(project.pages);
      if (pageIds.length === 0) {
        // Create default page if none exist
        const defaultPageId = 'page-home';
        const yPage = new Y.Map();
        yPage.set('id', defaultPageId);
        yPage.set('name', 'Home');
        yPage.set('isHome', true);
        yPage.set('rootElementIds', new Y.Array());
        yPage.set('children', new Y.Array<string>());
        pages.set(defaultPageId, yPage);
        rootPages.push([defaultPageId]);
      } else {
        rootPages.push(pageIds);
      }
    }

    // Set first page as current — but NEVER clobber a selection the user has
    // already made and that still exists.
    //
    // Wrong-file-write root cause (live-smoke Critical, local mode): the
    // Editor subtree remounts during startup (StrictMode double-mount, plus a
    // later remount as the local instance flips to running), and each remount
    // re-runs loadProject → hydrateFromProject with fresh refs. An
    // unconditional reset silently reverted a page the user had just clicked
    // back to the index page: the canvas and Layers stayed on the old page
    // while currentPageFile followed the doc, and the next ⌘K/draw/delete
    // wrote into the WRONG real file (observed: `<Card />` landed in the
    // previous page's index.astro).
    //
    // Preserved only when the id still resolves in the freshly built pages
    // map, so a project switch or a deleted page still falls back to the
    // first page.
    if (rootPages.length > 0) {
      const existing = meta.get('currentPageId') as string | null;
      if (!existing || !pages.has(existing)) {
        meta.set('currentPageId', rootPages.get(0) as string);
      }
    }
  }, 'hydrate');
}
