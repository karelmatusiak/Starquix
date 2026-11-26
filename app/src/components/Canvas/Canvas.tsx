import { useCallback, useRef, useState, useEffect, useMemo, useSyncExternalStore } from 'react';
import { t } from '@/i18n';
import toast from 'react-hot-toast';
import { Button, OperationNotice } from '@/components/ui';
import { ViewportFrame } from './ViewportFrame';
import { DrawOverlay } from './DrawOverlay';
import { SOURCE_REFRESHED_EVENT } from './viewportMessages/sourceStatus';
import { PenOverlay, type PenEditResult } from './PenOverlay';
import { BreakpointBar } from './BreakpointBar';
import { DragGutter } from './DragGutter';
import { DropIndicator } from './DropIndicator';
import { PreviewHealthBanner, type RuntimeFailureKind } from './PreviewHealthBanner';
import { useYjsValue, useDispatch } from '@/store/hooks';
import { useUndoContext } from '@/context/UndoContext';
import { selectCurrentBreakpoint, selectCurrentPageId, selectPageComponents, selectPageDrawnCount } from '@/store/selectors';
import { BREAKPOINTS } from '@/store/types';
import { COMPONENT_EDITOR_PAGE_ID } from '@/store/constants';
import { useDropIndicator, useSelectionContext, useTool } from '@/context';
import { PREVIEW_SLIDE_TRANSITION } from '@/context/previewSlide';
import { useScannedElementsRef } from '@/context/SelectionContext';
import type { LocalInstanceResult, LocalInstanceLite } from '@/hooks/useLocalInstance';
import { useVariables } from '@/context/VariablesContext';
import { VariablesEditor } from '@/components/VariablesEditor/VariablesEditor';
import { subscribeLocalComponentView, getLocalComponentViewFile } from '@/services/localComponentView';
import { usePostEditor } from '@/context/PostEditorContext';
import { uploadPostMediaFile, uploadLocalPostFieldImage } from '@/utils/imageUpload';
import { useParams } from 'react-router-dom';
import { useSidebarTab } from '@/context/SidebarTabContext';
import { PostEditor } from '@/components/PostEditor/PostEditor';
import { useContentCollections } from '@/hooks/useContentCollections';
import { useLayoutLibrary } from '@/hooks/useLayoutLibrary';
import { useComponentLibrary } from '@/hooks/useComponentLibrary';
import { resolvedLayoutChrome } from '@/store/layoutElement';
import { PIXEL_GRID_ID, applyPixelGridStyle } from './PixelGridOverlay';
import { selectProjectId } from '@/store/selectors';
import { fitView, wheelZoomFactor, zoomAroundPoint, type ViewTransform } from './zoomMath';
import { executeZoomCommand, ZOOM_COMMAND_EVENT, type ZoomCommandAction } from './zoomCommands';
import { ZoomChip } from './ZoomChip';
import { generateDrawnKey } from '@/utils/generateId';
import { insertLocalDrawnElement } from './localDrawInsert';

const CANVAS_CONTENT_ID = 'canvas-content';

const BLOG_SLOT_SOURCE = 'library/BlogSlot.astro';

/**
 * Read BlogSlot.astro from disk and extract the outer <section> and posts
 * container classes so a fresh drop reflects any master edits. Returns empty
 * fields on any failure — the reducer falls back to baked-in defaults.
 */
async function fetchBlogSlotMaster(): Promise<{
  classes?: string;
  postsClasses?: string;
  staticMarkup?: string;
  astroSource?: string;
}> {
  try {
    const resp = await fetch(`/__sq/component-html?path=${encodeURIComponent(BLOG_SLOT_SOURCE)}`);
    if (!resp.ok) return {};
    const html = (await resp.text()).trim();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const section = doc.body.firstElementChild;
    if (!(section instanceof HTMLElement)) return { staticMarkup: html, astroSource: BLOG_SLOT_SOURCE };
    // Posts container = deepest non-<article> with a direct <article> child.
    let postsEl: HTMLElement | null = null;
    const walk = (n: HTMLElement): void => {
      if (n.tagName === 'ARTICLE') return;
      let hasArticleChild = false;
      for (const c of n.children) {
        if (!(c instanceof HTMLElement)) continue;
        if (c.tagName === 'ARTICLE') hasArticleChild = true;
        else walk(c);
      }
      if (hasArticleChild) postsEl = n;
    };
    walk(section);
    return {
      classes: section.getAttribute('class') || undefined,
      postsClasses: (postsEl as HTMLElement | null)?.getAttribute('class') || undefined,
      staticMarkup: html,
      astroSource: BLOG_SLOT_SOURCE,
    };
  } catch {
    return {};
  }
}

/**
 * gap-59: local-mode reload sweep. The doc-RENDER path fires the `sq:iframe-ready`
 * sweep (fonts CSS, design-variables CSS, instance-override re-apply) from
 * ViewportFrame AFTER the first RENDER that follows an iframe (re)load — but
 * local mode never sends RENDER (files are truth; a doc-RENDER would wipe the
 * user's real page), so after any local HMR full reload the injected session
 * CSS (SET_VARIABLES_CSS, SET_FONTS_CSS) died until a manual page switch.
 * In local mode the DOM is already final when the bridge announces
 * IFRAME_READY (no RENDER will ever follow), so the sweep fires straight off
 * the announce instead. Everything on this event path re-sends only keyed
 * css/patch channels — nothing dispatches RENDER, and ViewportFrame's
 * `if (localInstanceState) return` keeps doc-RENDER off local iframes.
 *
 * Returns a window `message` handler; pinned to the local iframe by source
 * identity. Exported for tests
 * (bridge/parts/__tests__/localReloadResend.test.ts).
 */
export function relayLocalIframeReady(
  getLocalContentWindow: () => Window | null | undefined,
): (event: MessageEvent) => void {
  return (event: MessageEvent): void => {
    const win = getLocalContentWindow();
    if (!win || event.source !== win) return;
    const type = (event.data as { type?: string } | null)?.type;
    if (type !== 'IFRAME_READY') return;
    window.dispatchEvent(new CustomEvent('sq:iframe-ready'));
  };
}

interface CanvasProps {
  activeDragId: string | null;
  isReorderPending?: boolean;
  /** task-132 local mode: spawned-instance state; overlay + iframe URL key off it. */
  localInstance?: LocalInstanceResult;
  runtimeFailureKind?: RuntimeFailureKind;
  currentPagePath?: string | null;
  /** task-133 Task 7: project-relative source file of the current page (local mode only). */
  currentPageFile?: string | null;
  iframeRef?: React.RefObject<HTMLIFrameElement | null>;
  /** The Assets tab with no component on the frame (Editor): the site stays covered. */
  hideSite?: boolean;
}

export function Canvas({ activeDragId, isReorderPending, localInstance, runtimeFailureKind, currentPagePath, currentPageFile, iframeRef, hideSite }: CanvasProps) {
  const dispatch = useDispatch();
  const routeProjectId = useParams<{ '*': string }>()['*'] ?? '';
  // Owns the content file for the editors running inside the preview iframe.
  const canvasRef = useRef<HTMLDivElement | null>(null);
  // State mirror so effects re-bind when the canvas node remounts.
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  // The just-drawn box, held until the next source refresh paints the element (1.5 s cap).
  const [drawLanding, setDrawLanding] = useState<{ left: number; top: number; width: number; height: number; className: string } | null>(null);
  useEffect(() => {
    if (!drawLanding) return;
    const clear = () => setDrawLanding(null);
    window.addEventListener(SOURCE_REFRESHED_EVENT, clear);
    const timer = setTimeout(clear, 1500);
    return () => { window.removeEventListener(SOURCE_REFRESHED_EVENT, clear); clearTimeout(timer); };
  }, [drawLanding]);

  const currentBreakpoint = useYjsValue(selectCurrentBreakpoint);
  const currentPageId = useYjsValue(selectCurrentPageId);
  // Resolved layout bodies (from discovery) keyed by name. selectPageComponents
  // splices the page's flat content roots into the matching body's <slot>s.
  // We RESOLVE the body (expand composed <Header/>/<Div2/> into HTML) so a layout
  // renders complete on page load — not only after the layout-chrome element is
  // lazily materialized on selection (the "click pulls header/footer" bug).
  const { layouts } = useLayoutLibrary();
  const { builtIn, userProject } = useComponentLibrary();
  const fullLibrary = useMemo(() => [...builtIn, ...userProject], [builtIn, userProject]);
  const layoutBodies = useMemo(
    () => new Map(layouts.map((l) => [l.name, resolvedLayoutChrome(l.body ?? '', fullLibrary)])),
    [layouts, fullLibrary],
  );
  const pageComponents = useYjsValue((doc) =>
    currentPageId ? selectPageComponents(doc, currentPageId, layoutBodies) : []
  );
  const { dropIndicator } = useDropIndicator();
  const { clearSelection, select } = useSelectionContext();
  const { activeTool, isPreview } = useTool();
  const isPreviewRef = useRef(isPreview);
  isPreviewRef.current = isPreview;
  const { scannedElementsRef } = useScannedElementsRef();
  const { takeSnapshot, pushStructuralUndo } = useUndoContext();
  // `removeOnCancel: true` is set when the picker is opened from a fresh
  // cmd-K BlogSlot drop — dismissing the picker should undo the drop. For
  // legacy drawn slots and placeholder-click re-binds the slot already exists
  // and stays put on cancel.
  // Drawn elements live outside selectPageComponents — count them too, or
  // drawing the first section on an empty page leaves the viewport hidden
  // (it shows in Layers but never on the canvas). See isRenderStateEmpty.
  const drawnCount = useYjsValue((doc) =>
    currentPageId ? selectPageDrawnCount(doc, currentPageId) : 0
  );
  // elementCount feeds the offscreen-rescue effect below (fires on add/delete).
  const elementCount = pageComponents.length + drawnCount;
  const hasElements = pageComponents.length > 0 || drawnCount > 0;
  const viewportWidth = BREAKPOINTS[currentBreakpoint];

  // Zoom and pan state — refs are source of truth during gestures,
  // state is flushed on gesture end for child prop reconciliation
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [canvasWidth, setCanvasWidth] = useState(0);

  // Refs for direct DOM manipulation during gestures (bypasses React re-renders)
  const contentRef = useRef<HTMLDivElement>(null);
  const gutterWrapRef = useRef<HTMLDivElement>(null);
  const zoomLabelRef = useRef<HTMLSpanElement | null>(null);
  const rafIdRef = useRef(0);
  const flushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs are the source of truth during gestures — do NOT sync from state
  const scaleRef = useRef(1);
  const positionRef = useRef({ x: 0, y: 0 });

  // Schedule a single rAF to apply transform directly to DOM.
  // task-116: the single choke point for every transform write (zoom, pan,
  // applyView, drag) — one guard here keeps preview's `transform: none` intact,
  // since these writes bypass React and it would not restore them.
  const scheduleTransformUpdate = useCallback(() => {
    if (isPreview) return;
    if (rafIdRef.current) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = 0;
      const s = scaleRef.current;
      const p = positionRef.current;
      if (contentRef.current) {
        contentRef.current.style.transform = `translate(${p.x}px, ${p.y}px) scale(${s})`;
        // Live inverse zoom for constant-size chrome inside the frame (ScreenHeightHandle).
        contentRef.current.style.setProperty('--sq-inv-scale', String(1 / s));
        // Mid-gesture the compositor scales the rasterized bitmap instead of re-rastering
        // the whole (page-tall) frame every step; cleared on settle → one sharp re-raster.
        contentRef.current.style.willChange = 'transform';
      }
      // Hide gutter during pan/zoom gestures — repositioned correctly on flush
      if (gutterWrapRef.current) {
        gutterWrapRef.current.style.opacity = '0';
      }
      // Live zoom readout during gestures — React state only flushes ~150ms
      // after the gesture ends, so write the label directly like the transform.
      if (zoomLabelRef.current) {
        zoomLabelRef.current.textContent = `${Math.round(s * 100)}%`;
      }
      // Pixel grid tracks live zoom like the label — React scale is stale
      // mid-gesture (150ms debounced flush).
      const grid = document.getElementById(PIXEL_GRID_ID);
      if (grid) applyPixelGridStyle(grid, s);
    });
  }, [isPreview]);

  // Flush refs to React state (triggers re-render for child prop reconciliation)
  const flushTransformToState = useCallback(() => {
    if (contentRef.current) contentRef.current.style.willChange = '';
    setScale(scaleRef.current);
    setPosition({ ...positionRef.current });
    // Show gutter again — React will re-render it at the correct position
    if (gutterWrapRef.current) {
      gutterWrapRef.current.style.opacity = '1';
    }
    // Pan/zoom settled — ViewportFrame relays REPAINT_FIXED so fixed-position
    // layers re-raster any newly revealed area (Chromium clip bug; see the
    // REPAINT_FIXED effect in ViewportFrame.tsx). Every gesture and programmatic
    // zoom funnels through this flush, so this is the single settle point.
    window.dispatchEvent(new Event('sq:canvas-transform-settled'));
  }, []);

  // Debounced flush for continuous gestures (wheel zoom)
  const scheduleFlush = useCallback(() => {
    if (flushTimeoutRef.current) clearTimeout(flushTimeoutRef.current);
    flushTimeoutRef.current = setTimeout(flushTransformToState, 150);
  }, [flushTransformToState]);

  // Cleanup rAF and flush timeout on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
      if (flushTimeoutRef.current) clearTimeout(flushTimeoutRef.current);
    };
  }, []);

  // Reset canvas position/zoom when navigating between pages.
  // task-116: this fires on every page change — including a preview link
  // navigation — so it must write 'none', not an identity transform, or it
  // would silently re-trap the iframe's `position: fixed` mid-preview.
  //
  // Design mode never scrolls (wheel = pan), so a reset shows the artboard
  // the way a web editor does: full WIDTH, top of page, never above 100% —
  // a 1280 xl artboard in a 900px canvas used to sit at 1:1 under both
  // sidebars (owner, 2026-09-10). Height is irrelevant to the width fit, so
  // no frame measurement is needed. Unmeasurable canvas (jsdom, hidden) → 1:1.
  // Computed in preview too: it is the design view restored when preview ends.
  const viewportWidthRef = useRef(viewportWidth);
  viewportWidthRef.current = viewportWidth;
  const resetView = useCallback(() => {
    const canvas = canvasRef.current;
    let view: ViewTransform = { scale: 1, x: 0, y: 0 };
    if (canvas && canvas.clientWidth > 2 && canvas.clientHeight > 2) {
      // The floating side panels cover the canvas edges: fit and centre in the gap. Measured here, not read from
      // Editor's --sq-panel-* (its effects run after this child's on the first load).
      const inset = (side: string) => document.querySelector<HTMLElement>(`[data-sq-panel="${side}"]`)?.offsetWidth ?? 0;
      const insetLeft = inset('left'), insetRight = inset('right');
      const fit = fitView({
        canvasWidth: canvas.clientWidth,
        canvasHeight: canvas.clientHeight,
        viewportWidth: viewportWidthRef.current,
        frameHeight: 0, // width-only, top-aligned
        insetLeft,
        insetRight,
      });
      view = fit.scale < 1 ? fit : { scale: 1, x: (insetLeft - insetRight) / 2, y: 0 };
    }
    scaleRef.current = view.scale;
    positionRef.current = { x: view.x, y: view.y };
    setScale(view.scale);
    setPosition({ x: view.x, y: view.y });
    if (contentRef.current) {
      contentRef.current.style.transform = isPreviewRef.current
        ? 'none'
        : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    }
    // Gestures write this label directly, so reset it with the transform.
    if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(view.scale * 100)}%`;
    // A reset is also a transform move that can reveal clipped frame area
    // (a reset without an iframe reload gets no ready-resend).
    window.dispatchEvent(new Event('sq:canvas-transform-settled'));
    // Keep this callback stable: Preview toggles must not trigger page reset.
  }, []);

  useEffect(() => {
    resetView();
  }, [currentPageId, resetView]);

  // The artboard changes size with the breakpoint → re-fit so it stays whole.
  useEffect(() => {
    resetView();
  }, [viewportWidth, resetView]);


  // When the element count changes (add OR delete), make sure the frame is
  // still in view — but only rescue when it is FULLY off-screen; a partially
  // visible frame never resets the view, so normal editing is never yanked.
  // Two ways users end up stranded:
  //  - first add on an empty page: the content div is hidden, so they can
  //    pan/zoom into the void with no anchor and the frame materializes
  //    wherever the drifted transform puts it;
  //  - deleting tall content while panned low: the page height shrinks and
  //    the view is left below the new page bottom, staring at empty canvas.
  // Schedules a delayed check; returns a cleanup that cancels it. Shared by
  // the element-count trigger below and the overlay-close trigger (returning
  // from Assets/Content — the frame can shrink or move while hidden, leaving
  // a preserved pan/zoom staring at empty canvas).
  const scheduleOffscreenRescue = useCallback(() => {
    const id = setTimeout(() => {
      const frame = iframeRef?.current;
      const canvas = canvasRef.current;
      if (!frame || !canvas) return;
      const f = frame.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      // Degenerate rects (detached node, display:none, height not yet
      // reported) must not trigger a reset — better to leave the view alone.
      if (f.width < 2 || f.height < 2 || c.width < 2 || c.height < 2) return;
      const intersects =
        f.right > c.left && f.left < c.right && f.bottom > c.top && f.top < c.bottom;
      if (!intersects) {
        resetView();
      }
    }, 600);
    return () => clearTimeout(id);
  }, [iframeRef, resetView]);

  const prevElementCountRef = useRef(0);
  useEffect(() => {
    const prev = prevElementCountRef.current;
    prevElementCountRef.current = elementCount;
    if (prev === elementCount || elementCount === 0) return;
    return scheduleOffscreenRescue();
  }, [elementCount, scheduleOffscreenRescue]);

  // Stable identity for the {status,url} pick — ViewportFrame keys effects on
  // it, and Canvas re-renders every selection/drag tick.
  // Desktop boot progress (desktopDriver relays main's state detail, e.g. "Installing astro-seo").
  const [bootProgress, setBootProgress] = useState<string | null>(null);
  useEffect(() => {
    const onProgress = (e: Event) => setBootProgress((e as CustomEvent<string | null>).detail ?? null);
    window.addEventListener('sq:preview-progress', onProgress);
    return () => window.removeEventListener('sq:preview-progress', onProgress);
  }, []);
  const localInstanceState = useMemo<LocalInstanceLite | undefined>(
    () => (localInstance ? { status: localInstance.status, url: localInstance.url } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [localInstance?.status, localInstance?.url],
  );

  // gap-59: see relayLocalIframeReady above. Wired ONLY for the local runtime —
  // the doc-RENDER path keeps its post-RENDER sweep in ViewportFrame.
  const isLocalRuntime = !!localInstance;
  useEffect(() => {
    if (!isLocalRuntime) return;
    const handler = relayLocalIframeReady(() => iframeRef?.current?.contentWindow);
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [isLocalRuntime, iframeRef]);

  // Phase 6: ONE runtime — the instance lifecycle ('idle' = about to open).
  const activeStatus: string = !localInstance ? 'starting'
    : localInstance.status === 'idle' ? 'starting' : localInstance.status;
  const isReady = activeStatus === 'running';
  // task-108 ledger #3: 'error' only arrives from a real failed probe (initial
  // state is 'stopped') — show it immediately; the old hasStartedRef gate left
  // a dead server-mode toggle on an infinite spinner.
  const hasError = activeStatus === 'error';
  // Seamless canvas case 29: an instance that ran and is now restarting keeps
  // its last frame on screen (read-only) with one status, never the boot spinner.
  const ranProjectRef = useRef<string | null>(null);
  if (activeStatus === 'running') ranProjectRef.current = routeProjectId;
  const recovering = activeStatus === 'starting' && !!localInstance && ranProjectRef.current === routeProjectId;

  // Panning state
  const isDragging = useRef(false);
  const dragStartPosition = useRef<{ x: number; y: number } | null>(null);

  // Click on background to deselect
  const handleBackgroundClick = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey) return; // Shift+click keeps a multi-selection (design ledger A8)
    const target = e.target as HTMLElement;
    // Only deselect if clicking directly on canvas background
    if (target === canvasRef.current || target.id === CANVAS_CONTENT_ID) {
      // Check if this was a drag (moved more than 5px)
      if (dragStartPosition.current) {
        const dx = Math.abs(e.clientX - dragStartPosition.current.x);
        const dy = Math.abs(e.clientY - dragStartPosition.current.y);
        if (dx > 5 || dy > 5) return; // Was a drag, not a click
      }
      clearSelection();
    }
  }, [clearSelection]);

  // Zoom at a specific screen position (used by both wheel handler and iframe callback)
  const zoomAtPoint = useCallback((screenX: number, screenY: number, deltaY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scaleFactor = wheelZoomFactor(deltaY);
    const next = zoomAroundPoint(
      { scale: scaleRef.current, x: positionRef.current.x, y: positionRef.current.y },
      { x: screenX - rect.left, y: screenY - rect.top },
      scaleRef.current * scaleFactor,
    );
    scaleRef.current = next.scale;
    positionRef.current = { x: next.x, y: next.y };
    scheduleTransformUpdate();
    scheduleFlush();
  }, [scheduleTransformUpdate, scheduleFlush]);

  // Pan by delta amounts
  const panBy = useCallback((deltaX: number, deltaY: number) => {
    positionRef.current = {
      x: positionRef.current.x - deltaX,
      y: positionRef.current.y - deltaY,
    };
    scheduleTransformUpdate();
    scheduleFlush();
  }, [scheduleTransformUpdate, scheduleFlush]);

  // PARITY RULE: programmatic zoom mutates the SAME refs and flushes through
  // the SAME rAF + 150ms-debounce path as gesture zoom — overlay, gutter and
  // flush behaviour stay identical (see docs/archive/plans/2026-06-11-zoom-ui-design.md).
  const applyView = useCallback((view: ViewTransform) => {
    scaleRef.current = view.scale;
    positionRef.current = { x: view.x, y: view.y };
    scheduleTransformUpdate();
    scheduleFlush();
  }, [scheduleTransformUpdate, scheduleFlush]);

  // Single listener for 'sq:zoom-command' (keyboard shortcuts + ZoomChip menu).
  useEffect(() => {
    const handler = (e: Event) => {
      if (isPreview) return; // zoom is off in preview (D1) — keyboard included
      const action = (e as CustomEvent).detail?.action as ZoomCommandAction | undefined;
      if (!action) return;
      executeZoomCommand(action, {
        getView: () => ({ scale: scaleRef.current, x: positionRef.current.x, y: positionRef.current.y }),
        applyView,
        getCanvasSize: () => {
          const el = canvasRef.current;
          return el ? { width: el.clientWidth, height: el.clientHeight } : null;
        },
        getFrameHeight: () => {
          // Screen px ÷ current scale = frame height in content px (same trick
          // as the off-screen rescue measurement above).
          const h = iframeRef?.current?.getBoundingClientRect().height;
          return h && h > 2 ? h / scaleRef.current : null;
        },
        viewportWidth,
      });
    };
    window.addEventListener(ZOOM_COMMAND_EVENT, handler);
    return () => window.removeEventListener(ZOOM_COMMAND_EVENT, handler);
  }, [applyView, iframeRef, viewportWidth, isPreview]);

  // Wheel handler for zoom and pan
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();

    if (e.ctrlKey || e.metaKey) {
      zoomAtPoint(e.clientX, e.clientY, e.deltaY);
    } else {
      panBy(e.deltaX, e.deltaY);
    }
  }, [zoomAtPoint, panBy]);

  // Mouse handlers for drag-to-pan
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (isPreview) return; // no canvas panning in preview
    const target = e.target as HTMLElement;
    // Only start drag on background
    if (target === canvasRef.current || target.id === CANVAS_CONTENT_ID) {
      isDragging.current = true;
      dragStartPosition.current = { x: e.clientX, y: e.clientY };
    }
  }, [isPreview]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    // Cancel pending debounced flush and flush immediately
    if (flushTimeoutRef.current) {
      clearTimeout(flushTimeoutRef.current);
      flushTimeoutRef.current = null;
    }
    flushTransformToState();
    // Keep dragStartPosition for click detection, clear after a tick
    setTimeout(() => {
      dragStartPosition.current = null;
    }, 0);
  }, [flushTransformToState]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging.current) {
      positionRef.current = {
        x: positionRef.current.x + e.movementX,
        y: positionRef.current.y + e.movementY,
      };
      scheduleTransformUpdate();
    }
  }, [scheduleTransformUpdate]);

  // Attach wheel listener with passive: false.
  // task-116: not in preview — this handler preventDefault()s every wheel event
  // to drive canvas zoom/pan, which would eat the page's native scroll.
  useEffect(() => {
    if (!canvasEl || isPreview) return;
    canvasEl.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvasEl.removeEventListener('wheel', handleWheel);
  }, [canvasEl, handleWheel, isPreview]);

  // Entering preview drops the selection so no stale outline survives the
  // transition (vs-design WebviewApp.tsx:511-516 parity).
  useEffect(() => {
    if (isPreview) clearSelection();
  }, [isPreview, clearSelection]);

  // Track canvas width and container top offset for viewport frame positioning
  const [canvasContainerTop, setCanvasContainerTop] = useState(0);

  useEffect(() => {
    if (!canvasEl) return;

    const updateMeasurements = () => {
      setCanvasWidth(canvasEl.clientWidth);
      setCanvasContainerTop(canvasEl.getBoundingClientRect().top);
    };

    const observer = new ResizeObserver(updateMeasurements);
    observer.observe(canvasEl);
    updateMeasurements();

    window.addEventListener('scroll', updateMeasurements, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', updateMeasurements);
    };
  }, [canvasEl]);

  // Calculate viewport frame position on canvas
  // (viewportWidth is declared above, next to hasElements, so the zoom-command
  // listener can use it)
  // pt-8 = 32px padding top, and the ViewportFrame is centered horizontally
  const viewportFrameLeft = position.x + ((canvasWidth - viewportWidth) / 2) * scale;
  // 32px from pt-8 padding
  const viewportFrameTop = position.y + 32 * scale;

  const setCombinedRef = useCallback((node: HTMLDivElement | null) => {
    canvasRef.current = node;
    setCanvasEl(node);
  }, []);

  // One creation path for every drawn element — DrawOverlay shapes/frames/
  // slots AND pen paths (PenPathResult is shape-compatible; pen commits carry
  // penPath and never run the slot/blog branches since activeTool === 'pen').
  const handleElementCreated = useCallback(async (result: {
    tag: string;
    classes: string;
    textContent: string;
    parentKey: string | null;
    insertIndex: number;
    staticMarkup?: string;
    penPath?: string;
    preview?: { left: number; top: number; width: number; height: number; className: string };
  }) => {
    if (!currentPageId) return;

    // task-133 Task 7: local (files-truth) runtime — drawn elements never
    // enter the doc (no doc-RENDER for local iframes). Serialize the payload
    // and write the real file immediately; selection lands post-rescan via
    // the pending-selection singleton. No dispatch, no snapshot.
    if (localInstance) {
      // Filmstrip 2026-11-08: the box vanished on mouseup and the element came ~280 ms later.
      if (result.preview) setDrawLanding(result.preview);
      const inserted = await insertLocalDrawnElement({
        draw: result,
        isSlotDraw: activeTool === 'slot' || activeTool === 'blog',
        scannedElements: scannedElementsRef.current,
        pageFile: currentPageFile ?? null,
        pushUndo: pushStructuralUndo,
      });
      if (!inserted.ok) setDrawLanding(null);
      return;
    }

    const key = generateDrawnKey();

    const slotType = activeTool === 'slot' ? 'slot' as const :
                     activeTool === 'blog' ? 'blog' as const :
                     undefined;

    // Blog slots inherit their initial classes + master version from the
    // current BlogSlot.astro source, so fresh drops reflect any master edits.
    const blogInit = slotType === 'blog' ? await fetchBlogSlotMaster() : {};

    takeSnapshot();
    try { await dispatch({
      type: 'ADD_DRAWN_ELEMENT',
      element: {
        key,
        tag: result.tag,
        classes: blogInit.classes ?? result.classes,
        textContent: result.textContent,
        parentKey: result.parentKey,
        insertIndex: result.insertIndex,
        pageId: currentPageId,
        slotType,
        postsClasses: blogInit.postsClasses,
        staticMarkup: slotType === 'blog' ? blogInit.staticMarkup : result.staticMarkup,
        penPath: result.penPath,
        astroSource: blogInit.astroSource,
      },
    }); } catch (error) { console.error('Draw was not saved', error); toast.error(t("Draw was not saved")); return; }

    // Select the newly drawn element in SelectionContext so:
    // 1. Ancestors are auto-expanded in the layers panel
    // 2. The DesignBar shows the new element
    // No rect: drawn elements land in FLOW, not at the drawn location — a rect
    // here paints the selection box in the wrong place until the next scan
    // corrects it (scanning.ts supplies the true rect).
    select(key, {
      tagName: result.tag,
      classes: result.classes,
    });

    // Yjs elements observer in ViewportFrame handles syncing to iframe
  }, [currentPageId, dispatch, takeSnapshot, pushStructuralUndo, select, activeTool, localInstance, scannedElementsRef, currentPageFile]);

  // ---- Pen node-edit mode (task-107) ----
  // Entry: ViewportFrame's onPenEditRequest prop (double-click on a selected
  // pen element's SelectionOverlay). In-place staticMarkup changes reach the
  // iframe through ViewportFrame's coalesced drawn observer — its diff also
  // tracks per-key markup (computeDrawnElementDiff `changed`). No sidecar here.
  const [editingPenKey, setEditingPenKey] = useState<string | null>(null);

  // Enter on a selected pen shape (useKeyboardShortcuts) opens node editing —
  // same entry as double-clicking the shape's SelectionOverlay.
  useEffect(() => {
    const onRequestPenEdit = (e: Event) => {
      const key = (e as CustomEvent<{ key?: string }>).detail?.key;
      if (typeof key === 'string') setEditingPenKey(key);
    };
    window.addEventListener('sq:request-pen-edit', onRequestPenEdit);
    return () => window.removeEventListener('sq:request-pen-edit', onRequestPenEdit);
  }, []);

  const handlePathEdited = useCallback(async (result: PenEditResult) => {
    if (!editingPenKey) return;
    // The end-of-session refit passes takeUndoSnapshot:false so it undoes
    // together with the last gesture instead of as its own step.
    if (result.takeUndoSnapshot !== false) takeSnapshot();
    try { await dispatch({
      type: 'UPDATE_PEN_PATH',
      elementId: editingPenKey,
      penPath: result.penPath,
      staticMarkup: result.staticMarkup,
      classes: result.classes,
    }); } catch (error) { console.error('Pen edit was not saved', error); toast.error(t("Pen edit was not saved")); }
  }, [editingPenKey, dispatch, takeSnapshot]);

  const handlePenElementDeleted = useCallback(async () => {
    if (!editingPenKey) return;
    takeSnapshot();
    try { await dispatch({ type: 'REMOVE_ELEMENT', elementId: editingPenKey }); }
    catch (error) { console.error('Pen deletion was not saved', error); toast.error(t("Pen deletion was not saved")); return; }
    setEditingPenKey(null);
  }, [editingPenKey, dispatch, takeSnapshot]);

  const handlePenEditExit = useCallback(() => setEditingPenKey(null), []);

  // Listen for slot placeholder clicks from iframe
  useEffect(() => {
    // Any slot placeholder — open the cmd+k component picker (the doc-truth
    // blog collection picker is retired, task-240).
    const handler = () => { window.dispatchEvent(new CustomEvent('sq:open-component-picker')); };
    window.addEventListener('sq:slot-placeholder-click', handler);
    return () => window.removeEventListener('sq:slot-placeholder-click', handler);
  }, []);

  const { activeCollectionId } = useVariables();
  const { editingPost } = usePostEditor();
  const { activeTopTab } = useSidebarTab();
  // An open waits for the route (up to 5 s) under the cover — no words meanwhile.
  const componentOpening = useSyncExternalStore(subscribeLocalComponentView, () => getLocalComponentViewFile() !== null);
  const { collections: diskCollections, refresh: refreshCollections } = useContentCollections();

  const docProjectId = useYjsValue(selectProjectId);

  // Post editor / Content placeholder / variables editor render as an OVERLAY
  // on top of the canvas — never instead of it. Unmounting the canvas destroys
  // the preview iframe, and remounting cold-reloads the page from the
  // instance's Astro server (multi-second blank canvas on tab return).
  const editingDiskPost = editingPost
    ? diskCollections
        .find(c => c.name === editingPost.collection)
        ?.posts.find(p => p.slug === editingPost.slug)
    : undefined;
  // THE upload path (task-144) — never a second one. Returns the project-relative
  // src the MDX attribute gets; the component's own resolveAsset takes it from there.
  const uploadPostMedia = useCallback(async (file: File): Promise<string> => {
    // The ROUTE id in local mode, not the doc's projectId: uploadLocalAssetFile
    // resolves the folder from the local_ recents entry, and only the route
    // carries that id.
    return uploadPostMediaFile(localInstance ? routeProjectId : (docProjectId ?? routeProjectId), file);
  }, [routeProjectId, docProjectId, localInstance]);

  // Frontmatter-image fields on a files-truth post write a POST-RELATIVE src
  // (an `image()` schema rejects `/uploads/…` — see uploadLocalPostFieldImage).
  // Local mode only.
  const uploadPostFieldMedia = useCallback(
    (postFile: string, file: File, field: string, collection: string) => uploadLocalPostFieldImage(routeProjectId, postFile, file, field, collection),
    [routeProjectId],
  );

  // Post-editor v2 gates its SqPostView previews on previewOrigin presence —
  // the instance's dev server (post-view route, task-207).
  const placeholder = (text: string | null) => (
    <div className="flex-1 flex items-center justify-center bg-bg-contrast text-text-secondary text-sm min-w-0">{text}</div>
  );
  const overlay = editingPost && editingDiskPost ? (
    <PostEditor
      key={`${editingPost.collection}/${editingDiskPost.slug}`}
      collectionName={editingPost.collection}
      post={editingDiskPost}
      focusBodyLine={editingPost.focusBodyLine}
      onPostUpdate={refreshCollections}
      previewOrigin={localInstance?.url ?? null}
      previewIframe={null}
      onUploadMedia={localInstance ? uploadPostMedia : undefined}
      onUploadFieldMedia={localInstance ? uploadPostFieldMedia : undefined}
    />
  ) : activeTopTab === 'content' ? (
    // On the Content tab with no post open, the page design canvas is
    // irrelevant — show a placeholder. Opening a post hits the branch above.
    placeholder(t('Select a post to edit'))
  ) : activeCollectionId ? (
    <VariablesEditor />
  ) : hideSite ? (
    // The Assets tab never shows the site: people dropped components into it (owner 2026-11-17).
    placeholder(componentOpening ? null : t('Select a component to edit'))
  ) : null;

  // Returning to the canvas from an overlay: rescue if the frame is fully
  // off-screen (same guard as the element-count trigger — a visible frame
  // never yanks the view).
  const overlayJustClosedRef = useRef(false);
  const hasOverlay = overlay !== null;
  useEffect(() => {
    const wasOverlay = overlayJustClosedRef.current;
    overlayJustClosedRef.current = hasOverlay;
    if (!wasOverlay || hasOverlay) return;
    return scheduleOffscreenRescue();
  }, [hasOverlay, scheduleOffscreenRescue]);

  return (
    <div className="relative isolate flex-1 flex flex-col bg-bg-contrast overflow-hidden min-w-0">
      {overlay && <div className="absolute inset-0 z-50 flex">{overlay}</div>}
      <div
        className="flex-1 flex flex-col min-h-0 min-w-0"
        // visibility (not display) keeps layout so bridge scan rects stay
        // valid if the hidden iframe reloads (e.g. a post save writing .md).
        style={{ visibility: overlay ? 'hidden' : 'visible' }}
      >
      {/* Breakpoint/zoom bar is chrome — in preview it SLIDES UP out of view
          (D1 drops the viewport-width simulation and zoom entirely). Kept
          mounted + in flow like the side panels; z-50 only in preview so it
          rides over the fixed full-window iframe (z-40) as it slides. */}
      <div className={`flex items-center h-10 border-b border-stroke bg-bg ${PREVIEW_SLIDE_TRANSITION} ${isPreview ? 'relative z-50 -translate-y-full' : ''}`}
        // The floating side panels cover the canvas edges: the chips centre between them.
        style={{ paddingLeft: 'var(--sq-panel-left, 0px)', paddingRight: 'var(--sq-panel-right, 0px)' }}>
        <BreakpointBar>
          <ZoomChip scale={scale} labelRef={zoomLabelRef} />
        </BreakpointBar>
      </div>
      <div
        ref={setCombinedRef}
        className="flex-1 overflow-hidden transition-colors relative"
        data-scroll-container
        data-canvas-keys
        // Draw/pen/handle gestures preventDefault their mousedown, which also keeps focus on the toolbar control that
        // had it; give the keyboard to the canvas the way a plain click on it would.
        onMouseDownCapture={(e) => { if (!e.currentTarget.contains(document.activeElement)) (document.activeElement as HTMLElement | null)?.blur(); }}
        onClick={handleBackgroundClick}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseUp}
      >
        {/* Loading/Error overlay - show until server is ready */}
        {recovering && (
          <div className="absolute inset-0 z-50" data-testid="preview-recovering">
            <div className="absolute top-3 left-1/2 -translate-x-1/2 w-80 bg-bg shadow-flyout rounded-inner">
              <OperationNotice title="Preview stopped — retrying" />
            </div>
          </div>
        )}
        {((!isReady && !recovering) || hasError) ? (
          <div className="absolute inset-0 flex items-center justify-center z-50">
            {hasError ? (
              <PreviewHealthBanner key={routeProjectId} status={activeStatus} detail={localInstance?.error}
                reason={runtimeFailureKind} onRetry={localInstance?.retry} />
            ) : (
              <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 border-2 border-text-secondary border-t-transparent rounded-full animate-spin" />
                <p className="text-xs text-text-muted">{bootProgress ? `${bootProgress}…` : 'Starting preview…'}</p>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* task-116: every editing overlay is gone in preview — the page
                must receive its own clicks, not the draw/pen/gutter chrome. */}
            {!isPreview && <>
            {/* Gutter + drop indicator — hidden during pan/zoom gestures,
                shown at correct position once gesture ends and state flushes */}
            <div
              ref={gutterWrapRef}
              className="absolute inset-0 pointer-events-none"
            >
              {canvasWidth > 0 && hasElements && !isReorderPending && currentPageId !== COMPONENT_EDITOR_PAGE_ID && (
                <DragGutter
                  scale={scale}
                  viewportFrameLeft={viewportFrameLeft}
                  viewportFrameTop={viewportFrameTop}
                  viewportWidth={viewportWidth}
                  canvasContainerTop={canvasContainerTop}
                />
              )}

              {canvasWidth > 0 && (
                <DropIndicator
                  isVisible={dropIndicator.isVisible}
                  top={dropIndicator.top}
                  scale={scale}
                  viewportFrameLeft={viewportFrameLeft}
                  viewportFrameTop={viewportFrameTop}
                  viewportWidth={viewportWidth}
                />
              )}
            </div>

            {/* A drawn box stays until the page shows its element (no blank gap after mouseup). */}
            {drawLanding && (
              <div className={`pointer-events-none ${drawLanding.className}`} data-testid="draw-landing"
                style={{ position: 'fixed', left: drawLanding.left, top: drawLanding.top, width: drawLanding.width, height: drawLanding.height, zIndex: 9999 }} />
            )}

            {/* Draw overlay - captures mouse events when tool is active */}
            <DrawOverlay
              scale={scale}
              position={position}
              canvasWidth={canvasWidth}
              viewportWidth={viewportWidth}
              iframeRef={iframeRef}
              onElementCreated={handleElementCreated}
              lockInstanceParenting={currentPageId !== COMPONENT_EDITOR_PAGE_ID}
            />

            {/* Bezier pen overlay (task-107): draw mode + node-edit mode */}
            <PenOverlay
              scale={scale}
              position={position}
              canvasWidth={canvasWidth}
              viewportWidth={viewportWidth}
              onPathCommitted={handleElementCreated}
              lockInstanceParenting={currentPageId !== COMPONENT_EDITOR_PAGE_ID}
              editingKey={editingPenKey}
              onPathEdited={handlePathEdited}
              onElementDeleted={handlePenElementDeleted}
              onEditExit={handlePenEditExit}
            />
            </>}

            <div
              ref={contentRef}
              id={CANVAS_CONTENT_ID}
              className="w-full h-full flex justify-center items-start pt-8"
              style={{
                // MUST be 'none' (not an identity transform) in preview: any
                // transform makes this a containing block, which would trap the
                // iframe's `position: fixed` inside the canvas box.
                transform: isPreview
                  ? 'none'
                  : `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                transformOrigin: '0 0',
                '--sq-inv-scale': isPreview ? 1 : 1 / scale,
                // No empty-page hiding here: an empty page shows its (blank)
                // viewport frame (round-2 blind-judge S1 finding).
              } as React.CSSProperties}
            >
              <ViewportFrame
                breakpoint={currentBreakpoint}
                scale={scale}
                isDragging={activeDragId !== null}
                // isDrawing sets pointerEvents:none on the iframe — a tool left
                // armed would make preview unclickable, so force it off (task-116).
                isDrawing={!isPreview && (activeTool === 'frame' || activeTool === 'text' || activeTool === 'slot' || activeTool === 'blog')}
                isReorderPending={isReorderPending}
                isPreview={isPreview}
                onZoom={zoomAtPoint}
                onPan={panBy}
                localInstanceState={localInstanceState}
                currentPagePath={currentPagePath}
                externalIframeRef={iframeRef}
                layoutBodies={layoutBodies}
                suppressSelectionOverlay={!!editingPenKey}
                onPenEditRequest={setEditingPenKey}
              />
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  );
}
