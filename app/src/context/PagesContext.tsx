import { sourceActionFailure, type SourceAction } from '@/utils/sourceActionFeedback';
import { t } from '@/i18n';
/**
 * Pages Context
 *
 * Manages page navigation and UI state for the pages panel.
 * Coordinates with Yjs store for data, provides UI state (active page, expanded nodes).
 */

import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import * as Y from 'yjs';
import { useYjsValue, useEditorDoc, useDurableDispatch, useSessionDispatch } from '@/store/hooks';
import { acceptDocumentMutation } from '@/store/documentMutation';
import { selectAllPages, selectRootPageIds, selectCurrentPageId, selectProjectId, selectPostPageInvariantViolations, selectLandingPageId, selectAncestorPageIds } from '@/store/selectors';
import { selectContentCollections } from '@/store/collectionSelectors';
import { applyCommand } from '@/store/commands';
import { createLocalDocPage, deleteLocalDocPage } from '@/store/localPages';
import { renameLocalDocPage, LOCAL_HOME_IS_INDEX, saveLocalPageOrder } from '@/utils/localPageSync';
import { isLocalProjectId, findLocalProjectEntry, PROJECT_NOT_READY } from '@/utils/localMode';
import toast from 'react-hot-toast';
import { setHomePageAndPersist } from '@/store/homePage';
import { useUndoContext } from './UndoContext';
import { generatePageId } from '@/utils/generateId';
import type { PageData } from '@/store/types';
import { stableContext } from '@/utils/stableContext';

// ============================================================================
// Types
// ============================================================================

export interface PagesState {
  /** Currently active/viewing page ID */
  activePageId: string | null;
  /** Expanded page IDs in tree (UI-only state) */
  expandedIds: Set<string>;
}

export interface PagesContextValue extends PagesState {
  /** All pages from Yjs */
  pages: PageData[];
  /** Root page IDs in order */
  rootPageIds: string[];

  /** Set the active page */
  setActivePage: (pageId: string) => void;
  /** Toggle expanded state of a page */
  toggleExpanded: (pageId: string) => void;
  /** Expand specific pages */
  expandPages: (pageIds: string[]) => void;
  /** Create a new page */
  createPage: (name: string, parentId?: string) => Promise<string>;
  /** Delete a page and its children */
  deletePage: (pageId: string) => Promise<void>;
  /** Rename a page */
  renamePage: (pageId: string, name: string) => Promise<void>;
  /** Make this page the home page (exports as index.astro) */
  setHomePage: (pageId: string) => Promise<void>;
  /** Move a page to new parent/position */
  movePage: (pageId: string, newParentId: string | null, index: number) => Promise<void>;
}

const PagesContext = stableContext<PagesContextValue | null>('PagesContext', null);

// ============================================================================
// Provider
// ============================================================================

interface PagesProviderProps {
  children: React.ReactNode;
}

export const PagesProvider: React.FC<PagesProviderProps> = ({ children }) => {
  const doc = useEditorDoc();
  const { takeSnapshot, claimSnapshot, pushStructuralUndo } = useUndoContext();
  const dispatch = useDurableDispatch();
  const sessionDispatch = useSessionDispatch();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Read from Yjs
  const pages = useYjsValue(selectAllPages);
  const rootPageIds = useYjsValue(selectRootPageIds);
  const activePageId = useYjsValue(selectCurrentPageId);
  const projectId = useYjsValue(selectProjectId);
  const collections = useYjsValue(selectContentCollections);
  const feedbackOwner = useMemo(() => ({ doc, projectId }), [doc, projectId]);
  const currentFeedbackOwner = useRef(feedbackOwner);
  currentFeedbackOwner.current = feedbackOwner;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const showSourceFailure = useCallback((action: SourceAction, error: unknown) => {
    console.error('Page source action failed:', action, error);
    if (mounted.current && currentFeedbackOwner.current === feedbackOwner) toast.error(sourceActionFailure(action, error));
  }, [feedbackOwner]);


  // task-036 1:1 lock: fail LOUDLY when the doc violates the detail-page ↔
  // collection invariant instead of silently rendering broken post routes.
  // Diagnostic only — no UI. May flash once mid collection-creation if the
  // collection and its detail page ever land in separate render batches.
  useEffect(() => {
    for (const v of selectPostPageInvariantViolations(doc)) {
      console.error(`[PagesContext] Invariant violation: ${v.message}`);
    }
  }, [doc, pages, collections]);

  // Land on a page the user can actually SEE. The restored currentPageId can be
  // a blog detail page, which has no row in the tree: clicking a post navigates
  // there so it gets persisted, but the post that fills it in (previewPost) is
  // in-memory and null on open — so the editor opened on bare placeholders with
  // nothing highlighted in Pages (owner, 2026-08-13). ONCE, at mount: navigating
  // to a detail page by clicking a post must keep working.
  const landingApplied = useRef(false);
  useEffect(() => {
    if (landingApplied.current) return;
    if (pages.length === 0) return; // doc not hydrated yet
    const landing = selectLandingPageId(doc);
    landingApplied.current = true;
    if (!landing) return;
    // A nested landing page needs its ancestors open, or the row is off screen
    // and the panel again looks like nothing is selected (useGoToPost expands
    // for the same reason).
    const ancestors = selectAncestorPageIds(doc, landing);
    if (ancestors.length) setExpandedIds(prev => new Set([...prev, ...ancestors]));
    if (landing !== activePageId) {
      sessionDispatch({ type: 'SET_CURRENT_PAGE', pageId: landing });
    }
  }, [doc, pages, activePageId, sessionDispatch]);

  const setActivePage = useCallback((pageId: string) => {
    sessionDispatch({ type: 'SET_CURRENT_PAGE', pageId });
  }, [sessionDispatch]);

  const toggleExpanded = useCallback((pageId: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(pageId)) {
        next.delete(pageId);
      } else {
        next.add(pageId);
      }
      return next;
    });
  }, []);

  const expandPages = useCallback((pageIds: string[]) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      pageIds.forEach(id => next.add(id));
      return next;
    });
  }, []);

  const createPage = useCallback(async (name: string, parentId?: string): Promise<string> => {
    // task-145 local mode: files are truth — write the REAL src/pages file
    // first; the doc page follows only on success. A doc-only page has no
    // route: it aliased the index in the iframe and edits there source-wrote
    // the real index file. (parentId nesting is a doc-tree concept the file
    // system doesn't have — ignored here. No takeSnapshot: its own structural
    // undo step deletes the file and the row together, #17.)
    if (projectId && isLocalProjectId(projectId)) {
      const entry = findLocalProjectEntry(projectId);
      if (!entry) {
        toast.error(PROJECT_NOT_READY);
        return '';
      }
      // 'New Page', not the caller's "Page ${count}" — the doc page count
      // includes nested dynamic instances (a 9-page site produced "Page 10"),
      // and the server suffixes to the first free slug anyway.
      return await createLocalDocPage(doc, entry.path, 'New Page', pushStructuralUndo).catch((e) => {
        showSourceFailure('create-page', e);
        return '';
      });
    }

    takeSnapshot();

    const id = generatePageId();
    const page: PageData = {
      id,
      name,
      rootElementIds: [],
      children: [],
    };

    try { await acceptDocumentMutation(doc, doc => {
      // ADD_PAGE registers the page in rootPages itself; MOVE_PAGE re-homes
      // it under the parent (and removes the rootPages entry).
      applyCommand(doc, { type: 'ADD_PAGE', page });

      if (parentId) {
        const currentPages = selectAllPages(doc);
        const parentPage = currentPages.find(p => p.id === parentId);
        if (parentPage) {
          applyCommand(doc, {
            type: 'MOVE_PAGE',
            pageId: id,
            newParentId: parentId,
            index: parentPage.children.length
          });
        } else {
          // Parent doesn't exist — page stays at root (ADD_PAGE already registered it)
          console.warn(`Parent page ${parentId} not found, adding to root`);
        }
      }
    }, claimSnapshot()); } catch (error) {
      showSourceFailure('create-page', error);
      return '';
    }

    return id;
  }, [doc, projectId, takeSnapshot, claimSnapshot, pushStructuralUndo, showSourceFailure]);

  const deletePage = useCallback(async (pageId: string) => {
    // task-148 local mode: files are truth — the REAL src/pages file is
    // removed FIRST and the doc row follows only on success. A doc-only
    // delete left the file on disk, so the page re-seeded from
    // /__sq/local/pages on the next open (live-caught: six orphan
    // new-page*.astro files). NO takeSnapshot: the delete pushes a STRUCTURAL
    // undo entry carrying the file's bytes instead (⌘Z writes them back and
    // re-adds the row) — a doc snapshot on top would double-push and make ⌘Z
    // lie about what it restored. A POST page instead deletes its post file:
    // that one claims the snapshot (file + row, one ⌘Z) and pushes no
    // structural entry. DELETE_PAGE itself moves currentPageId to the first
    // remaining root page when the deleted page was open.
    if (projectId && isLocalProjectId(projectId)) {
      const entry = findLocalProjectEntry(projectId);
      if (!entry) {
        toast.error(PROJECT_NOT_READY);
        return;
      }
      await deleteLocalDocPage(doc, entry.path, pageId, pushStructuralUndo, () => { takeSnapshot(); return claimSnapshot(); }).catch((e) => {
        showSourceFailure('delete-page', e);
      });
      return;
    }

    if (pages.length <= 1) return;
    takeSnapshot();
    await dispatch({ type: 'DELETE_PAGE', pageId }).catch(error => showSourceFailure('delete-page', error));
  }, [doc, projectId, pages.length, dispatch, pushStructuralUndo, takeSnapshot, claimSnapshot, showSourceFailure]);

  const renamePage = useCallback(async (pageId: string, name: string) => {
    // Gap 23 local mode: files are truth — the REAL src/pages file is renamed
    // FIRST (host endpoint) and the doc row is rekeyed only on success. A
    // doc-only RENAME_PAGE displayed a route that didn't exist and evaporated
    // on reopen. Its own structural undo step moves the file back (createPage law).
    if (projectId && isLocalProjectId(projectId)) {
      const entry = findLocalProjectEntry(projectId);
      if (!entry) {
        toast.error(PROJECT_NOT_READY);
        return;
      }
      await renameLocalDocPage(doc, entry.path, pageId, name, pushStructuralUndo).catch((e) => {
        showSourceFailure('rename-page', e);
      });
      return;
    }

    takeSnapshot();
    await dispatch({ type: 'RENAME_PAGE', pageId, name }).catch(error => showSourceFailure('rename-page', error));
  }, [doc, projectId, dispatch, takeSnapshot, pushStructuralUndo, showSourceFailure]);

  const setHomePage = useCallback(async (pageId: string) => {
    // Gap 24 local mode: home is whatever src/pages/index.astro serves. The
    // doc flag is session-only (savePageNow no-ops, seeding re-stamps '/'),
    // so flipping it would make the Home badge lie until reopen — and a file
    // swap is too destructive to do silently. Honest refusal, badge unmoved.
    if (projectId && isLocalProjectId(projectId)) {
      toast.error(LOCAL_HOME_IS_INDEX);
      return;
    }

    // Shared with the AI set_home_page tool — store/homePage.ts owns the
    // "persist BOTH affected pages" invariant (task-060).
    await setHomePageAndPersist({
      doc,
      dispatch,
      takeSnapshot,
      pageId,
    }).catch(error => { console.error('Home page edit failed', error); toast.error(t("Home page was not saved")); });
  }, [doc, projectId, dispatch, takeSnapshot]);

  const movePage = useCallback(async (pageId: string, newParentId: string | null, index: number) => {
    // Gap 26 local mode: routes can't nest (a page's place in the tree is its
    // file path) — a drop ONTO a page does nothing. Root reorders persist via
    // the rootPages observer below.
    if (projectId && isLocalProjectId(projectId) && newParentId !== null) return;

    takeSnapshot();
    await dispatch({ type: 'MOVE_PAGE', pageId, newParentId, index })
      .catch(error => { console.error('Page move failed', error); toast.error(t("Page order was not saved")); });
  }, [projectId, dispatch, takeSnapshot]);

  // Gap 26: a local project's root order lives on its project row (src/pages
  // has none). Observing rootPages covers drag, undo/redo and the AI tool.
  useEffect(() => {
    if (!projectId || !isLocalProjectId(projectId)) return;
    const rootPages = doc.getArray<string>('rootPages');
    const save = () => { void saveLocalPageOrder(doc, projectId).catch(err => console.warn('[pages] order not saved', err)); };
    rootPages.observe(save);
    return () => rootPages.unobserve(save);
  }, [doc, projectId]);

  // One-time cleanup: remove duplicate post pages (keep first per collection)
  const cleanedRef = useRef(false);
  useEffect(() => {
    if (cleanedRef.current || !projectId) return;
    cleanedRef.current = true;

    const yPages = doc.getMap('pages');
    const ppBindings = doc.getMap('postPageBindings');
    const seenCollections = new Map<string, string>(); // collectionId → kept pageId
    const toDelete: string[] = [];

    yPages.forEach((v, pageId) => {
      const yp = v as Y.Map<unknown>;
      const colId = yp.get('collectionId') as string | undefined;
      const isPost = yp.get('pageType') === 'post' || colId || ppBindings.has(pageId) || yp.get('name') === 'Post Page';
      if (!isPost) return;

      const resolvedColId = colId
        || (ppBindings.get(pageId) as Y.Map<unknown>)?.get('collectionId') as string;
      if (!resolvedColId) { toDelete.push(pageId); return; } // orphan with no collection — delete

      if (seenCollections.has(resolvedColId)) {
        toDelete.push(pageId);
      } else {
        seenCollections.set(resolvedColId, pageId);
      }
    });

    if (toDelete.length > 0) {
      void acceptDocumentMutation(doc, staged => {
        const yPages = staged.getMap('pages');
        const ppBindings = staged.getMap('postPageBindings');
        for (const pageId of toDelete) {
          // Remove from parent children
          yPages.forEach((v) => {
            const children = (v as Y.Map<unknown>).get('children') as Y.Array<string> | undefined;
            if (!children) return;
            const arr = children.toArray();
            const idx = arr.indexOf(pageId);
            if (idx !== -1) children.delete(idx, 1);
          });
          // Remove from rootPages
          const rootPages = staged.getArray('rootPages');
          const rootArr = rootPages.toArray() as string[];
          const rootIdx = rootArr.indexOf(pageId);
          if (rootIdx !== -1) rootPages.delete(rootIdx, 1);
          // Delete page and bindings
          ppBindings.delete(pageId);
          yPages.delete(pageId);
        }
      }).catch(error => { console.error('Post page cleanup was not saved', error); });
    }
  }, [doc, projectId]);

  // Listen for sq:expand-page events (e.g. when a post page is auto-created)
  useEffect(() => {
    const handler = (e: Event) => {
      const pageId = (e as CustomEvent).detail?.pageId;
      if (pageId) expandPages([pageId]);
    };
    window.addEventListener('sq:expand-page', handler);
    return () => window.removeEventListener('sq:expand-page', handler);
  }, [expandPages]);

  const value = useMemo<PagesContextValue>(() => ({
    activePageId,
    expandedIds,
    pages,
    rootPageIds,
    setActivePage,
    toggleExpanded,
    expandPages,
    createPage,
    deletePage,
    renamePage,
    setHomePage,
    movePage,
  }), [
    activePageId,
    expandedIds,
    pages,
    rootPageIds,
    setActivePage,
    toggleExpanded,
    expandPages,
    createPage,
    deletePage,
    renamePage,
    setHomePage,
    movePage,
  ]);

  return (
    <PagesContext.Provider value={value}>
      {children}
    </PagesContext.Provider>
  );
};

// ============================================================================
// Hooks
// ============================================================================

export const usePages = (): PagesContextValue => {
  const context = useContext(PagesContext);
  if (!context) {
    throw new Error('usePages must be used within a PagesProvider');
  }
  return context;
};
