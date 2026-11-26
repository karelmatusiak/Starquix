import { ImageIcon as SharedImageIcon, PlusIcon as SharedPlusIcon } from '@/assets/icons';
import { t } from '@/i18n';
import { editorMetricsEnabled, recordEditorMetric } from '@/performance/editorMetrics';
import { useRef, useEffect, useLayoutEffect, useCallback, useState, useMemo } from 'react';
import { Button, OperationNotice } from '@/components/ui';
import { frameUnderstandsIntents, planSettleMessage } from '@/services/classIntents';
import { getMaterializationStatus, subscribeMaterializationStatus } from '@/services/durableEdits/materializer';
import { useYjsValue, useDispatch, useEditorDoc, useScopedYjsValue, useCurrentPageId, useProjectId, useCurrentThemeMode } from '@/store/hooks';
import { acceptEditorCommands } from '@/store/commandGesture';
import { isRenderStateEmpty, selectCurrentPageId, selectCurrentThemeMode, selectOriginalSourceText, selectPageDrawnElements, selectPageLayout, selectPostPageByCollectionId, selectPostPageRenderData, selectProjectId, selectRootElementIds } from '@/store/selectors';
import { resolveCanvasFocus, layoutSelectionRect } from './canvasFocus';
import { pageLayoutElementId } from '@/store/layoutElement';
import type { Breakpoint, GridGeometry } from '@/store/types';
import { BREAKPOINT_ORDER, BREAKPOINTS, parseKey } from '@/store/types';
import { GridOverlay } from './GridOverlay';
import { PixelGridOverlay } from './PixelGridOverlay';
import { LayoutGridOverlay } from './LayoutGridOverlay';
import { getCellRect, dragTargetCell, gridOfChild } from '@/utils/gridGeometry';
import type { SelectionVariant } from './SelectionOverlay';
import { ViewportSelectionOverlay, ElementGeometryOverlay, LayoutSelectionGeometry } from './ViewportSelectionOverlay';
import { selectionVariantForKey, selectionVariantOf } from './selectionVariant';
import { ImageUploadOverlay } from './ImageUploadOverlay';
import { MultiSelectionRects } from './MultiSelectionRects';
import { useScannedElements, useScannedElementsRef, useSelectionContext, useRectActions, useTextSelection, type ScannedElement } from '@/context/SelectionContext';
import { useClassStore } from '@/context';
import { viteClassWriter } from '@/services/ViteClassWriter';
import { useAgentCanvasKeys } from '@/services/agentCanvasActivity';
import { getClassWriteBaseline, setClassWriteBaseline } from '@/services/classWriteBaseline';
import { viteTextWriter } from '@/services/ViteTextWriter';
import { viteMediaWriter } from '@/services/ViteMediaWriter';
import { viteStructuralWriter } from '@/services/ViteStructuralWriter';
import { viteImageWriter } from '@/services/ViteImageWriter';
import { useUndoContext } from '@/context/UndoContext';
import { resolveBlogPostCanvasHtml } from '@/utils/blogPostTemplate';
import { useGoToPost } from '@/hooks/useGoToPost';
import { buildPreviewSrc, localOverridesFragment, localNativeRoute, normalizeLocalRoute, resolveLocalIframeSrc, type LocalIframeSrcDecision } from './previewSrc';
import { LocalNavigationSync } from './localNavigationSync';
import { handlePreviewNavigate } from './viewportMessages/previewNavigation';
import { matchPendingSelect } from './viewportMessages/scanning';
import { selectOptionsFor } from '@/utils/selectOptions';
import { reloadPreviewFromSource, setPreviewUrlProvider } from './reloadPreview';
import { handleTextDraft, rememberFrameWindow, wasFrameWindow } from './viewportMessages/textDrafts';
import {
  applyClassRestore,
  applyImageAttrRestore,
  RESTORE_CLASSES_RELAY,
  RESTORE_IMAGE_ATTRS_RELAY,
  type ClassRestoreRequest,
  type ImageAttrRestoreRequest,
} from './restoreOverrides';
import { diffSourceText } from './sourceTextSync';
import { LINK_MARKUP_FIELD } from '@/store/sourceOverrideEntries';
import { isLocalProjectId, findLocalProjectEntry } from '@/utils/localMode';
import { deriveLockTier, lockLabel } from '@/components/DesignBar/lockTier';
import { hoverRectStore } from './hoverRectStore';
import { altKeyStore } from './altKeyStore';
import { isGridRelevantSelection } from './gridRequestGate';
import { BootCoverOverlay } from './BootCoverOverlay';
import { SQ_BOUNDARY_PARAM } from '@/bridge/boundaryParam';
import { sourceErrorDetail, type SourceErrorStatus } from './viewportMessages/sourceStatus';
import { wrapPostPageInBlogPost } from '@/utils/wrapPostPageInBlogPost';
import { ensureBlogPostMasterSeeded } from '@/utils/ensureBlogPostMaster';
import { computeDrawnElementDiff, createMicrotaskCoalescer } from './drawnElementSync';
import { markAssetRelayReady, markAssetRelayTorndown } from '@/utils/assetTransfer';
import { isPublishedPost } from '@/core/collections/isPublishedPost';
import type { LocalInstanceLite } from '@/hooks/useLocalInstance';
import { useContentCollections } from '@/hooks/useContentCollections';
import { selectContentCollections } from '@/store/collectionSelectors';
import { useComponentLibrary } from '@/hooks/useComponentLibrary';
import { usePostEditor } from '@/context/PostEditorContext';
import { contentEntryOf } from '@/core/collections/postFileName';
import { usePages } from '@/context/PagesContext';
import { postBodyFallbackHtml } from '@/utils/mdxFallbackHtml';
import { loadPostViewHtml } from '@/components/PostEditor/loadPostViewHtml';
import * as Y from 'yjs';
import { COMPONENT_EDITOR_PAGE_ID as COMPONENT_PAGE_ID } from '@/store/constants';
import { ArtboardSizing } from './artboardSizing';
import { DEVICE_OF, SCREEN_PRESETS, setScreenHeight, useScreenHeight } from './viewportHeightPreferences';
import { ScreenHeightHandle } from './ScreenHeightHandle';
import { handleViewportWheel } from './viewportWheel';
import type { ContentHeightPayload, UpdateClassesPayload } from '@/bridge/types';
import { buildMessageHandlers } from './viewportMessages/registry';
import { AIGlowRings } from './AIGlowRings';
import type { ViewportMessageContext } from './viewportMessages/context';
import type {
  ElementRect,
  KeyedRect,
} from '@/bridge';
import toast from 'react-hot-toast';
import { layerMenu } from '@/components/Editor/layerMenuStore';
import { useSourceTextPersistence, restoreSourceText } from '@/hooks/useSourceTextPersistence';
import {
  useSourceClassesPersistence,
  useSourceImageAttrsPersistence,
  restoreSourceClasses,
  restoreSourceImageAttrs,
  keySchemeSetAsideNotice,
} from '@/hooks/useSourceOverridesPersistence';

export type { ElementRect };

const GRID_TOKEN_RE = /^(col|row)-(start|end|span)-(\d+)$/;
const WEST_HANDLES = new Set(['w', 'nw', 'sw']);
const NORTH_HANDLES = new Set(['n', 'nw', 'ne']);
const ZERO_OFFSET = { x: 0, y: 0 } as const;

/**
 * Parse grid placement values (col-start, col-span, etc.) from class tokens,
 * cascading through breakpoints up to the active one.
 */
function parseGridPlacement(
  classTokens: string[],
  activeBreakpoint: typeof BREAKPOINT_ORDER[number],
): Record<string, number | null> {
  const activeBpIndex = BREAKPOINT_ORDER.indexOf(activeBreakpoint);
  const parsed: Record<string, number | null> = {
    'col-start': null, 'col-end': null, 'col-span': null,
    'row-start': null, 'row-end': null, 'row-span': null,
  };

  for (let bpIdx = 0; bpIdx <= activeBpIndex; bpIdx++) {
    const prefix = BREAKPOINT_ORDER[bpIdx] === 'base' ? '' : `${BREAKPOINT_ORDER[bpIdx]}:`;
    for (const token of classTokens) {
      const bare = prefix === ''
        ? (!token.includes(':') ? token : null)
        : (token.startsWith(prefix) ? token.slice(prefix.length) : null);
      if (!bare) continue;

      const m = bare.match(GRID_TOKEN_RE);
      if (m) parsed[`${m[1]}-${m[2]}`] = parseInt(m[3], 10);
    }
  }

  return parsed;
}

/**
 * Gaps 27/55 (post-canvas parity): slice the REAL astro render of a post
 * out of the `/__sq_post_view/{collection}/{slug}` page — the same route the
 * post editor's component previews already read — so the
 * canvas body of a post design page is the MDX pipeline's output (components
 * render, imports invisible, data-sq-block/body-line stamps present), not a
 * marked() lookalike.
 *
 * Returns `<style>…</style>` + the `[data-sq-post-body]` grid (outerHTML, so
 * the .sq-post-grid class and its width contract survive), or null when the
 * route errored / has no body — callers fall back to markdownToHtml then.
 * Styles carried: the route's own inline grid CSS and astro-cid scoped
 * component CSS; vite-dev global styles (tailwind base) are excluded — the
 * design page already loads its own (componentPreview.ts precedent).
 * No URL absolutizing: unlike the editor-origin chips, this HTML is injected
 * back INTO the same-origin iframe, where root-relative srcs already resolve.
 */
export function extractPostViewBody(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (doc.querySelector('[data-sq-post-error]')) return null;
  const body = doc.querySelector('[data-sq-post-body]');
  if (!body) return null;
  const css = Array.from(doc.querySelectorAll('style'))
    .filter(s => !s.hasAttribute('data-vite-dev-id'))
    .filter(s => {
      const text = s.textContent ?? '';
      return text.includes('.sq-post-grid') || text.includes('astro-cid');
    })
    .map(s => `<style>${s.textContent ?? ''}</style>`)
    .join('');
  return css + body.outerHTML;
}

/** Build prefixed token string for one grid axis (col or row) during span changes. */
function buildAxisTokens(
  bpPrefix: string,
  axis: 'col' | 'row',
  start: number,
  spanToken: string,
  emitStart: boolean,
): string {
  const tokens: string[] = [];
  if (emitStart) tokens.push(`${bpPrefix}${axis}-start-${start}`);
  if (spanToken) tokens.push(`${bpPrefix}${spanToken}`);
  return tokens.join(' ');
}


interface ViewportFrameProps {
  breakpoint: Breakpoint;
  scale?: number;
  /** Whether a drag operation is in progress (passed to SelectionOverlay) */
  isDragging?: boolean;
  /** Whether a draw tool is active (disables iframe pointer events) */
  isDrawing?: boolean;
  /** Whether a reorder just completed and positions haven't updated yet */
  isReorderPending?: boolean;
  onZoom?: (screenX: number, screenY: number, deltaY: number) => void;
  onPan?: (deltaX: number, deltaY: number) => void;
  /** task-132 local mode: spawned instance {status,url} — iframe loads the real route */
  localInstanceState?: LocalInstanceLite;
  /** task-132 local mode: current page's real route ('/about') */
  currentPagePath?: string | null;
  /** External ref to expose the iframe element for screenshot capture */
  externalIframeRef?: React.RefObject<HTMLIFrameElement | null>;
  /** Resolved layout bodies keyed by name — spliced into <slot>s by selectRenderState. */
  layoutBodies?: Map<string, string>;
  /** Pen node-edit mode: hide the selection bounds/handles under the path chrome (task-107). */
  suppressSelectionOverlay?: boolean;
  /** Double-click on a selected pen element's selection body — Canvas enters node-edit mode. */
  onPenEditRequest?: (key: string) => void;
  /**
   * Preview mode (task-116): the iframe goes full-window at 100% height with
   * native scroll, every editor overlay is dropped, and the bridge is told to
   * stop intercepting. Design: docs/plans/2026-07-16-preview-mode-design.md.
   */
  isPreview?: boolean;
}

type ParentMessage =
  | { type: 'REQUEST_ELEMENT_RECT'; elementId: string };

/**
 * Layout <slot> tags from a dropped layout's compiled output. They show up
 * in scannedElements with tagName='slot' but aren't tracked in Yjs (the slot
 * belongs to the layout's source file, not the page). We synthesize entries
 * so the drawn-slot overlay UI (the "Choose Component" button) renders on
 * top of empty layout slots.
 */
export function computeLayoutSlotElements(
  scannedElements: Array<{ key: string; tagName: string }>,
  filledLayoutInstanceMap: Record<string, true>,
): Array<{ key: string; slotType: 'layout' }> {
  return scannedElements
    .filter((el) => {
      if (el.tagName !== 'slot') return false;
      // Slot keys are `<ownerId>:slot-N`. Only layout-chrome slots
      // (`layoutchrome-<pageId>`, pageLayoutElementId) are fillable page
      // slots. A COMPONENT instance's markup can also carry literal <slot>
      // tags — composeSlotChildren leaves unfilled slots in place (e.g. a
      // bound BlogSlot's posts/pagination slots, filled by the blog pipeline
      // rather than Yjs children) — and those must not get the overlay.
      const layoutInstanceId = el.key.split(':')[0];
      if (!layoutInstanceId.startsWith('layoutchrome-')) return false;
      // Filled = the layout instance has at least one Yjs child on the page.
      return !filledLayoutInstanceMap[layoutInstanceId];
    })
    .map((el) => ({ key: el.key, slotType: 'layout' as const }));
}

export function ViewportFrame({ breakpoint, scale = 1, isDragging = false, isDrawing = false, isReorderPending = false, onZoom, onPan, localInstanceState, currentPagePath, externalIframeRef, layoutBodies, suppressSelectionOverlay = false, onPenEditRequest, isPreview = false }: ViewportFrameProps) {
  useLayoutEffect(() => {
    if (editorMetricsEnabled) recordEditorMetric('viewport-commit');
  });
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const isReadyRef = useRef(false);
  const dispatch = useDispatch();
  // task-116: PREVIEW_NAVIGATE resolves a clicked href against `pages` and
  // switches via the same setActivePage the sidebar uses.
  const { pages, setActivePage } = usePages();
  const goToPost = useGoToPost();

  // Explicit context for extracted iframe message handlers (viewportMessages/).
  // `.current` is reassigned every render (latest-ref pattern) further down,
  // after all refs/callbacks it references are declared.
  const messageCtxRef = useRef<ViewportMessageContext | null>(null);
  const messageHandlers = useMemo(() => buildMessageHandlers(), []);
  const localNavigationRef = useRef(new LocalNavigationSync());
  const localRescanRef = useRef<{ href: string; documentId?: string } | null>(null);
  const [localRouteEpoch, setLocalRouteEpoch] = useState(0);

  // task-120 (4.2): hoveredRect is NOT React state — hover events arrive at
  // pointer rate and re-rendered this whole component. SelectionOverlay
  // subscribes to hoverRectStore itself.
  const setHoveredRect = hoverRectStore.set;
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [isIframeReady, setIsIframeReady] = useState(false);
  const [sourceError, setSourceError] = useState<SourceErrorStatus | null>(null);

  // Sections an AI run is touching — rings are drawn in the canvas, not the
  // iframe, so the glow can bleed past the frame edge (see AIGlowRings).
  // Cleared by the bridge, not here: SET_PAGE reports an empty rect set and
  // finalizes any live preview, so a page switch mid-run cannot leave rings
  // floating (a page switch never reloads the iframe — task-120).
  const [aiGlowRects, setAIGlowRects] = useState<KeyedRect[]>([]);
  const [aiPreviewRect, setAIPreviewRect] = useState<ElementRect | null>(null);


  // Pending class updates, keyed by the FULL element key. A class-only edit
  // produces no ELEMENTS_SCANNED (no file write => no HMR, and the bridge's
  // MutationObserver ignores `class` mutations), so this queue is not
  // self-draining: it sits until the next scan and is replayed into it.
  //
  // task-181: it used to have a SECOND map keyed `file:line` — no column, no
  // placement — whose job was re-keying an element whose column drifted after a
  // write. `file:line` does not name an element: two placements of one
  // component, and the same component's page key vs its bare master-view key,
  // all collapse onto it, and the replay took the FIRST scanned match. Measured
  // live 2026-08-05: edit an instance's background on a page, open the master
  // view, and the master canvas painted the instance's colour. It was deleted
  // rather than tightened — no rule over `file:line` can separate a drifted
  // column from a different element on the same line — and the drift it existed
  // for cannot happen from a class write anyway (writing an element's own class
  // attribute never moves that element's own start column). What survives:
  // reapplySourceClassOverrides (exact-key doc re-apply on every scan) and
  // migratePlacementKeys (address changes).
  const pendingKeyUpdatesRef = useRef<Map<string, { key: string; classes: string }>>(new Map());

  // Scanned elements from iframe for ElementsTree
  const { scannedElements, setScannedElements, updateScannedElementRects, scannedByKey } = useScannedElements();
  // Empty-image receiver frames (rendered below) — memoized: ViewportFrame
  // re-renders far more often than scans arrive.
  const emptyImageElements = useMemo(
    () => scannedElements.filter(el => el.tagName === 'img' && el.imageSrc === '' && el.rect),
    [scannedElements],
  );
  // Context-owned ref (updated synchronously in setScannedElements) — handlers
  // read .current at call time; no local mirror needed.
  const { scannedElementsRef } = useScannedElementsRef();
  // Selection context for syncing with ElementsTree
  // contextKey, enterContext, exitContext come from SelectionContext (single source of truth)
  const {
    select: selectInContext,
    toggleInSelection,
    additionalSelections,
    patchSelection,
    clearSelection,
    setSelectionDocScope,
    selectedKey,
    selectedElementId,
    selectedKeyRef: selectionSelectedKeyRef,
    selectedElementIdRef: selectionSelectedElementIdRef,
    contextKeyRef: selectionContextKeyRef,
    contextKey,
    enterContext,
    exitContext,
    resetContext,
    isEditingText,
    enterEditMode,
    exitEditMode,
    reparentDragKey,
    setReparentDragKey,
    updateBgImagePreview,
    updateImagePreview,
  } = useSelectionContext();
  // High-frequency rect/hover from focused context (avoids re-rendering other consumers)
  const { updateSelectionRect } = useRectActions();
  // ClassStore for registering elements
  const { registerElement, getClassesFromYjs } = useClassStore();
  // Text selection for link editing
  const { setTextSelection, clearTextSelection, isLinkInteractingRef } = useTextSelection();
  // Undo context for taking snapshots before edits and detecting undo/redo
  const { takeSnapshot, claimSnapshot, isUndoingRef, pushStructuralUndo } = useUndoContext();
  // Yjs doc for observing text changes during undo
  const doc = useEditorDoc();
  const { openPost } = usePostEditor();

  // sq:pending-select: an element id (replace flow) or a master file (opened
  // from Assets / ↗) to select — immediately when already on the canvas,
  // else on the next scan (matchPendingSelect).
  const pendingSelectRef = useRef<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { elementId?: string | null; deferred?: boolean } | undefined;
      const id = (detail?.elementId || null) as string | null;
      pendingSelectRef.current = id;
      // Already on the canvas (re-selecting the open master in Assets — no scan
      // will follow): select now with the same prefix match the scan uses.
      // `deferred` = a new document is coming; the current scan is the wrong one.
      const el = id && !detail?.deferred ? matchPendingSelect(id, scannedElementsRef.current) : undefined;
      if (el) {
        pendingSelectRef.current = null;
        selectInContextRef.current(el.key, selectOptionsFor(el));
      }
    };
    window.addEventListener('sq:pending-select', handler);
    return () => window.removeEventListener('sq:pending-select', handler);
  }, []);

  // Queue for text writes that failed because scannedElements was stale during undo.
  // Flushed by a separate effect when scannedElements updates after iframe rescan.
  const pendingTextWritesRef = useRef<Map<string, string>>(new Map());

  // Observe sourceText for undo/redo - sync to source files.
  // Uses scannedElementsRef (not scannedElements) to avoid re-subscribing on every
  // rescan and to keep the prev-value cache stable across scannedElements changes.
  useEffect(() => {
    const sourceText = doc.getMap('sourceText');

    const readDoc = (): Record<string, string> => {
      const out: Record<string, string> = {};
      sourceText.forEach((entry, key) => {
        out[key] = ((entry as Y.Map<unknown>).get('textContent') as string) || '';
      });
      return out;
    };

    // The value each key had on the previous run. REBUILT from the doc every
    // run (never merged) — see sourceTextSync.ts for the Reset→⌘Z defect that
    // an in-place merge caused, and for why the class and image tiers, which
    // have always rebuilt theirs, never had it.
    let prevText: Record<string, string> = readDoc();

    const syncText = () => {
      const isUndoing = isUndoingRef.current;
      const { changed, removed, nextPrev } = diffSourceText(
        prevText,
        readDoc(),
        isUndoing,
      );
      prevText = nextPrev;

      for (const { key, textContent } of changed) {
        if (isUndoing) {
          // During undo/redo, the iframe still shows the pre-undo text — push update explicitly.
          // (Non-undo changes already reach the iframe via SYNC_TEXT_TO_IFRAME in commandTools.)
          iframeRef.current?.contentWindow?.postMessage({
            type: 'UPDATE_TEXT',
            payload: { key, textContent }
          }, '*');
        }

        // Files-truth text and its inverse are already part of acceptance.
        // The observer only projects them into the preview, never accepts a duplicate.
        if (isLocalProjectId(doc.getMap('meta').get('projectId') as string ?? '')) continue;
        // Write to source file for any programmatic text change (undo OR AI-initiated).
        // User-typed text is written by the EDIT_MODE_EXITED handler; this path handles the rest.
        const element = scannedElementsRef.current.find(el => el.key === key);
        if (element?.sourceLocation) {
          viteTextWriter.writeTextUpdate(element.sourceLocation, textContent)
            .catch(err => console.error('[ViewportFrame] Failed to write text:', err));
        } else if (isUndoing) {
          // During undo, element may be temporarily absent from the scan — queue for retry after rescan.
          pendingTextWritesRef.current.set(key, textContent);
        }
      }

      // Entries the undo REMOVED (undoing to a state before the element was ever
      // edited). Ask the iframe for the baseline it captured before it applied
      // the first override. This used to be limited to elements with NO
      // sourceLocation, on the assumption that "the file will be restored and
      // HMR will update" — which is false whenever the removal writes no bytes:
      // a doc-only overlay (local mode's component-owned elements) leaves the discarded text on screen until a full reload
      // (task-151). The handler is a no-op when the bridge holds no baseline,
      // so this can only add a repaint.
      for (const key of removed) {
        iframeRef.current?.contentWindow?.postMessage({
          type: 'RESTORE_ORIGINAL_TEXT',
          payload: { key }
        }, '*');
      }
    };

    sourceText.observeDeep(syncText);
    return () => {
      sourceText.unobserveDeep(syncText);
    };
  }, [doc]);

  // Undo/redo repaint for the markup tier (links, line-break paragraphs): a
  // live edit already mirrored the DOM, but a restored/removed carrier must be
  // pushed explicitly — the file write does not reload the frame. Same diff
  // as the text tier above; never a second write (acceptance owns the file).
  useEffect(() => {
    const carriers = doc.getMap('sourceLinkAttributes');
    // Read the raw field, not forEachSourceLinkAttrsEntry: that helper hides
    // source-owned carriers (markup already written to the file), which on the
    // files-truth runtime is every carrier — and exactly what undo restores.
    const readDoc = (): Record<string, string> => {
      const out: Record<string, string> = {};
      carriers.forEach((entry, key) => {
        const markup = (entry as Y.Map<unknown>).get(LINK_MARKUP_FIELD);
        if (typeof markup === 'string') out[key] = markup;
      });
      return out;
    };
    let prev = readDoc();
    const sync = () => {
      const isUndoing = isUndoingRef.current;
      const { changed, removed, nextPrev } = diffSourceText(prev, readDoc(), isUndoing);
      prev = nextPrev;
      if (!isUndoing) return;
      const win = iframeRef.current?.contentWindow;
      for (const { key, textContent } of changed) win?.postMessage({ type: 'UPDATE_SOURCE_MARKUP', payload: { key, markup: textContent } }, '*');
      for (const key of removed) win?.postMessage({ type: 'RESTORE_ORIGINAL_TEXT', payload: { key } }, '*');
    };
    carriers.observeDeep(sync);
    return () => { carriers.unobserveDeep(sync); };
  }, [doc, isUndoingRef]);

  // Flush pending text writes when scannedElements updates (after iframe rescan)
  useEffect(() => {
    if (isLocalProjectId(doc.getMap('meta').get('projectId') as string ?? '')) {
      pendingTextWritesRef.current.clear();
      return;
    }
    if (pendingTextWritesRef.current.size === 0) return;
    const pending = new Map(pendingTextWritesRef.current);
    for (const [key, textContent] of pending) {
      const element = scannedElements.find(el => el.key === key);
      if (element?.sourceLocation) {
        viteTextWriter.writeTextUpdate(element.sourceLocation, textContent)
          .catch(err => console.error('[ViewportFrame] Failed pending text write:', err));
        // Always dequeue — otherwise the queue leaks forever in dev
        pendingTextWritesRef.current.delete(key);
      }
    }
  }, [scannedElements]);

  // Clean up writer refs on unmount
  useEffect(() => {
    return () => {
      viteClassWriter.setIframeRef(null);
      viteTextWriter.setIframeRef(null);
      viteImageWriter.setIframeRef(null);
      viteMediaWriter.setIframeRef(null);
      viteStructuralWriter.setIframeRef(null);
    };
  }, []);

  const projectId = useProjectId();
  const currentPageId = useCurrentPageId();
  // Instance overrides (Figma model, owner ruling 2026-09-10): a class / text /
  // image edit on a component usage from a page view lives in the doc's source
  // tiers and must survive reopen — the doc itself is a disposable session copy.
  // Persist per project (localStorage, task-070/173 key-scheme guard) and
  // restore ONCE per project before the first scan re-apply paints them.
  useSourceTextPersistence(doc, projectId);
  useSourceClassesPersistence(doc, projectId);
  useSourceImageAttrsPersistence(doc, projectId);
  const restoredOverridesRef = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId || restoredOverridesRef.current === projectId) return;
    restoredOverridesRef.current = projectId;
    const setAsideNotice = keySchemeSetAsideNotice({
      text: restoreSourceText(doc, projectId),
      classes: restoreSourceClasses(doc, projectId),
      images: restoreSourceImageAttrs(doc, projectId),
    });
    if (setAsideNotice) toast(setAsideNotice, { icon: '⚠️', duration: 12000, id: `sq-key-scheme:${projectId}` });
  }, [doc, projectId]);
  // The page's applied layout name (or null) drives the canvas drill: the Layout
  // is the single editor-synthesized OUTERMOST selection level. Its real identity
  // is the layout-chrome instance root key (`layoutchrome-<pageId>`) — it has no
  // DOM node, so the bridge can never use it as a context (we map it to null).
  const { layoutName: currentLayoutName } = useScopedYjsValue((d) =>
    selectPageLayout(d, currentPageId ?? ''),
    [{ map: 'pages', keys: currentPageId ? [currentPageId] : [] }],
  );
  const layoutRootKey = currentLayoutName && currentPageId ? pageLayoutElementId(currentPageId) : null;
  // True only when the Layout root itself is selected (it has no DOM node, so it
  // keeps its synthesized union rect instead of being cleared). Guards must check
  // THIS, not `selectedKey !== layoutRootKey` — both are null on a non-laid-out
  // page, which would wrongly suppress the normal "clear selection" path.
  const isLayoutRootSelected = layoutRootKey !== null && selectedKey === layoutRootKey;
  // Selections made from now on belong to the current page (doc scope for
  // selectedDocId — see SelectionContext).
  useEffect(() => {
    setSelectionDocScope(currentPageId ?? null);
  }, [currentPageId, setSelectionDocScope]);

  // task-132 local mode: writer availability tracks the spawned instance's
  // lifecycle. Cleanup disarms so a swapped project can't write via a stale url.
  useEffect(() => {
    if (!localInstanceState) return;
    // task-140 trap: a writer missing from this list silently resolves false.
    const writers = [viteClassWriter, viteTextWriter, viteImageWriter, viteMediaWriter, viteStructuralWriter];
    for (const w of writers) w.setLocalInstanceState(localInstanceState);
    return () => { for (const w of writers) w.setLocalInstanceState(null); };
  }, [localInstanceState]);


  // Clear page-scoped parent state when the page changes. task-120: page
  // switches no longer navigate the iframe, so isIframeReady is NOT reset
  // here — it only flips on real iframe lifecycle (IFRAME_READY handler).
  useEffect(() => {
    // Clear pending updates to prevent memory leaks when navigating between pages
    pendingKeyUpdatesRef.current.clear();
    // Clear selection so overlay ghost doesn't persist across pages
    clearSelection();
    resetContext(); // Clear drill-down context from old page
    setHoveredRect(null);
  }, [currentPageId, projectId, clearSelection, resetContext]);

  // task-181: the SURFACE can change without the page id changing. Local mode's
  // master view (`/__sq_component_view/{file}`, task-136/137) re-points the
  // iframe route while `currentPageId` stays put, so the effect above never
  // fired for it and a class edit queued on the PAGE was replayed into the
  // master's scan — the master canvas painted an unpushed instance edit
  // (reproduced live 2026-08-05; one-shot, gone on the second visit, which is
  // exactly the signature of a parent ref surviving a navigation).
  //
  // The invariant is the one reloadPreviewFromSource and the page-change effect
  // already state: a queued class value belongs to the document it was queued
  // against and must never outlive it. Selection/context are deliberately NOT
  // touched here — entering the master view keeps its own selection flow.
  useEffect(() => {
    pendingKeyUpdatesRef.current.clear();
  }, [currentPagePath]);

  const width = BREAKPOINTS[breakpoint];

  // The design SCREEN height (per project, per device class): the artboard
  // floor AND what a vh means inside the frame (SET_MODE designViewportHeight
  // → bridge vh-pin). Set by the fold handle and the top-bar height menu.
  const screenDevice = DEVICE_OF[breakpoint];
  const designScreenHeight = useScreenHeight(projectId, screenDevice);
  const preferenceKey = String(designScreenHeight);
  const sizingScope = JSON.stringify([projectId, currentPageId, currentPagePath, localInstanceState?.url, breakpoint, isPreview]);
  const sizingRef = useRef<{ scope: string; preference: string; fit: ArtboardSizing } | null>(null);
  if (!sizingRef.current || sizingRef.current.scope !== sizingScope) {
    // Owner 2026-10-08 (supersedes 2026-09-24's hug-content): the artboard is
    // at least one screen tall, so the user sees the fold even on an empty page.
    sizingRef.current = { scope: sizingScope, preference: preferenceKey, fit: new ArtboardSizing(designScreenHeight) };
  } else if (sizingRef.current.preference !== preferenceKey) {
    sizingRef.current.preference = preferenceKey;
    sizingRef.current.fit.setFallback(designScreenHeight);
  }
  const [, refreshArtboard] = useState(0);
  const localViewportHeight = localInstanceState ? sizingRef.current.fit.height : null;
  const receiveContentHeight = (height: number, sample: ContentHeightPayload = { height }): void => {
    if (!localInstanceState) { setContentHeight(height); return; }
    if (isPreview || (sample.mode !== undefined && sample.mode !== 'design')) return;
    if (sample.viewportWidth !== undefined && sample.viewportWidth !== width) return;
    if (sample.href) {
      try {
        const actual = new URL(sample.href);
        const expected = new URL(currentPagePath || '/', localInstanceState.url || undefined);
        if (actual.origin !== expected.origin || normalizeLocalRoute(actual.pathname) !== normalizeLocalRoute(expected.pathname)) return;
      } catch { return; }
    }
    const sizing = sizingRef.current!;
    if (sample.viewportHeight !== undefined && sample.viewportHeight !== sizing.fit.height) return;
    const before = sizing.fit.height;
    const after = sizing.fit.measure(sample);
    if (after !== before) refreshArtboard(n => n + 1);
  };


  // Double click removes the manual floor and immediately uses the current
  // content measurement. The next bridge report continues automatic fitting.

  const sendToIframe = useCallback((message: ParentMessage) => {
    iframeRef.current?.contentWindow?.postMessage(message, '*');
  }, []);

  const sendToIframeBridge = useCallback((type: string, payload: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ type, payload }, '*');
  }, []);

  // Focus iframe and enter text edit mode for the given element key.
  // The iframe must be focused BEFORE the message arrives so the document is active
  // when contentEditable is set (otherwise the element won't receive keyboard input).
  //
  // takeSnapshot() runs HERE — before the user can mutate text — so undo restores
  // the pre-edit state. Doing it inside the EDIT_MODE_EXITED handler (where it
  // used to live) snapshots the already-edited text, which means the first undo
  // is a no-op. See task-018 / text-editing knownIssues.
  const sendEnterEditMode = useCallback((key: string, draftMarkup?: string) => {
    // Post body text is edited in the writing view: the canvas text writer
    // rewrites tags and a markdown paragraph has none, so an in-canvas edit
    // repainted the canvas and never reached the .mdx.
    const source = parseKey(key);
    const post = source?.type === 'source' ? contentEntryOf(source.file) : null;
    if (post) {
      openPost(post.collection, post.slug, scannedElementsRef.current.find(el => el.key === key)?.bodyLine);
      return;
    }
    takeSnapshot();
    enterEditMode();
    iframeRef.current?.focus();
    // Authoritative pre-override baseline for RESTORE_ORIGINAL_TEXT — the
    // bridge's first-seen-DOM capture goes stale when the DOM already shows
    // an override (reload-with-override). null → bridge falls back to DOM.
    const originalText = selectOriginalSourceText(doc, key);
    iframeRef.current?.contentWindow?.postMessage({
      type: 'ENTER_EDIT_MODE',
      payload: { key, ...(originalText !== null ? { originalText } : {}), ...(draftMarkup !== undefined ? { draftMarkup } : {}) }
    }, '*');
  }, [enterEditMode, takeSnapshot, doc, openPost, scannedElementsRef]);

  useEffect(() => {
    // The Layout context (`layoutchrome-<pageId>`) has no DOM node, so the bridge
    // can't scope to it — map it to the bridge ROOT (null). At the Layout level the
    // bridge resolves the outermost chrome tag for each click; the editor
    // synthesizes the Layout selection on top (see resolveCanvasFocus). Every other
    // (real) context key is a real DOM node, passed through for native drilling.
    const bridgeContextKey = contextKey && contextKey === layoutRootKey ? null : contextKey;
    sendToIframeBridge('SET_CONTEXT', { contextKey: bridgeContextKey });
  }, [contextKey, layoutRootKey, sendToIframeBridge]);

  // Listen for link commands from DesignBar and forward to iframe
  useEffect(() => {
    const handleWrapLink = (e: Event) => {
      const detail = (e as CustomEvent).detail as { key: string; href: string; target?: '_blank' | '_self' };
      // Don't check isEditingText - edit mode may have exited when user clicked on LinkBlock,
      // but the iframe still has a savedSelectionRange that can be used for link wrapping
      if (doc) {
        // No takeSnapshot() here: the undo snapshot is deferred to the
        // MARKUP_CHANGED handler (the only point where Yjs mutates), so a
        // successful wrap is ONE undo entry and a silent bridge failure
        // leaves the stack untouched.
        iframeRef.current?.contentWindow?.postMessage({
          type: 'WRAP_SELECTION_IN_LINK',
          payload: detail
        }, '*');
      }
    };

    const handleUnwrapLink = (e: Event) => {
      const detail = (e as CustomEvent).detail as { key: string; linkSelector: string };
      // Don't check isEditingText - the windowBlurHandler may have already exited edit mode
      // by the time this event fires (clicking DesignBar causes iframe to lose focus)

      // No takeSnapshot() here — deferred to MARKUP_CHANGED (see handleWrapLink).
      iframeRef.current?.contentWindow?.postMessage({
        type: 'UNWRAP_LINK',
        payload: detail
      }, '*');
    };

    document.addEventListener('sq:wrap-link', handleWrapLink);
    document.addEventListener('sq:unwrap-link', handleUnwrapLink);

    return () => {
      document.removeEventListener('sq:wrap-link', handleWrapLink);
      document.removeEventListener('sq:unwrap-link', handleUnwrapLink);
    };
  }, [doc]);

  // Listen for edit mode requests from useKeyboardShortcuts (when Enter pressed from main window)
  useEffect(() => {
    const handleRequestEditMode = (e: Event) => {
      const detail = (e as CustomEvent).detail as { key: string };
      if (!isEditingText && detail.key) {
        sendEnterEditMode(detail.key);
      }
    };

    window.addEventListener('sq:request-edit-mode', handleRequestEditMode);
    return () => window.removeEventListener('sq:request-edit-mode', handleRequestEditMode);
  }, [isEditingText, sendEnterEditMode]);

  // Track AI context mode (set from AIPanel via sq:ai-context-mode event)
  const aiContextModeRef = useRef(false);
  const [isAIContextMode, setIsAIContextMode] = useState(false);
  useEffect(() => {
    const handler = (e: Event) => {
      const active = (e as CustomEvent).detail.active as boolean;
      aiContextModeRef.current = active;
      setIsAIContextMode(active);
      if (!active) {
        setHoveredRect(null);
      } else {
        // Reset bridge's lastHoveredKey so the first mouse-move always fires ELEMENT_HOVER.
        // Without this, if the cursor is already over an element when context mode activates,
        // the bridge silently drops the SIMULATE_HOVER (key === lastHoveredKey) and the
        // highlight never appears.
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'SIMULATE_HOVER', payload: null }, '*',
        );
      }
    };
    window.addEventListener('sq:ai-context-mode', handler);
    return () => window.removeEventListener('sq:ai-context-mode', handler);
  }, []);

  // Listen for ELEMENT_PICKED from bridge (response to PICK_ELEMENT_AT_POINT in AI context mode)
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type !== 'ELEMENT_PICKED') return;
      const { key, tagName, classes, sectionHTML } = event.data.payload as { key: string; tagName: string; classes: string; sectionHTML?: string };
      window.dispatchEvent(new CustomEvent('sq:add-ai-context', { detail: { key, tagName, classes, html: sectionHTML } }));
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Listen for sq:fetch-element-html → forward GET_ELEMENT_SECTION_HTML to iframe
  // Listen for ELEMENT_SECTION_HTML response → dispatch sq:add-ai-context with html
  useEffect(() => {
    const fetchHandler = (e: Event) => {
      const { key } = (e as CustomEvent).detail as { key: string };
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'GET_ELEMENT_SECTION_HTML', payload: { key } }, '*'
      );
    };
    const responseHandler = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type !== 'ELEMENT_SECTION_HTML') return;
      const { key, html } = event.data.payload as { key: string; html: string | null };
      if (html) {
        window.dispatchEvent(new CustomEvent('sq:add-ai-context', { detail: { key, html } }));
      }
    };
    window.addEventListener('sq:fetch-element-html', fetchHandler);
    window.addEventListener('message', responseHandler);
    return () => {
      window.removeEventListener('sq:fetch-element-html', fetchHandler);
      window.removeEventListener('message', responseHandler);
    };
  }, []);

  // Element-clipboard: relay copy-HTML requests into the iframe and results back out.
  useEffect(() => {
    const onRequest = (e: Event) => {
      const { key, requestId } = (e as CustomEvent).detail ?? {};
      if (!key || !requestId) return;
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'GET_ELEMENT_COPY_HTML', payload: { key, requestId } }, '*');
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type !== 'ELEMENT_COPY_HTML') return;
      window.dispatchEvent(new CustomEvent('sq:copy-element-html-result', { detail: event.data.payload }));
    };
    window.addEventListener('sq:copy-element-html', onRequest);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('sq:copy-element-html', onRequest);
      window.removeEventListener('message', onMessage);
    };
  }, []);

  // AI verify_layout: sq:ai-verify-layout → VERIFY_LAYOUT (this frame only if breakpoint matches) → LAYOUT_VERIFIED → sq:ai-verify-layout-result
  useEffect(() => {
    const requestHandler = (e: Event) => {
      const { requestId, keys, breakpoint: bp } = (e as CustomEvent).detail as { requestId: string; keys: string[]; breakpoint: string };
      if (bp !== breakpoint) return; // each frame answers only for its own viewport
      iframeRef.current?.contentWindow?.postMessage({ type: 'VERIFY_LAYOUT', payload: { requestId, keys } }, '*');
    };
    const responseHandler = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type !== 'LAYOUT_VERIFIED') return;
      window.dispatchEvent(new CustomEvent('sq:ai-verify-layout-result', { detail: event.data.payload }));
    };
    window.addEventListener('sq:ai-verify-layout', requestHandler);
    window.addEventListener('message', responseHandler);
    // verify_layout moves the canvas to another width and waits for this before it asks (task-266)
    window.dispatchEvent(new CustomEvent('sq:ai-verify-ready', { detail: { breakpoint } }));
    return () => {
      window.removeEventListener('sq:ai-verify-layout', requestHandler);
      window.removeEventListener('message', responseHandler);
    };
  }, [breakpoint]);

  // AI stream preview: sq:ai-stream-preview → STREAM_PREVIEW (current-breakpoint frame only)
  useEffect(() => {
    const previewHandler = (e: Event) => {
      const { breakpoint: bp, ...payload } = (e as CustomEvent).detail as
        { breakpoint: string; mode: string; targetKey?: string; partial: string };
      if (bp !== breakpoint) return; // stream only into the frame the user is watching
      iframeRef.current?.contentWindow?.postMessage({ type: 'STREAM_PREVIEW', payload }, '*');
    };
    const endHandler = (e: Event) => {
      const { breakpoint: bp, cancelled } = (e as CustomEvent).detail as { breakpoint: string; cancelled?: boolean };
      if (bp !== breakpoint) return;
      iframeRef.current?.contentWindow?.postMessage({ type: 'STREAM_PREVIEW_END', payload: { cancelled: !!cancelled } }, '*');
    };
    window.addEventListener('sq:ai-stream-preview', previewHandler);
    window.addEventListener('sq:ai-stream-preview-end', endHandler);
    return () => {
      window.removeEventListener('sq:ai-stream-preview', previewHandler);
      window.removeEventListener('sq:ai-stream-preview-end', endHandler);
    };
  }, [breakpoint]);

  // Handle chip hover → highlight element in canvas via hoveredRect
  const aiHighlightKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const handleHighlight = (e: Event) => {
      const { key } = (e as CustomEvent).detail as { key: string };
      aiHighlightKeyRef.current = key;
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'REQUEST_ELEMENT_RECT', payload: { key } }, '*'
      );
    };
    const handleHighlightClear = () => {
      aiHighlightKeyRef.current = null;
      setHoveredRect(null);
    };
    window.addEventListener('sq:ai-highlight', handleHighlight);
    window.addEventListener('sq:ai-highlight-clear', handleHighlightClear);
    return () => {
      window.removeEventListener('sq:ai-highlight', handleHighlight);
      window.removeEventListener('sq:ai-highlight-clear', handleHighlightClear);
    };
  }, []);

  // Forward AI active highlights to this viewport's iframe: the chat run's keys
  // UNION an outside agent's (terminal / MCP — docs/plans/2026-11-10-agent-canvas-flash-design.md C5).
  // runActive stays the chat's: it gates the chat's commit stagger.
  const chatHighlightsRef = useRef<{ keys: string[]; runActive?: boolean }>({ keys: [] });
  const agentKeys = useAgentCanvasKeys(projectId);
  const agentKeysRef = useRef(agentKeys);
  agentKeysRef.current = agentKeys;
  const sendAIHighlights = useCallback(() => {
    const { keys, runActive } = chatHighlightsRef.current;
    // page:/variable: keys mark panels only; in the iframe they never resolve and pin the bridge's retry.
    const union = [...keys, ...agentKeysRef.current.filter(k => !keys.includes(k) && !k.startsWith('page:') && !k.startsWith('variable:'))];
    iframeRef.current?.contentWindow?.postMessage({ type: 'SET_AI_ACTIVE_HIGHLIGHTS', payload: { keys: union, runActive } }, '*');
  }, []);
  useEffect(() => {
    const handleAIActiveHighlights = (e: Event) => {
      chatHighlightsRef.current = (e as CustomEvent).detail as { keys: string[]; runActive?: boolean };
      sendAIHighlights();
    };
    window.addEventListener('sq:ai-active-highlights', handleAIActiveHighlights);
    return () => window.removeEventListener('sq:ai-active-highlights', handleAIActiveHighlights);
  }, [sendAIHighlights]);

  // Request element rect when selection changes (for tree selection).
  // The Layout root has no Yjs element / DOM node, so it's handled by the
  // layout-rect effect below — don't clear its rect here.
  useEffect(() => {
    if (!isReadyRef.current) return;
    if (selectedElementId) {
      sendToIframe({ type: 'REQUEST_ELEMENT_RECT', elementId: selectedElementId });
    } else if (!isLayoutRootSelected) {
      updateSelectionRect(null);
    }
  }, [selectedElementId, isLayoutRootSelected, sendToIframe, updateSelectionRect]);

  // Listen for messages from iframe (handles both legacy preview and IFrameBridge).
  // All handlers live in viewportMessages/ and are dispatched via the registry;
  // the per-handler try/catch preserves the error-boundary semantics (one bad
  // message never kills the listener). Everything the handler touches is a
  // stable ref, so the listener registers exactly once.
  useEffect(() => {
    const handler = (event: MessageEvent<{ type: string; payload?: Record<string, unknown> }>) => {
      if (event.source && event.source === iframeRef.current?.contentWindow) rememberFrameWindow(iframeRef, event.source);
      // A departing document (crash recovery remounts the frame) flushes its typed
      // text on pagehide; that draft must land even though its window is no longer current.
      else if ((event.data as { type?: string })?.type === 'TEXT_DRAFT' && wasFrameWindow(iframeRef, event.source)) {
        if (messageCtxRef.current) handleTextDraft(messageCtxRef.current, (event.data as { payload?: unknown }).payload);
        return;
      }
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (!event.data || !event.data.type) return;

      const { type } = event.data;
      if (type === 'IFRAME_READY' && localDesiredSrcRef.current) {
        try { if (event.origin !== new URL(localDesiredSrcRef.current).origin) return; } catch { return; }
      }
      if (type === 'LOCAL_ROUTE_RESULT' && messageCtxRef.current) {
        const href = localNavigationRef.current.accept(event.source as Window, event.data.payload ?? null, event.origin);
        if (href) {
          const documentId = event.data.payload?.documentId;
          localRescanRef.current = { href, ...(typeof documentId === 'string' && documentId ? { documentId } : {}) };
          setLocalRouteEpoch(c => c + 1);
        } else if (localNavigationRef.current.takeStrayDocument() && localDesiredSrcRef.current) {
          // The frame landed on a page the user already left (owner 2026-11-10:
          // "it must just SWITCH"): load the one they clicked last. Same forced
          // write as the Finding 29 reconciliation — it reloads even an unchanged src.
          localNavigationRef.current.navigate(localDesiredSrcRef.current);
          iframeRef.current?.setAttribute('src', localDesiredSrcRef.current);
        }
        return;
      }
      // Departing-document announces can race the WindowProxy replacement.
      // Files-truth follows the correlated current-document load handshake.
      if (type === 'PREVIEW_NAVIGATE' && localDesiredRouteRef.current !== null) return;

      const extracted = messageHandlers[type];
      if (extracted && messageCtxRef.current) {
        try {
          extracted(messageCtxRef.current, (event.data as { payload?: unknown }).payload, event);
        } catch (err) {
          console.error(`[ViewportFrame] Error handling iframe message "${type}":`, err);
        }
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload EDGE, distinct from the isIframeReady GATE. isIframeReady is
  // monotonic (false until first ready, then true forever) — a false→true
  // re-flip cannot signal a reload because both writes coalesce into one
  // React flush (message events batch async) and no dep changes. Every
  // effect that must re-send after an iframe (re)load keys on reloadCount.
  const [reloadCount, setReloadCount] = useState(0);
  // Agent keys changed, or a new document lost the bridge's set (C6): re-send the union.
  useEffect(() => { sendAIHighlights(); }, [agentKeys, reloadCount, sendAIHighlights]);
  const iframeReloaded = useCallback(() => setReloadCount(c => c + 1), []);

  // task-149 — local-mode "Reset to master". The overrides were deleted from
  // the doc, but the DOM still shows them: nothing was written to a file, so no
  // HMR reload comes, and there is no doc-RENDER (Phase 6). Re-navigating the iframe
  // to the same URL is the only way back to bare master output.
  //
  // The navigation alone was NOT enough (round-5 recording): the pending
  // class-update queues below still held the values the user just discarded,
  // and the reload's own scan replayed them. reloadPreviewFromSource owns that
  // ordering — see components/Canvas/reloadPreview.ts.
  //
  // ------------------------------------------------------------------
  // Finding 29 (local double-navigation): a link click inside a LOCAL iframe
  // navigates NATIVELY (files-truth; the bridge never prevents it), then the
  // correlated current-document route reply drives setActivePage → currentPagePath → a new
  // buildPreviewSrc string. Re-setting the src attribute at that point loads
  // the just-reached page a SECOND time. The accepted route handler records the
  // full document identity independently of its normalized editor page; the
  // render below parks the attribute only for that authenticated document. Both local-folder
  // and browser files-truth instances use this real-document navigation path.
  const localRenderedSrcRef = useRef<{ src: string; route: string | null } | null>(null);
  const localSrcDecisionRef = useRef<LocalIframeSrcDecision | null>(null);
  /** Src of the PREVIOUS commit — what React last wrote to the attribute.
   *  Read by the reconciliation effect BEFORE the recorder below updates it,
   *  so "did React just change the attribute?" is answered against the real
   *  committed value (render-time refs would double-count under StrictMode). */
  const lastCommittedSrcRef = useRef<string | null>(null);
  /** The TRUE current URL/route for local mode (what the frame is showing,
   *  even while the attribute is deliberately left stale after a native
   *  navigation). null outside local mode / while not running. */
  const localDesiredSrcRef = useRef<string | null>(null);
  const localRequestedSrcRef = useRef('about:blank');
  const localDesiredRouteRef = useRef<string | null>(null);
  const [, bumpLocalSrcEpoch] = useState(0);

  const requestedPreviewSrc = buildPreviewSrc({
    localInstanceState, currentPagePath,
    // localOverridesHash: recomputed per render ON PURPOSE (no memo) — the
    // frame reads it at document load, so it must stay current for HMR and
    // the next route. Updating iframe.src can reload even for a hash-only
    // change; the bridge refreshes the running document via replaceState.
    localOverridesHash: localInstanceState ? localOverridesFragment(doc) : undefined,
  });
  localRequestedSrcRef.current = requestedPreviewSrc;
  const awaitingNativeDocument = localNavigationRef.current.awaitingNativeDocument(
    projectId ?? '', requestedPreviewSrc, iframeRef.current?.contentWindow ?? null,
  );
  const confirmedDocumentSrc = localNavigationRef.current.confirmedDocument(
    projectId ?? '', requestedPreviewSrc, iframeRef.current?.contentWindow ?? null,
  );
  const desiredPreviewSrc = localNavigationRef.current.currentDocument(
    projectId ?? '', requestedPreviewSrc, iframeRef.current?.contentWindow ?? null,
  );
  let previewSrc = desiredPreviewSrc;
  if (localInstanceState) {
    const running = localInstanceState.status === 'running' && !!localInstanceState.url;
    const desiredRoute = running ? normalizeLocalRoute(currentPagePath || '/') : null;
    const decision = resolveLocalIframeSrc({
      desiredSrc: desiredPreviewSrc,
      desiredRoute,
      nativeRoute: null,
      confirmedDocumentSrc,
      awaitingNativeDocument,
      lastRendered: localRenderedSrcRef.current,
    });
    // Case 29: while the instance restarts, the last document stays (read-only
    // under Canvas's recovering cover) instead of navigating to about:blank.
    const lastSrc = localRenderedSrcRef.current?.src;
    if (localInstanceState.status === 'starting' && lastSrc && lastSrc !== 'about:blank') {
      decision.src = lastSrc; decision.route = localRenderedSrcRef.current!.route;
    }
    localRenderedSrcRef.current = { src: decision.src, route: decision.route };
    localSrcDecisionRef.current = decision;
    localDesiredSrcRef.current = desiredPreviewSrc;
    localDesiredRouteRef.current = desiredRoute;
    previewSrc = decision.src;
  } else {
    localSrcDecisionRef.current = null;
    localDesiredSrcRef.current = null;
    localDesiredRouteRef.current = null;
  }


  // Invalidate old route replies in the same commit as programmatic intent.
  // A confirmed native adoption leaves iframe.src parked and is not a new load.
  useLayoutEffect(() => {
    if (localNavigationRef.current.intent(projectId ?? '', requestedPreviewSrc)) localRescanRef.current = null;
  }, [projectId, requestedPreviewSrc]);
  useEffect(() => () => { localNavigationRef.current.invalidate(); localRescanRef.current = null; }, []);

  // A crashed instance comes back on its port (supervisor lastPorts), so the src does not change
  // and React does not navigate: replace the frame's document ourselves — a same-origin replace
  // keeps its frame until the new one paints (A4/A5) — whatever it holds now, even the error page
  // a load into the dying server left (case 29: stuck blank, log-proven). sq-b makes the URL new
  // (a #fragment-only change would not load); the bridge drops it. A new port → React navigates.
  const restartingRef = useRef<string | null>(null);
  useEffect(() => {
    const status = localInstanceState?.status;
    const src = localRenderedSrcRef.current?.src;
    if (status === 'starting') {
      if (!restartingRef.current && src && src !== 'about:blank') restartingRef.current = src;
      return;
    }
    const kept = restartingRef.current; restartingRef.current = null;
    if (status === 'running' && kept && src?.split('#')[0] === kept.split('#')[0]) {
      const url = new URL(src); url.searchParams.set(SQ_BOUNDARY_PARAM, String(Date.now()));
      try { iframeRef.current?.contentWindow?.location.replace(url.href); } catch (e) { console.warn('[canvas] restart reload failed', e); }
    }
  }, [localInstanceState?.status, localInstanceState?.url]);

  const requestLocalRoute = useCallback(() => {
    const source = iframeRef.current?.contentWindow;
    if (!source || localDesiredRouteRef.current === null) return;
    const payload = localNavigationRef.current.request(source);
    if (payload) source.postMessage({ type: 'REQUEST_LOCAL_ROUTE', payload }, '*');
  }, []);

  // Discovery can add a page after its native document has already loaded.
  // Retry only the still-current authenticated document, never an old scan.
  useEffect(() => {
    const href = localNavigationRef.current.confirmedDocument(
      projectId ?? '', requestedPreviewSrc, iframeRef.current?.contentWindow ?? null,
    );
    if (!href || !messageCtxRef.current) return;
    handlePreviewNavigate(messageCtxRef.current, { href: new URL(href).pathname }, undefined,
      route => localNavigationRef.current.adopt(route));
  }, [pages, projectId, requestedPreviewSrc, localRouteEpoch]);

  useEffect(() => {
    const pending = localRescanRef.current;
    if (!pending || normalizeLocalRoute(new URL(pending.href).pathname) !== normalizeLocalRoute(currentPagePath || '/')) return;
    localRescanRef.current = null;
    // Sent after the adopted page commits. Editor remains the sole owner of
    // expected route/file; a fresh matching scan vouches for that scope.
    iframeRef.current?.contentWindow?.postMessage({ type: 'REQUEST_LOCAL_SCAN', payload: { href: pending.href, documentId: pending.documentId } }, '*');
  }, [currentPagePath, localRouteEpoch]);

  // Keep the current document's pre-paint payload fresh without navigating.
  // Replay after every IFRAME_READY: a send during navigation may reach the
  // departing document. The bridge checks the full URL before applying it.
  useEffect(() => {
    if (localDesiredRouteRef.current === null) return;
    iframeRef.current?.contentWindow?.postMessage({
      type: 'SYNC_LOCAL_OVERRIDES_FRAGMENT',
      payload: { url: desiredPreviewSrc },
    }, '*');
  }, [desiredPreviewSrc, reloadCount]);

  // task-158 (round 11) — the same effect also publishes the URL the frame is
  // showing, so DesignBar's Push can fetch the instance's CURRENT bytes and
  // re-navigate only once they have moved. In local mode the getter prefers
  // the TRUE current URL (localDesiredSrcRef) over `iframe.src`: after a
  // native link navigation the attribute deliberately keeps the previous
  // route (finding 29 above), so probing the attribute would fetch the wrong
  // page. The canonical editor URL still comes from `previewSrc.ts`; the
  // correlated document supplies its exact native pathname/query. Runtime-agnostic and inert unless
  // something asks to verify — only local Push does.
  useEffect(() => {
    const reload = () => {
      localNavigationRef.current.navigate(localDesiredSrcRef.current);
      localRescanRef.current = null;
      // Finding 29: while "parked" (attribute route ≠ the editor's current
      // route after a native navigation), a same-attribute reload would
      // navigate the frame to the WRONG page. Re-render with the marker and
      // the rendered-src memory cleared instead — the render then puts the
      // TRUE URL in the attribute, and that set IS the reload. This also
      // carries the latest overrides when the parked attribute has an older
      // fragment (including reset/removal).
      // PARKED means the ROUTE differs. Comparing the full src strings took
      // this branch for a fragment-only difference too — Reset to master
      // clears the overrides in the same tick, so `localDesiredSrcRef` still
      // carried the stale `#sq-ov=` fragment while the attribute never had
      // one — and a re-render that changes only the fragment is not a
      // document load: the canvas kept painting the discarded override
      // (log-proven 2026-09-10 on /about of the imported personal-site).
      const rendered = localRenderedSrcRef.current;
      const trueRoute = localDesiredRouteRef.current;
      if (trueRoute !== null && rendered !== null && rendered.route !== trueRoute) {
        // Same order contract as reloadPreviewFromSource: invalidate the
        // pending queues BEFORE the navigation the re-render performs.
        pendingKeyUpdatesRef.current.clear();
        localNativeRoute.current = null;
        localRenderedSrcRef.current = null;
        bumpLocalSrcEpoch(c => c + 1);
        return;
      }
      reloadPreviewFromSource({
        iframe: iframeRef.current,
        pendingKeyUpdates: pendingKeyUpdatesRef.current,
      });
    };
    window.addEventListener('sq:reload-preview', reload);
    setPreviewUrlProvider(
      () => localNavigationRef.current.awaitingNativeDocument(
        messageCtxRef.current?.env.projectId ?? '', localRequestedSrcRef.current, iframeRef.current?.contentWindow ?? null,
      ) ? null : localDesiredSrcRef.current ?? iframeRef.current?.src ?? null,
    );
    return () => {
      window.removeEventListener('sq:reload-preview', reload);
      setPreviewUrlProvider(null);
    };
  }, [iframeRef]);

  // Finding 29 hygiene: the module-level native-route marker describes THIS
  // mounted frame — never let a previous editor session's value leak in.
  useEffect(() => {
    localNativeRoute.current = null;
    return () => { localNativeRoute.current = null; };
  }, []);

  // Finding 29 reconciliation — runs post-commit every render, BEFORE the
  // committed-src recorder below (definition order), so it reads the
  // PREVIOUS commit's src. When a render performs a programmatic navigation
  // AWAY from the natively-reached route, the marker is consumed; and when
  // React saw an unchanged src string (a sidebar return to the exact route
  // the stale attribute still names) no attribute write happened, so the
  // navigation is forced imperatively — setAttribute, the same call
  // reloadPreviewFromSource uses, which does reload a cross-origin frame.
  useEffect(() => {
    if (!localInstanceState) return;
    const decision = localSrcDecisionRef.current;
    if (!decision || decision.skipped) return;
    const native = localNativeRoute.current;
    if (native === null || decision.route === native) return;
    localNativeRoute.current = null;
    if (decision.route !== null && lastCommittedSrcRef.current === decision.src) {
      iframeRef.current?.setAttribute('src', decision.src);
    }
  });
  useEffect(() => { lastCommittedSrcRef.current = previewSrc; });

  // task-151 — the in-place counterpart of the reload above, for undo/redo.
  // An overlay entry that an undo REMOVED goes back to the value the SOURCE
  // renders, which only the iframe ever held; the queue eviction that rides
  // along is what stops the discarded value from being replayed by the next
  // scan (Canvas/restoreOverrides.ts). Same-window relays, like every other
  // *_TO_IFRAME message.
  useEffect(() => {
    const onRestore = (event: MessageEvent): void => {
      if (event.source !== window) return;
      const data = event.data as { type?: string; payload?: unknown } | null;
      if (!data) return;
      if (data.type === RESTORE_CLASSES_RELAY) {
        applyClassRestore({
          iframe: iframeRef.current,
          pendingKeyUpdates: pendingKeyUpdatesRef.current,
          intents: frameUnderstandsIntents(iframeRef.current),
        }, data.payload as ClassRestoreRequest);
      } else if (data.type === RESTORE_IMAGE_ATTRS_RELAY) {
        applyImageAttrRestore(iframeRef.current, data.payload as ImageAttrRestoreRequest);
      }
    };
    window.addEventListener('message', onRestore);
    return () => window.removeEventListener('message', onRestore);
  }, []);

  // task-120: page switch = SET_PAGE bridge message + a fresh RENDER, never an
  // iframe navigation. Runs BEFORE the RENDER effect below (definition order),
  // so the bridge clears page-scoped state (scroll, edit mode, overlays,
  // rescan budget) before the new page's markup lands. Clearing the dedupe
  // key forces RENDER even when the new page's payload is byte-identical.
  const setPageSentForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentPageId) return;
    if (setPageSentForRef.current === currentPageId) return;
    setPageSentForRef.current = currentPageId;
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'SET_PAGE', payload: { pageId: currentPageId } }, '*'
    );
  }, [currentPageId]);

  const { collections: diskCollections } = useContentCollections();
  const yCollections = useYjsValue(selectContentCollections);
  const { builtIn: libraryComponents, isLoading: libraryLoading } = useComponentLibrary();
  const postPageData = useYjsValue((doc) =>
    currentPageId ? selectPostPageRenderData(doc, currentPageId) : null
  );

  // Phase 6: the doc-truth post-page body fetch (RENDER fallback) is gone — the
  // post page IS the user's real route.

  // Phase 6: the doc-truth RENDER effect (parent → iframe markup) is gone —
  // the iframe IS the user's site; the doc never renders into it.

  // Mirror of the design's `<BlogPost><Content />` route stub at the Yjs
  // level — see docs/archive/plans/2026-05-11-pages-in-assets-design.md.
  //
  // The wrap fires once per page (idempotent no-op after); steady-state
  // propagation is the MASTERS overlay (baseMarkup prefers it over the frozen
  // first-wrap staticMarkup). ensureBlogPostMasterSeeded establishes that
  // overlay right here at post-page open — without it a doc whose masters
  // were never seeded (or purged) rendered the stale freeze until the user
  // happened to open the BlogPost master in Assets.
  useEffect(() => {
    // libraryLoading gate: the mount-time library is the BUNDLED fallback
    // (virtual:built-in-components) and can be stale — wrapping or seeding
    // from it freezes an outdated BlogPost into the doc, and missing-only
    // seeding would then lock it in. Wait until the /__sq scan settles.
    if (!currentPageId || !postPageData || libraryLoading || libraryComponents.length === 0) {
      return;
    }
    let cancelled = false;
    (async () => {
      // Independent asyncs: the wrap needs the resolved html, the seed doesn't
      // (idempotent doc-global write, in-flight-deduped across the 6 frames).
      const [html] = await Promise.all([
        resolveBlogPostCanvasHtml(libraryComponents),
        ensureBlogPostMasterSeeded(doc, libraryComponents),
      ]);
      if (cancelled || !html) return;
      await wrapPostPageInBlogPost(doc, currentPageId, html);
    })().catch(error => { console.error('Post page wrapper was not saved', error); });

    return () => { cancelled = true; };
  }, [currentPageId, postPageData, libraryComponents, libraryLoading, doc]);

  // Non-local fallback: do NOT reset contentHeight to null when components/breakpoint
  // change. Nulling it collapses the iframe to `auto` (~150px) until the
  // bridge re-reports CONTENT_HEIGHT — that gap is visible,
  // and at zoom ≠ 1 / panned views the collapsed sliver sits off-screen, so
  // every element add made the whole canvas "disappear" until the user
  // zoomed around to find it. The bridge re-reports height after every DOM
  // rebuild, so the stale value self-corrects without ever collapsing.

  // Held class values (instant-edit P0b): once the row that wrote a value is materialized the canvas verifies it
  // against the file and lets go. `alive` tells the bridge the parent is still there while rows are unlanded, so
  // its backstop never fires on a long backlog. Each canvas posts a (key, seq) once.
  useEffect(() => {
    if (!projectId) return;
    const state = { posted: new Map<string, number>(), lastAlive: 0 };
    const run = (): void => {
      const frame = iframeRef.current;
      if (!frame?.contentWindow || !frameUnderstandsIntents(frame)) return;
      const plan = planSettleMessage(projectId, getMaterializationStatus(projectId).materializedRevision, Date.now(), state);
      if (plan) frame.contentWindow.postMessage({ type: 'CLASS_INTENT_SETTLED', payload: plan }, '*');
    };
    const off = subscribeMaterializationStatus(run);
    run();
    return off;
  }, [projectId]);

  // Handle class sync messages from ClassStoreContext (DesignBar changes)
  useEffect(() => {
    const handleSyncMessage = (event: MessageEvent): void => {
      // Only accept messages from same window (internal communication)
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.type !== 'SYNC_CLASSES_TO_IFRAME') return;

      const payload = data.payload as UpdateClassesPayload & { key: string; draft?: boolean; painted?: boolean; preview?: boolean };

      // instant-edit P1: a DRAFT is the writer's call-time paint, valid only for a document whose bridge orders
      // writes by intent (an older bridge would apply it and then the lane-lagged value: worse than before) — that
      // document gets the observer's value at acceptance. The observer's message for a value that was already
      // PAINTED is only bookkeeping for such a document (hold:false is not: it releases the paint's hold).
      const understands = frameUnderstandsIntents(iframeRef.current);
      if (payload.draft && !understands) return;
      if (payload.painted && understands && payload.intent?.hold) return;

      // Track by the FULL element key — the only address that names ONE
      // element on ONE surface (task-181; see the ref's declaration). A draft is not filed: the replay queue is
      // the INTENT-LESS path and a draft may still be rejected; unlanded writes are re-posted with their intent.
      if (!payload.draft) pendingKeyUpdatesRef.current.set(payload.key, { key: payload.key, classes: payload.classes });

      // Forward class update to iframe
      const iframe = iframeRef.current;
      if (iframe?.contentWindow) {
        // Check if this is an instance child key (format: instanceId:selector)
        const parsed = parseKey(payload.key);

        if (parsed?.type === 'instance-child') {
          // Send UPDATE_INSTANCE_OVERRIDE for instance children
          iframe.contentWindow.postMessage({
            type: 'UPDATE_INSTANCE_OVERRIDE',
            payload: {
              instanceId: parsed.instanceId,
              selector: parsed.selector,
              classes: payload.classes
            }
          }, '*');
        } else {
          // Regular element - send UPDATE_CLASSES. The intent (call-order number + hold flag) goes only to a document
          // whose bridge announced it: an older bridge would apply the value but know nothing of ordering.
          const { intent, draft: _draft, painted: _painted, preview: _preview, ...plain } = payload;
          iframe.contentWindow.postMessage({
            type: 'UPDATE_CLASSES',
            payload: intent && understands ? { ...plain, intent } : plain
          }, '*');
        }

        // Refresh grid geometry when a class change affects the grid overlay:
        // 1. The selected element itself changed (it IS the grid container)
        // 2. The parent of the selected element changed (selected is a grid child)
        const curSelectedKey = selectionSelectedKeyRef.current;
        // A stepper tick (preview) schedules no rect/grid follow-up: 30 ticks a second would add 60 messages a second;
        // the gesture's commit runs it once.
        if (curSelectedKey && !payload.preview) {
          let needsRefresh = false;
          if (curSelectedKey === payload.key) {
            // Selected element's own classes changed — may be a grid container
            needsRefresh = true;
          } else {
            const selectedEl = scannedElementsRef.current.find(el => el.key === curSelectedKey);
            if (selectedEl?.parentKey === payload.key) needsRefresh = true;
          }
          if (needsRefresh) {
            pendingGridRefreshKeyRef.current = curSelectedKey;
            // Delay to let iframe apply classes and reflow layout.
            setTimeout(() => {
              if (pendingGridRefreshKeyRef.current !== curSelectedKey) return;
              iframe.contentWindow?.postMessage(
                { type: 'REQUEST_ELEMENT_RECT', payload: { key: curSelectedKey } }, '*',
              );
              setTimeout(() => {
                if (pendingGridRefreshKeyRef.current !== curSelectedKey) return;
                pendingGridRefreshKeyRef.current = null;
                iframe.contentWindow?.postMessage(
                  { type: 'REQUEST_GRID_GEOMETRY', payload: { key: curSelectedKey } }, '*',
                );
              }, 200);
            }, 100);
          }
        }
      }
    };

    window.addEventListener('message', handleSyncMessage);
    return () => window.removeEventListener('message', handleSyncMessage);
  }, []);

  // Unified forwarder for simple window→iframe messages.
  // Many context/block components communicate to the iframe via window.postMessage
  // with a SYNC_* type. This single handler forwards them all.
  useEffect(() => {
    /** Map of internal message type → iframe message type */
    const SIMPLE_FORWARDS: Record<string, string> = {
      'SYNC_TEXT_TO_IFRAME': 'UPDATE_TEXT',
      'SYNC_REMOVE_ELEMENT_FROM_DOM': 'REMOVE_ELEMENT_FROM_DOM',
      'SYNC_CLONE_ELEMENT_IN_DOM': 'CLONE_ELEMENT_IN_DOM',
      'SYNC_LINK_ATTR_TO_IFRAME': 'UPDATE_LINK_ATTRIBUTE',
      'SYNC_ASSET_TO_IFRAME': 'TRANSFER_ASSET',
      'REORDER_ELEMENTS_IN_IFRAME': 'REORDER_ELEMENTS',
      'SET_LINK_INTERACTING': 'SET_LINK_INTERACTING',
      // task-206: component-viewer Media demo — MediaBlock's knobs mutate
      // the rendered media unit (no invocation to write in the master view).
      'SET_MEDIA_DEMO_TO_IFRAME': 'SET_MEDIA_DEMO',
    };

    const handleSimpleForward = (event: MessageEvent): void => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data?.type) return;

      const iframeType = SIMPLE_FORWARDS[data.type];
      if (!iframeType) return;

      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;

      // SET_LINK_INTERACTING forwards the whole message as-is
      if (data.type === 'SET_LINK_INTERACTING') {
        iframe.contentWindow.postMessage(data, '*');
        return;
      }

      // SYNC_REMOVE_ELEMENT_FROM_DOM normalizes payload to { key }
      if (data.type === 'SYNC_REMOVE_ELEMENT_FROM_DOM') {
        iframe.contentWindow.postMessage({
          type: iframeType,
          payload: { key: data.payload.key },
        }, '*');
        return;
      }

      // task-120: asset bytes move as a transferable — no structured clone
      // of the ArrayBuffer on the parent→iframe hop.
      if (data.type === 'SYNC_ASSET_TO_IFRAME' && data.payload?.arrayBuffer instanceof ArrayBuffer) {
        iframe.contentWindow.postMessage(
          { type: iframeType, payload: data.payload },
          '*',
          [data.payload.arrayBuffer],
        );
        return;
      }

      iframe.contentWindow.postMessage({
        type: iframeType,
        payload: data.payload,
      }, '*');
    };

    window.addEventListener('message', handleSimpleForward);
    // The SYNC_ASSET_TO_IFRAME relay is now live — flush any asset transfers
    // queued before mount (task-049 II-2; they used to be silently lost).
    markAssetRelayReady();
    return () => {
      markAssetRelayTorndown();
      window.removeEventListener('message', handleSimpleForward);
    };
  }, []);

  // Observer-driven drawn element sync (replaces event bus).
  //
  // The observer body is microtask-coalesced via `createMicrotaskCoalescer` so
  // multiple Yjs transactions in the same tick collapse into a single diff
  // walk + a single batch of postMessages. Without coalescing, N consecutive
  // unwrapped ADD_DRAWN_ELEMENT dispatches each fire `observeDeep`, each
  // walking the entire elements map and selectPageDrawnElements (O(N²) doc
  // walks). With coalescing, the parent side is O(1) walks per tick regardless
  // of how many transactions land. The number of INSERT_DRAWN_ELEMENT
  // postMessages is unchanged (one per added element) — batching the message
  // itself would require a new INSERT_DRAWN_ELEMENTS protocol entry on
  // bridge.js + snapshot rebuild, which is out of scope here. See
  // `drawnElementSync.ts` for the helpers + tests.
  useEffect(() => {
    const elements = doc.getMap('elements');
    const prevDrawnKeys = new Set<string>();
    let prevMarkup = new Map<string, string>();

    // Initialize: capture current drawn elements + their markup snapshot
    elements.forEach((value, key) => {
      const yEl = value as Y.Map<unknown>;
      if (yEl.get('isDrawn')) {
        prevDrawnKeys.add(key);
        const markup = yEl.get('staticMarkup') as string | undefined;
        if (markup) prevMarkup.set(key, markup);
      }
    });

    const flush = () => {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow || !currentPageId) return;

      const { added, removed, changed, currentKeys, currentMarkup } = computeDrawnElementDiff(
        prevDrawnKeys,
        elements,
        currentPageId,
        prevMarkup,
      );

      // Removed elements
      for (const key of removed) {
        iframe.contentWindow.postMessage({
          type: 'REMOVE_DRAWN_ELEMENT',
          payload: { key },
        }, '*');
      }

      // Added elements + in-place staticMarkup changes (pen node edits and
      // their undo/redo — the bridge update branch applies carried markup).
      // Compute selectPageDrawnElements ONCE per flush (was O(N²): once per
      // added key). For a 30-element undo restore that collapses 30 full doc
      // walks into 1.
      const toSend = [...added, ...changed];
      if (toSend.length > 0) {
        const drawnElements = selectPageDrawnElements(doc, currentPageId);
        const byKey = new Map(drawnElements.map(d => [d.key, d]));
        for (const key of toSend) {
          const drawn = byKey.get(key);
          if (!drawn) continue;
          iframe.contentWindow.postMessage({
            type: 'INSERT_DRAWN_ELEMENT',
            payload: {
              key: drawn.key,
              tag: drawn.tag,
              classes: drawn.classes,
              textContent: drawn.textContent,
              parentKey: drawn.parentKey,
              slotType: drawn.slotType,
              staticMarkup: drawn.staticMarkup,
              slotComponentMarkup: drawn.slotComponentMarkup,
              slotComponentName: drawn.slotComponentName,
              insertIndex: drawn.insertIndex,
            },
          }, '*');
        }
      }

      // Update tracking snapshots
      prevDrawnKeys.clear();
      currentKeys.forEach(k => prevDrawnKeys.add(k));
      prevMarkup = currentMarkup;
    };

    const coalescer = createMicrotaskCoalescer(flush);
    const observer = () => coalescer.trigger();

    elements.observeDeep(observer);
    return () => {
      elements.unobserveDeep(observer);
      // Flush any pending diff so cleanup doesn't drop pending insertions.
      coalescer.flushSync();
    };
  }, [doc, currentPageId]);

  // Handle image attribute sync: forwards to iframe + triggers preview refresh on src change
  useEffect(() => {
    const handleSyncImageAttr = (event: MessageEvent): void => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.type !== 'SYNC_IMAGE_ATTR_TO_IFRAME') return;

      const payload = data.payload as { key: string; attribute: string; value: string };
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;

      iframe.contentWindow.postMessage({ type: 'UPDATE_IMAGE_ATTRIBUTE', payload }, '*');

      // Refresh preview thumbnail after src change (alt/loading don't affect it)
      if (payload.attribute === 'src') {
        setTimeout(() => {
          iframe.contentWindow?.postMessage({
            type: 'REQUEST_PREVIEW_REFRESH',
            payload: { key: payload.key }
          }, '*');
        }, 200);
      }
    };

    window.addEventListener('message', handleSyncImageAttr);
    return () => window.removeEventListener('message', handleSyncImageAttr);
  }, []);

  // Forward reparent messages from layers panel to iframe + request updated rect
  useEffect(() => {
    const handleReparent = (event: MessageEvent): void => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.type !== 'REPARENT_ELEMENT_IN_IFRAME') return;

      const payload = data.payload as { key: string; newParentKey: string | null; insertIndex: number };
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;

      iframe.contentWindow.postMessage({ type: 'REPARENT_ELEMENT_DOM', payload }, '*');
      setTimeout(() => {
        iframe?.contentWindow?.postMessage({
          type: 'REQUEST_ELEMENT_RECT',
          payload: { key: payload.key }
        }, '*');
      }, 50);
    };

    window.addEventListener('message', handleReparent);
    return () => window.removeEventListener('message', handleReparent);
  }, []);

  // Owner 2026-10-08: an empty page shows one blank SCREEN (the artboard
  // floor) — no empty-page hiding. The canvas is visibly painted once ready:
  // background work that competes with it (slug discovery compiling every
  // page — useLocalInstance deferDiscovery) may start.
  const revealed = isIframeReady;
  useEffect(() => { if (revealed) window.dispatchEvent(new CustomEvent('sq:canvas-revealed')); }, [revealed]);


  // task-116: tell the bridge which mode it is in. Keyed on reloadCount too —
  // a reloaded bridge (Vite HMR full-reload included) constructs itself back
  // in design mode. Re-sending here is what keeps preview from silently
  // reverting under the user.
  useEffect(() => {
    if (!isIframeReady) return;
    iframeRef.current?.contentWindow?.postMessage(
      // designViewportHeight: what a vh means in design mode (bridge vh-pin);
      // re-sent on a breakpoint change so the pin follows the design viewport.
      { type: 'SET_MODE', payload: { mode: isPreview ? 'preview' : 'design', designViewportHeight: designScreenHeight } },
      '*',
    );
  }, [isPreview, isIframeReady, reloadCount, designScreenHeight]);

  // Theme-mode preview: keyed on reloadCount for the same reload-resend
  // reason as SET_MODE above.
  const currentThemeMode = useCurrentThemeMode();
  useEffect(() => {
    if (!isIframeReady) return;
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'SET_THEME_MODE', payload: { mode: currentThemeMode } },
      '*',
    );
  }, [currentThemeMode, isIframeReady, reloadCount]);

  // Chromium fixed-layer raster bug (2026-08-23): the parts of a
  // position:fixed element that the canvas clip hides at the iframe's first
  // raster stay blank forever — Chromium never re-rasters the fixed layer
  // when a pan/zoom/resize reveals them (repro: nested h-screen + canvas
  // clips; window narrower than panels + frame). The bridge re-layerizes
  // fixed elements on REPAINT_FIXED (fresh raster under the current clip),
  // so re-send it whenever new frame area can come into view: iframe
  // ready/reload, canvas pan/zoom settle (Canvas dispatches
  // sq:canvas-transform-settled from its flush), and window resize.
  useEffect(() => {
    if (!isIframeReady) return;
    const send = () =>
      iframeRef.current?.contentWindow?.postMessage({ type: 'REPAINT_FIXED', payload: {} }, '*');
    send();
    let resizeTimer: number | undefined;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(send, 200);
    };
    window.addEventListener('sq:canvas-transform-settled', send);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('sq:canvas-transform-settled', send);
      window.removeEventListener('resize', onResize);
      window.clearTimeout(resizeTimer);
    };
  }, [isIframeReady, reloadCount]);

  const overlayRef = useRef<HTMLDivElement>(null);
  const setOverlayPointerEvents = useCallback((enabled: boolean) => {
    if (overlayRef.current) {
      overlayRef.current.style.pointerEvents = enabled ? 'auto' : 'none';
    }
  }, []);

  // Attach wheel listener with passive: false to allow preventDefault
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const wheelHandler = (e: WheelEvent) => { handleViewportWheel(e, { onZoom, onPan }); };

    overlay.addEventListener('wheel', wheelHandler, { passive: false });
    return () => overlay.removeEventListener('wheel', wheelHandler);
  }, [onZoom, onPan, isPreview]);

  // Layout context for move behavior
  const [selectedPosition, setSelectedPosition] = useState<string>('static');

  // Grid geometry state for overlay and snap
  const [gridGeometry, setGridGeometry] = useState<GridGeometry | null>(null);
  const [highlightedGridCell, setHighlightedGridCell] = useState<{ col: number; row: number } | null>(null);
  // Grid overlay only visible during drag or resize, not on selection
  const [isGridOverlayVisible, setIsGridOverlayVisible] = useState(false);
  // Refs for accessing current values in stale closures (message handler useEffect)
  const gridGeometryRef = useRef<GridGeometry | null>(null);
  const highlightedGridCellRef = useRef<{ col: number; row: number } | null>(null);
  // Bridge-announced drag mode (DRAG_MODE_CHANGED) — gates overlay + grid drop path
  const dragModeRef = useRef<'grid' | 'reparent' | 'flow' | null>(null);
  /** Where the current flow drag began (iframe px): a grid child lands by its own travel, not by the cursor's cell. */
  const flowDragStartRef = useRef({ x: 0, y: 0 });
  const pendingGridRefreshKeyRef = useRef<string | null>(null);
  // Refs for accessing current values in stale closures (message handlers).
  // The main message handler reads these via .current so it doesn't need
  // to re-register whenever these values change.
  const isEditingTextRef = useRef(isEditingText);
  const onZoomRef = useRef(onZoom);
  const onPanRef = useRef(onPan);
  const scalePropsRef = useRef(scale);
  const selectInContextRef = useRef(selectInContext);
  const toggleInSelectionRef = useRef(toggleInSelection);
  const patchSelectionRef = useRef(patchSelection);
  const registerElementRef = useRef(registerElement);
  const enterContextRef = useRef(enterContext);
  const exitContextRef = useRef(exitContext);
  const resetContextRef = useRef(resetContext);
  const currentPageIdRef = useRef(currentPageId);
  const currentLayoutNameRef = useRef(currentLayoutName);
  const layoutRootKeyRef = useRef(layoutRootKey);
  const breakpointRef = useRef(breakpoint);
  const clearSelectionRef = useRef(clearSelection);
  isEditingTextRef.current = isEditingText;
  onZoomRef.current = onZoom;
  onPanRef.current = onPan;
  scalePropsRef.current = scale;

  // The overlay covering the iframe forwards hover only in AI-context mode or while Option is held
  // (Option-hover measuring: `deep` = the element under the cursor, like ⌘-click). Pressing or
  // releasing Option re-hovers / clears at the last pointer spot.
  const lastPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const forwardHover = useCallback((p: { clientX: number; clientY: number } | null) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    let payload: { x: number; y: number; deep?: true } | null = null;
    if (p) {
      const rect = iframe.getBoundingClientRect();
      const s = scalePropsRef.current;
      payload = { x: (p.clientX - rect.left) / s, y: (p.clientY - rect.top) / s };
      if (!aiContextModeRef.current) payload.deep = true;
    }
    iframe.contentWindow.postMessage({ type: 'SIMULATE_HOVER', payload }, '*');
  }, [iframeRef]);
  useEffect(() => altKeyStore.subscribe(() => {
    if (!aiContextModeRef.current) forwardHover(altKeyStore.get() ? lastPointerRef.current : null);
  }), [forwardHover]);
  selectInContextRef.current = selectInContext;
  toggleInSelectionRef.current = toggleInSelection;
  patchSelectionRef.current = patchSelection;
  registerElementRef.current = registerElement;
  enterContextRef.current = enterContext;
  exitContextRef.current = exitContext;
  resetContextRef.current = resetContext;
  currentPageIdRef.current = currentPageId;
  currentLayoutNameRef.current = currentLayoutName;
  layoutRootKeyRef.current = layoutRootKey;
  breakpointRef.current = breakpoint;
  clearSelectionRef.current = clearSelection;
  gridGeometryRef.current = gridGeometry;
  highlightedGridCellRef.current = highlightedGridCell;

  // Only absolute/fixed drawn elements are movable via overlay drag.
  // Static/flow elements can't be repositioned by dragging the overlay.
  const isSelectedMovable = !!selectedKey && selectedKey.startsWith('drawn-') &&
    (selectedPosition === 'absolute' || selectedPosition === 'fixed');

  // Handle move — absolute/fixed elements change top/left (flow elements drag through handleFlowDrag*)
  const handleMove = useCallback((deltaX: number, deltaY: number) => {
    if (!selectedKey) return;

    takeSnapshot();

    // Absolute/fixed positioned: change top/left (like drawn elements)
    if (selectedPosition === 'absolute' || selectedPosition === 'fixed') {
      const sourceClasses = doc.getMap('sourceClasses');
      const yEntry = sourceClasses.get(selectedKey) as Y.Map<unknown> | undefined;
      const currentClasses = yEntry ? (yEntry.get('classes') as string || '') : '';

      if (currentClasses) {
        const newClasses = currentClasses
          .replace(/top-\[(-?\d+)px\]/, (_, val: string) => `top-[${parseInt(val) + deltaY}px]`)
          .replace(/left-\[(-?\d+)px\]/, (_, val: string) => `left-[${parseInt(val) + deltaX}px]`);

        if (newClasses !== currentClasses) {
          dispatch({
            type: 'UPDATE_SOURCE_CLASSES',
            sourceKey: selectedKey,
            classes: newClasses,
          });
        }
      }
      return;
    }
  }, [selectedKey, selectedPosition, dispatch, takeSnapshot, doc]);

  // Flow drag: forward coordinates to iframe, process drop result
  const handleFlowDragStart = useCallback((iframeX: number, iframeY: number) => {
    if (!selectedKey) return;
    flowDragStartRef.current = { x: iframeX, y: iframeY };
    dragModeRef.current = 'grid';
    setIsGridOverlayVisible(true);
    iframeRef.current?.contentWindow?.postMessage({
      type: 'DRAG_ELEMENT_START',
      payload: { key: selectedKey, iframeX, iframeY },
    }, '*');

    // Request grid geometry -- bridge traverses up to find grid ancestor
    iframeRef.current?.contentWindow?.postMessage({
      type: 'REQUEST_GRID_GEOMETRY',
      payload: { key: selectedKey },
    }, '*');
  }, [selectedKey]);

  const handleFlowDragMove = useCallback((iframeX: number, iframeY: number) => {
    // Use ref to avoid stale closure — gridGeometry may arrive async after drag starts.
    // Geometry only applies when the dragged element is itself a cell in it —
    // dragging the grid container must not snap to its own internal grid.
    const geo = gridGeometryRef.current;
    const draggedInfo = geo?.cells.find(c => c.key === selectedKey);
    if (geo && draggedInfo && dragModeRef.current !== 'flow') {
      const colSpan = draggedInfo.colSpan ?? 1;
      const rowSpan = draggedInfo.rowSpan ?? 1;
      const cell = dragTargetCell(geo, draggedInfo, iframeX - flowDragStartRef.current.x, iframeY - flowDragStartRef.current.y);
      // task-120 (5.1): bail when the cell is unchanged — this fires per
      // coalesced drag frame and a fresh {col,row} object every move
      // re-rendered the grid overlay for the same cell.
      setHighlightedGridCell((prev) =>
        prev && prev.col === cell.col && prev.row === cell.row ? prev : cell,
      );

      const cellRect = getCellRect(geo, cell.col, cell.row, colSpan, rowSpan);

      iframeRef.current?.contentWindow?.postMessage({
        type: 'DRAG_ELEMENT_MOVE',
        payload: {
          iframeX, iframeY,
          snapRect: {
            left: geo.containerRect.left + cellRect.left,
            top: geo.containerRect.top + cellRect.top,
            width: cellRect.width,
            height: cellRect.height,
          },
        },
      }, '*');
    } else {
      iframeRef.current?.contentWindow?.postMessage({
        type: 'DRAG_ELEMENT_MOVE',
        payload: { iframeX, iframeY },
      }, '*');
    }
  }, [selectedKey]);

  const handleFlowDragEnd = useCallback((iframeX: number, iframeY: number) => {
    iframeRef.current?.contentWindow?.postMessage({
      type: 'DRAG_ELEMENT_END',
      payload: { iframeX, iframeY },
    }, '*');

    // NOTE: Do NOT clear gridGeometry/highlightedGridCell here!
    // The DRAG_ELEMENT_DROP handler (which arrives async via postMessage roundtrip)
    // needs these values to determine grid placement. It clears them after processing.
  }, []);

  // Sync a single element's classes from Yjs to the iframe.
  const syncClassToIframe = useCallback((key: string) => {
    const entry = doc.getMap('sourceClasses').get(key) as import('yjs').Map<unknown> | undefined;
    if (!entry) return;
    iframeRef.current?.contentWindow?.postMessage({
      type: 'UPDATE_CLASSES',
      payload: { key, classes: entry.get('classes') as string },
    }, '*');
  }, [doc]);

  // Request fresh rect + grid geometry from the iframe after a class change.
  // The primary geometry refresh happens when the iframe responds with RECT_UPDATED
  // (confirming classes have been applied and layout reflowed). A delayed fallback
  // request covers cases where RECT_UPDATED doesn't arrive (e.g. element not found).
  const refreshGridState = useCallback((key: string) => {
    pendingGridRefreshKeyRef.current = key;
    requestAnimationFrame(() => {
      setTimeout(() => {
        iframeRef.current?.contentWindow?.postMessage({ type: 'REQUEST_ELEMENT_RECT', payload: { key } }, '*');
        // Fallback: if RECT_UPDATED hasn't cleared the pending ref after 250ms,
        // request geometry directly (Tailwind CDN may need extra time).
        setTimeout(() => {
          if (pendingGridRefreshKeyRef.current === key) {
            pendingGridRefreshKeyRef.current = null;
            iframeRef.current?.contentWindow?.postMessage({ type: 'REQUEST_GRID_GEOMETRY', payload: { key } }, '*');
          }
        }, 200);
      }, 50);
    });
  }, []);

  // Request grid geometry when selection changes host-side (task-094 D5).
  // The LayersPanel path never passes through the iframe ELEMENT_SELECTED
  // handler (selection.ts) — the only pre-fix requester — so the panel's
  // Start/Span showed placeholder-0 and edits used the class-fallback bound.
  // The iframe-click path may request the same key right before this effect;
  // duplicate responses are idempotent in gridGeometryStore, so no dedup.
  useEffect(() => {
    if (!selectedKey || !isIframeReady) return;
    // task-120 (4.4): skip the probe for selections that can't be grid-
    // relevant. Unknown keys still post — the bridge early-returns safely.
    const scanned = scannedElementsRef.current.find((e) => e.key === selectedKey);
    if (!isGridRelevantSelection(scanned)) return;
    iframeRef.current?.contentWindow?.postMessage({
      type: 'REQUEST_GRID_GEOMETRY',
      payload: { key: selectedKey },
    }, '*');
  }, [selectedKey, isIframeReady, reloadCount]);

  // The canvas width changed with the selection kept: its cell is measured
  // again at the new breakpoint, once the frame has re-laid out. The stored
  // cell is stamped with the breakpoint it was measured at, so without this
  // the panel's Start/Span went empty (live 2026-11-12).
  const measuredBreakpointRef = useRef(breakpoint);
  useEffect(() => {
    if (measuredBreakpointRef.current === breakpoint) return;
    measuredBreakpointRef.current = breakpoint;
    if (selectedKey && isIframeReady && isGridRelevantSelection(scannedElementsRef.current.find((e) => e.key === selectedKey))) refreshGridState(selectedKey);
  }, [breakpoint, selectedKey, isIframeReady, refreshGridState]);

  // Persist grid class change: source elements via ViteClassWriter, instance children via classOverrides.
  const persistGridClasses = useCallback((key: string) => {
    const yEntry = doc.getMap('sourceClasses').get(key) as import('yjs').Map<unknown> | undefined;
    if (!yEntry) return;
    const classes = yEntry.get('classes') as string;

    const parsed = parseKey(key);
    if (parsed?.type === 'instance-child') {
      const classTokens = classes.split(/\s+/).filter(Boolean);
      dispatch({
        type: 'UPDATE_THEME_INSTANCE_CLASS_OVERRIDE',
        instanceId: parsed.instanceId,
        selector: parsed.selector,
        breakpoint: 'base',
        classes: classTokens,
      });
      return;
    }

    // Source elements: write directly to file
    const yLoc = yEntry.get('sourceLocation') as import('yjs').Map<unknown> | undefined;
    if (!yLoc) return;
    const sourceLocation = {
      file: yLoc.get('file') as string,
      line: yLoc.get('line') as number,
      column: yLoc.get('column') as number,
    };
    if (viteClassWriter.isAvailable()) {
      // The baseline goes with EVERY class write, not just the DesignBar's
      // (task-166). Omitting it here made a grid edit on a component root
      // written class={'lit ' + prop} refuse every time, with the same message
      // the missing-plumbing regression produced — and the refusal is supposed
      // to mean "this token belongs to the dynamic part", nothing else.
      viteClassWriter.writeClassUpdate(sourceLocation, classes, false, getClassWriteBaseline(key))
        .then(wrote => { if (wrote) setClassWriteBaseline(key, classes); })
        .catch(err => console.error('[GridPersist] Write failed:', key, err));
    }
  }, [doc, dispatch]);

  const handleResizeStart = useCallback(() => setIsGridOverlayVisible(true), []);
  const handleResizeEnd = useCallback(() => setIsGridOverlayVisible(false), []);

  // Assemble the extracted-handler context. Reassigned every render so env
  // values (webContainerState, projectId) are always current;
  // refs and actions are stable by construction. Handlers read refs via
  // `.current` at call time — never unwrap them here.
  messageCtxRef.current = {
    refs: {
      iframe: iframeRef,
      isReady: isReadyRef,
      selectedKey: selectionSelectedKeyRef,
      scannedElements: scannedElementsRef,
      selectedElementId: selectionSelectedElementIdRef,
      contextKey: selectionContextKeyRef,
      isEditingText: isEditingTextRef,
      onZoom: onZoomRef,
      onPan: onPanRef,
      scaleProps: scalePropsRef,
      selectInContext: selectInContextRef,
      toggleInSelection: toggleInSelectionRef,
      patchSelection: patchSelectionRef,
      registerElement: registerElementRef,
      enterContext: enterContextRef,
      exitContext: exitContextRef,
      resetContext: resetContextRef,
      currentPageId: currentPageIdRef,
      layoutRootKey: layoutRootKeyRef,
      breakpoint: breakpointRef,
      aiContextMode: aiContextModeRef,
      aiHighlightKey: aiHighlightKeyRef,
      gridGeometry: gridGeometryRef,
      highlightedGridCell: highlightedGridCellRef,
      dragMode: dragModeRef,
      pendingGridRefreshKey: pendingGridRefreshKeyRef,
      pendingSelect: pendingSelectRef,
      pendingKeyUpdates: pendingKeyUpdatesRef,
      isLinkInteracting: isLinkInteractingRef,
    },
    actions: {
      dispatch,
      updateSelectionRect,
      setHoveredRect,
      setAIGlowRects,
      setAIPreviewRect,
      setGridGeometry,
      setHighlightedGridCell,
      setIsGridOverlayVisible,
      setReparentDragKey,
      setContentHeight: receiveContentHeight,
      setSourceError,
      setIsIframeReady,
      iframeReloaded,
      setScannedElements,
      updateScannedElementRects,
      setTextSelection,
      clearTextSelection,
      exitEditMode,
      sendEnterEditMode,
      takeSnapshot,
      pushStructuralUndo,
      getClassesFromYjs,
      clearSelection,
      updateBgImagePreview,
      updateImagePreview,
      setSelectedPosition,
      persistGridClasses,
      claimSnapshot,
      syncClassToIframe,
      refreshGridState,
      setActivePage,
      goToPost,
    },
    env: {
      doc,
      projectId,
      pages,
      isLocalMode: !!localInstanceState,
    },
  };

  // Grid span change handler (resize auto-sized grid child -> col-span/row-span).
  // Handle-aware: west/north handles adjust col-start/row-start to keep opposite edge fixed.
  const handleGridSpanChange = useCallback(async (gridColumn: string, gridRow: string, handle?: string) => {
    if (!selectedKey) return;

    const bpPrefix = breakpoint === 'base' ? '' : `${breakpoint}:`;

    // Parse current grid placement from Yjs with breakpoint cascade
    const yEntry = doc.getMap('sourceClasses').get(selectedKey) as import('yjs').Map<unknown> | undefined;
    const classTokens = ((yEntry?.get('classes') as string) || '').split(/\s+/).filter(Boolean);
    const parsed = parseGridPlacement(classTokens, breakpoint);

    // Use actual rendered position as fallback for auto-placed elements.
    // Without this, auto-placed elements at col 3 would default to 1 and get teleported.
    const cellInfo = gridGeometryRef.current?.cells.find(c => c.key === selectedKey);
    const colStart = parsed['col-start'] ?? (cellInfo ? cellInfo.col + 1 : 1);
    const rowStart = parsed['row-start'] ?? (cellInfo ? cellInfo.row + 1 : 1);
    const colSpanVal = parsed['col-end'] ? (parsed['col-end'] - colStart) : (parsed['col-span'] ?? 1);
    const rowSpanVal = parsed['row-end'] ? (parsed['row-end'] - rowStart) : (parsed['row-span'] ?? 1);

    const newColSpan = gridColumn ? parseInt(gridColumn.replace('col-span-', ''), 10) || 1 : 1;
    const newRowSpan = gridRow ? parseInt(gridRow.replace('row-span-', ''), 10) || 1 : 1;

    // Determine which axes and edges the handle affects
    const isWest = handle != null && WEST_HANDLES.has(handle);
    const isNorth = handle != null && NORTH_HANDLES.has(handle);
    const affectsCol = handle !== 'n' && handle !== 's';
    const affectsRow = handle !== 'e' && handle !== 'w';

    // West/north handles shift the start position to keep the opposite edge fixed
    const newColStart = isWest ? Math.max(1, colStart + colSpanVal - newColSpan) : colStart;
    const newRowStart = isNorth ? Math.max(1, rowStart + rowSpanVal - newRowSpan) : rowStart;

    // Only emit col-start/row-start when the element already has explicit placement
    // or the handle moves the start edge. This preserves auto-placement for
    // east/south-only resizes on elements without explicit start classes.
    const hasExplicitCol = parsed['col-start'] !== null || parsed['col-end'] !== null;
    const hasExplicitRow = parsed['row-start'] !== null || parsed['row-end'] !== null;

    const colTokenStr = affectsCol
      ? buildAxisTokens(bpPrefix, 'col', newColStart, gridColumn, hasExplicitCol || isWest)
      : '';
    const rowTokenStr = affectsRow
      ? buildAxisTokens(bpPrefix, 'row', newRowStart, gridRow, hasExplicitRow || isNorth)
      : '';

    takeSnapshot();
    try { await acceptEditorCommands(doc, [{ type: 'SET_GRID_SPAN', key: selectedKey, gridColumn: colTokenStr, gridRow: rowTokenStr }], claimSnapshot()); }
    catch (error) { toast.error(t("Resize was not saved: {0}", { 0: error instanceof Error ? error.message : String(error) })); return; }
    syncClassToIframe(selectedKey);
    refreshGridState(selectedKey);
  }, [selectedKey, takeSnapshot, claimSnapshot, doc, breakpoint, syncClassToIframe, refreshGridState]);

  // Flow-draggable: any selected element that isn't absolute/fixed positioned.
  // This includes normal source elements and drawn elements changed to static.
  const isFlowDraggable = !!selectedKey &&
    selectedPosition !== 'absolute' && selectedPosition !== 'fixed' &&
    !isSelectedMovable; // Don't conflict with absolute move handler

  // Grid snapping only for a direct child of the measured grid — asked of the
  // geometry itself, so a card picked in the Layers panel snaps too.
  const effectiveGridGeometry = gridOfChild(gridGeometry, selectedKey);

  // Find all EMPTY slot elements on current page (no component filled yet)
  const slotElements = useScopedYjsValue<Array<{ key: string; slotType: string }>>((doc) => {
    if (!currentPageId) return [];
    const elements = doc.getMap('elements');
    const blogBindings = doc.getMap('blogSlotBindings');
    const result: Array<{ key: string; slotType: string }> = [];
    elements.forEach((value, key) => {
      const yEl = value as import('yjs').Map<unknown>;
      if (yEl.get('isDrawn') && yEl.get('slotType') && (yEl.get('pageId') as string) === currentPageId) {
        // Skip slots that are already filled (component markup or blog binding)
        if (yEl.get('slotComponentMarkup')) return;
        if (yEl.get('slotType') === 'blog' && blogBindings.has(key)) return;
        result.push({ key, slotType: yEl.get('slotType') as string });
      }
    });
    return result;
  }, [{ map: 'elements' }, { map: 'blogSlotBindings' }]);

  // Layout-instance ids whose default slot has at least one Yjs child.
  // Source of truth is Yjs (not iframe DOM) because the iframe is cross-origin
  // (the instance's URL) and `iframeRef.current.contentDocument` is null from
  // the editor — any DOM-based "is the slot filled" check would always read
  // empty. A layout slot is considered filled when any non-drawn element on
  // the page has parentId === layoutInstanceId.
  // Returned as a plain Record (not Set) because the editor's useYjsValue
  // equality check uses Object.keys, which treats every Set as equivalent.
  const filledLayoutInstanceMap = useScopedYjsValue<Record<string, true>>((doc) => {
    if (!currentPageId) return {};
    const elements = doc.getMap('elements');
    const filled: Record<string, true> = {};
    elements.forEach((value) => {
      const yEl = value as import('yjs').Map<unknown>;
      if ((yEl.get('pageId') as string) !== currentPageId) return;
      if (yEl.get('isDrawn')) return;
      const parentId = yEl.get('parentId') as string | null | undefined;
      if (parentId) filled[parentId] = true;
    });
    return filled;
  }, [{ map: 'elements' }]);

  const layoutSlotElements = useMemo(
    () => computeLayoutSlotElements(scannedElements, filledLayoutInstanceMap),
    [scannedElements, filledLayoutInstanceMap],
  );

  // Find all FILLED slot elements on current page (have component markup)
  const filledSlotElements = useScopedYjsValue<Array<{ key: string; slotType: string; componentName: string }>>((doc) => {
    if (!currentPageId) return [];
    const elements = doc.getMap('elements');
    const result: Array<{ key: string; slotType: string; componentName: string }> = [];
    elements.forEach((value, key) => {
      const yEl = value as import('yjs').Map<unknown>;
      if (yEl.get('isDrawn') && yEl.get('slotType') && yEl.get('slotComponentMarkup') && (yEl.get('pageId') as string) === currentPageId) {
        result.push({ key, slotType: yEl.get('slotType') as string, componentName: (yEl.get('slotComponentName') as string) || '' });
      }
    });
    return result;
  }, [{ map: 'elements' }]);

  // All drawn-slot elements on current page (regardless of fill state) — used
  // to render the always-visible "Slot" / "Blog Slot" identifier tag.
  const drawnSlotKeysForTag = useScopedYjsValue<Array<{ key: string; slotType: string }>>((doc) => {
    if (!currentPageId) return [];
    const elements = doc.getMap('elements');
    const result: Array<{ key: string; slotType: string }> = [];
    elements.forEach((value, key) => {
      const yEl = value as import('yjs').Map<unknown>;
      if (yEl.get('isDrawn') && yEl.get('slotType') && (yEl.get('pageId') as string) === currentPageId) {
        result.push({ key, slotType: yEl.get('slotType') as string });
      }
    });
    return result;
  }, [{ map: 'elements' }]);

  // Combined list of all slots (drawn + layout) for the always-visible tag,
  // independent of fill state.
  const taggedSlotElements = useMemo(() => {
    const layoutTagged = scannedElements
      .filter((el) => el.tagName === 'slot')
      .map((el) => ({ key: el.key, slotType: 'layout' as const }));
    return [...drawnSlotKeysForTag, ...layoutTagged];
  }, [drawnSlotKeysForTag, scannedElements]);

  // Selection color variant. Yjs-derived for elements with a Yjs entry
  // (drawn slots → blog/slot, component instances → component); the
  // `<slot>` tag check below paints layout slots cyan even though they
  // aren't Yjs elements. Child keys resolve via their owning entry — plain
  // created sections stay blue (selectionVariant.ts).
  const yjsSelectedVariant = useYjsValue<SelectionVariant>((doc) =>
    selectionVariantForKey(doc, selectedKey));

  const selectedVariant: SelectionVariant = useMemo(() => {
    if (!selectedKey) return yjsSelectedVariant;
    const scanned = scannedElements.find(se => se.key === selectedKey);
    return selectionVariantOf(yjsSelectedVariant, scanned?.tagName);
  }, [selectedKey, scannedElements, yjsSelectedVariant]);

  // Derive selected cell info once for both SelectionOverlay and GridOverlay
  const selectedCellInfo = effectiveGridGeometry?.cells.find(c => c.key === selectedKey) ?? null;

  // Lock badge: only an element with no source position is locked.
  const selectedLock = useMemo(() => {
    if (!selectedKey) return undefined;
    const result = deriveLockTier({ element: scannedByKey.get(selectedKey) ?? null, isLocalMode: !!localInstanceState });
    return { tier: result.tier, label: lockLabel(result) };
  }, [selectedKey, scannedByKey, localInstanceState]);

  // Pen elements: double-click the selection body to enter node-edit mode
  // (task-107). Canvas owns the edit-mode state via the onPenEditRequest prop.
  const handlePenEditDoubleClick = useMemo(() => {
    if (!selectedKey || !onPenEditRequest) return undefined;
    const yEl = doc.getMap('elements').get(selectedKey) as Y.Map<unknown> | undefined;
    if (!yEl?.get('penPath')) return undefined;
    return () => onPenEditRequest(selectedKey);
  }, [doc, selectedKey, onPenEditRequest]);

  let gridHighlightSpan: (typeof highlightedGridCell & { colSpan: number; rowSpan: number }) | null = null;
  if (highlightedGridCell && dragModeRef.current !== 'reparent') {
    const colSpan = selectedCellInfo?.colSpan ?? 1;
    const rowSpan = selectedCellInfo?.rowSpan ?? 1;
    gridHighlightSpan = { ...highlightedGridCell, colSpan, rowSpan };
  }

  return (
    <div className="flex flex-col items-center">
      <div
        data-testid="editor-canvas"
        onContextMenu={(e) => {
          const iframe = iframeRef.current;
          if (isPreview || isEditingText || !iframe) return;
          e.preventDefault();
          const frame = iframe.getBoundingClientRect();
          const x = (e.clientX - frame.left) / scale;
          const y = (e.clientY - frame.top) / scale;
          const at = { x: e.clientX, y: e.clientY };
          // Inside a selected layer: keep the (multi-)selection. Elsewhere: select by plain-click rules first.
          const onSelection = [selectedKey, ...additionalSelections.map(a => a.key)].some(key => {
            const r = key ? scannedElementsRef.current.find(el => el.key === key)?.rect : undefined;
            return !!r && x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
          });
          if (onSelection) { layerMenu.open(at); return; }
          layerMenu.arm(at);
          iframe.contentWindow?.postMessage({ type: 'SIMULATE_CLICK', payload: { x, y } }, '*');
        }}
        // task-116: no device frame in preview (D1) — the border/shadow would
        // hairline through behind the full-window iframe.
        className={`overflow-visible relative select-none ${!isIframeReady || isPreview ? '' : 'bg-bg shadow-flyout border border-stroke'}`}
        style={{
          width: isPreview ? '100%' : width,
          height: 'auto',
          display: 'block',
        }}
        onMouseEnter={(e) => {
          // When cursor re-enters iframe area during reparent drag,
          // send reenter message to iframe and clear reparent state
          if (reparentDragKey && iframeRef.current?.contentWindow) {
            const iframeRect = iframeRef.current.getBoundingClientRect();
            const iframeX = (e.clientX - iframeRect.left) / scale;
            const iframeY = (e.clientY - iframeRect.top) / scale;
            iframeRef.current.contentWindow.postMessage({
              type: 'DRAG_ELEMENT_REENTER_IFRAME',
              payload: { key: reparentDragKey, iframeX, iframeY }
            }, '*');
            setReparentDragKey(null);
          }
        }}
      >
        {/* Scroll passthrough overlay - captures wheel events and forwards clicks to iframe.
            task-116: NOT in preview. This sits on top of the iframe and is a
            second interception layer independent of the bridge's own listeners —
            it swallows every real click (re-emitting a synthetic SIMULATE_CLICK)
            and preventDefault()s every wheel event. Left mounted, it alone would
            keep the page unclickable and unscrollable no matter what mode the
            bridge is in. */}
        {!isPreview && <div
          ref={overlayRef}
          className="absolute inset-0 z-[100] select-none" // ui-lint-line: overlay stacking order (above iframe, below slot chrome + selection)
          onMouseDown={(e) => {
            // Right button: keep pointer events so the contextmenu lands here, not in the iframe.
            if (e.button === 2) return;
            setOverlayPointerEvents(false);

            // Arm the restore FIRST, before any hit-testing. This overlay is also
            // the wheel handler the canvas pans and zooms with, so leaving it at
            // pointer-events:none is not cosmetic — the canvas stops scrolling
            // entirely. Anything throwing in the hit-test path below used to skip
            // the scheduling (caught by a jsdom test where elementFromPoint is
            // undefined). The timeout is the floor; mouseup wins when it arrives.
            const restore = (): void => {
              setOverlayPointerEvents(true);
              document.removeEventListener('mouseup', handleMouseUp);
              window.clearTimeout(restoreTimer);
            };
            function handleMouseUp(): void { restore(); }
            document.addEventListener('mouseup', handleMouseUp);
            const restoreTimer = window.setTimeout(restore, 400);

            const elementUnder = document.elementFromPoint?.(e.clientX, e.clientY);
            if (elementUnder?.tagName === 'IFRAME') {
              const iframe = elementUnder as HTMLIFrameElement;
              const rect = iframe.getBoundingClientRect();
              const x = (e.clientX - rect.left) / scale;
              const y = (e.clientY - rect.top) / scale;

              if (aiContextModeRef.current && (e.metaKey || e.ctrlKey)) {
                // AI mode + Cmd/Ctrl: add element to AI context AND do normal selection
                iframe.contentWindow?.postMessage({
                  type: 'PICK_ELEMENT_AT_POINT',
                  payload: { x, y },
                }, '*');
              }
              iframe.contentWindow?.postMessage({
                type: 'SIMULATE_CLICK',
                payload: {
                  x,
                  y,
                  isDoubleClick: e.detail === 2,
                  ctrlKey: e.ctrlKey,
                  metaKey: e.metaKey,
                  shiftKey: e.shiftKey,
                }
              }, '*');
            }


          }}
          onMouseMove={(e) => {
            lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
            altKeyStore.set(e.altKey); // mouse events carry Option too: heals a missed keyup
            if (aiContextModeRef.current || e.altKey) forwardHover(lastPointerRef.current);
          }}
          onMouseLeave={() => {
            lastPointerRef.current = null;
            if (aiContextModeRef.current || altKeyStore.get()) forwardHover(null);
          }}
          style={{
            pointerEvents: !isIframeReady || isEditingText ? 'none' : 'auto',
            cursor: isAIContextMode ? 'crosshair' : undefined,
          }}
        />}
        {/* Boot overlay: cover screenshot (when one exists) + spinner (task-120 6.3) */}
        {!isIframeReady && <BootCoverOverlay projectId={projectId} />}
        {sourceError && (
          <div className="absolute top-2 left-2 right-2 z-overlay bg-bg shadow-flyout rounded-inner" data-testid="source-error-status">
            <OperationNotice title="Page has an error" detail={sourceErrorDetail(sourceError)} />
          </div>
        )}
        <iframe
          ref={(el) => {
            (iframeRef as React.RefObject<HTMLIFrameElement | null>).current = el;
            if (externalIframeRef) {
              (externalIframeRef as React.RefObject<HTMLIFrameElement | null>).current = el;
            }
          }}
          data-viewport
          onLoad={requestLocalRoute}
          // Decided above (finding 29 block): buildPreviewSrc for every
          // runtime, with the local-mode skip that keeps a native link
          // navigation from loading its page a second time.
          src={previewSrc}
          className="w-full border-0"
          style={{
            minHeight: 0,
            opacity: isIframeReady ? 1 : 0,
            pointerEvents: !isIframeReady || isDrawing ? 'none' : undefined,
            // task-116 (D1): full-window at 100% in preview. In design the iframe
            // is sized to the WHOLE page (contentHeight), so it has no scrollbar
            // of its own and position:sticky/fixed cannot work — overriding the
            // height is what buys native scroll AND working sticky headers (cost:
            // no viewport-width simulation in preview, resize the browser). The
            // `fixed` escape from the canvas overflow only holds because Canvas
            // sets transform:none on #canvas-content in preview.
            ...(isPreview
              ? { width: '100%', height: '100%', position: 'fixed', inset: 0, zIndex: 40 }
              : { width, height: localViewportHeight ?? (contentHeight || 'auto'), position: isIframeReady ? 'relative' : 'absolute' }),
          }}
          title={`${breakpoint} preview`}
        />
        {/* task-116: every editor overlay below is positioned against this
            frame's box, which the fixed full-window iframe vacates in preview —
            they would paint at stale coordinates, and the slot placeholder /
            warning buttons (pointer-events-auto, z 999) would steal clicks
            from the page. None of them belong in a live website. */}
        {!isPreview && <>
        {/* The alignment grid (top-bar Grid chip) comes first in DOM order, so every chrome below paints over it. */}
        {isIframeReady && <LayoutGridOverlay projectId={projectId} />}
        {isIframeReady && localInstanceState && (
          <ScreenHeightHandle
            height={designScreenHeight}
            width={width}
            scale={scale}
            bottom={localViewportHeight ?? designScreenHeight}
            content={sizingRef.current.fit.contentHeight}
            caption={[designScreenHeight, SCREEN_PRESETS[screenDevice].find(p => p.height === designScreenHeight)?.label].filter(Boolean).join(' · ')}
            onChange={(h) => setScreenHeight(projectId, screenDevice, h)}
          />
        )}
        {isIframeReady && isLayoutRootSelected && layoutRootKey && <LayoutSelectionGeometry layoutRootKey={layoutRootKey} />}
        {!suppressSelectionOverlay && <ViewportSelectionOverlay
          // ≥2 selected: every member is a plain outline (MultiSelectionRects) — no handles (ledger B1)
          suppressRect={isReorderPending || additionalSelections.length > 0}
          scale={scale}
          containerOffset={ZERO_OFFSET}
          isDragging={isDragging}
          isMovable={isSelectedMovable}
          onMove={handleMove}
          isFlowDraggable={isFlowDraggable}
          onFlowDragStart={handleFlowDragStart}
          onFlowDragMove={handleFlowDragMove}
          onFlowDragEnd={handleFlowDragEnd}
          gridGeometry={effectiveGridGeometry}
          selectedGridCell={selectedCellInfo}
          onGridSpanChange={handleGridSpanChange}
          onResizeStart={handleResizeStart}
          onResizeEnd={handleResizeEnd}
          variant={selectedVariant}
          onDoubleClick={handlePenEditDoubleClick}
          lock={selectedLock}
        />}
        <AIGlowRings rects={aiGlowRects} previewRect={aiPreviewRect} />
        {/* Outline-only rects for EVERY member while ≥2 are selected (the primary's handles are suppressed above) */}
        <MultiSelectionRects containerOffset={ZERO_OFFSET} />
        {/* Empty-image receiver frame — dashed placeholder over every <img> with
            no src. Purely decorative (pointer-events-none): normal click-to-select
            on the real (invisible) <img> underneath still works. Clears itself
            once ELEMENTS_SCANNED reports a non-empty imageSrc after an upload. */}
        {emptyImageElements.map(el => (
          <ElementGeometryOverlay key={`img-empty-${el.key}`} elementKey={el.key}>{rect => (
            <div
              className="absolute flex items-center justify-center pointer-events-none border border-dashed border-stroke-darker bg-bg-contrast z-[999]" // ui-lint-line: overlay stacking order (empty-image receiver frame)
              style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
            >
              <SharedImageIcon className="w-6 h-6 text-text-muted" />
            </div>
          )}</ElementGeometryOverlay>
          ))}
        <ImageUploadOverlay />
        {/* Slot placeholder buttons — absolute overlay on top of each slot element */}
        {[...slotElements, ...layoutSlotElements].map(slot => {
          return (<ElementGeometryOverlay key={slot.key} elementKey={slot.key}>{rect => (
            <div
              key={slot.key}
              className="absolute flex items-center justify-center pointer-events-none z-[999]" // ui-lint-line: overlay stacking order (slot chrome above scroll overlay)
              style={{
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
              }}
            >
              <Button
                variant="ghost"
                className="flex-col h-auto gap-1.5 px-4 py-3 rounded-lg font-normal text-text-muted hover:bg-black/5 hover:text-text pointer-events-auto"
                onClick={(e) => {
                  e.stopPropagation();
                  if (slot.slotType === 'blog') {
                    window.dispatchEvent(new CustomEvent('sq:slot-placeholder-click', {
                      detail: { key: slot.key, slotType: 'blog' },
                    }));
                  } else if (slot.slotType === 'layout') {
                    // Look up the slot's name attribute from the iframe DOM at click time.
                    const slotEl = iframeRef.current?.contentDocument?.querySelector(
                      `slot[data-key="${CSS.escape(slot.key)}"]`,
                    ) as HTMLElement | null;
                    const slotName = slotEl?.getAttribute('name') ?? '';
                    window.dispatchEvent(new CustomEvent('sq:layout-slot-click', {
                      detail: { slotName },
                    }));
                  } else {
                    window.dispatchEvent(new CustomEvent('sq:open-component-picker', {
                      detail: { slotKey: slot.key },
                    }));
                  }
                }}
              >
                <div className="w-8 h-8 rounded-full border-2 border-dashed border-current flex items-center justify-center">
                  <SharedPlusIcon className="w-4 h-4" />
                </div>
                <span className="text-xs-medium">
                  {slot.slotType === 'blog' ? 'Connect to Collection' : 'Choose Component'}
                </span>
              </Button>
            </div>
          )}</ElementGeometryOverlay>);
        })}
        {/* Identifier tag for slots and blog slots, shown only when the slot
            is selected. Cyan for regular/layout slots, yellow for blog slots.
            Anchored just above the slot's top-left corner. */}
        {taggedSlotElements
          .filter(slot => slot.key === selectedKey)
          .map(slot => {
            const isBlog = slot.slotType === 'blog';
            const label = isBlog ? 'Blog Slot' : 'Slot';
            const colorClasses = isBlog
              ? 'bg-overlay-selection/15 text-overlay-selection border-overlay-selection/40'
              : 'bg-overlay-component/15 text-overlay-component border-overlay-component/40';
            return (<ElementGeometryOverlay key={`tag-${slot.key}`} elementKey={slot.key}>{rect => (
              <div
                className={`absolute pointer-events-none select-none px-1.5 py-0.5 text-2xs leading-none font-medium rounded-t border border-b-0 ${colorClasses} z-[999]`} // ui-lint-line: overlay stacking order (slot chrome above scroll overlay)
                style={{
                  left: rect.left,
                  top: rect.top - 16,
                }}
              >
                {label}
              </div>
            )}</ElementGeometryOverlay>);
          })}
        {/* Missing-component warning on filled slots whose markup collapsed.
            Swap is reached via Backspace on inner content (CLEAR_DRAWN_SLOT_FILL)
            → empty slot → Choose Component, so no standalone swap affordance. */}
        {filledSlotElements.map(slot => {
          return (<ElementGeometryOverlay key={`warn-${slot.key}`} elementKey={slot.key}>{rect => {
          if (rect.height < 10 && slot.componentName) {
            return (
              <div
                key={`warn-${slot.key}`}
                className="absolute flex items-center gap-1.5 px-3 py-1.5 rounded bg-warning-subtle border border-warning/30 z-[999] pointer-events-auto" // ui-lint-line: overlay stacking order (slot chrome above scroll overlay)
                style={{ left: rect.left, top: rect.top }}
              >
                <span className="text-xs text-warning">⚠ {slot.componentName} not found</span>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto px-0 font-normal underline text-warning"
                  label="Swap"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.dispatchEvent(new CustomEvent('sq:open-component-picker', {
                      detail: { slotKey: slot.key },
                    }));
                  }}
                />
              </div>
            );
          }
          return null;
          }}</ElementGeometryOverlay>);
        })}
        <PixelGridOverlay scale={scale} />
        {gridGeometry && isGridOverlayVisible && dragModeRef.current !== 'reparent' && (
          <GridOverlay
            geometry={gridGeometry}
            containerOffset={ZERO_OFFSET}
            highlightedSpan={gridHighlightSpan}
          />
        )}
        </>}
      </div>
    </div>
  );
}
