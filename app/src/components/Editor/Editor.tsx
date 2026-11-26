import { GripIcon as SharedGripIcon } from '@/assets/icons';
import { t } from '@/i18n';
import { dispatchDurableAction } from '@/store/durableDispatch';
import { sourceActionFailure } from '@/utils/sourceActionFeedback';
// src/components/Editor/Editor.tsx
import { useState, useCallback, useEffect, useRef, useMemo, useSyncExternalStore, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCoverCapture } from '@/hooks/useCoverCapture';
import type * as Y from 'yjs';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DragMoveEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui';
import { LayerContextMenu } from './LayerContextMenu';
import { EditorProvider, useEditorDoc, useDispatch, useScopedYjsValue, useCurrentPageId } from '@/store';
import { applyCommand } from '@/store/commands';
import { readComponentSource } from '@/utils/componentSourceReader';
import { useUndoContext } from '@/context/UndoContext';
import { selectCurrentPageId, selectProjectId, selectPageRootElements, selectRootElementIds, selectPageLayout } from '@/store/selectors';
import { useProjectSync, seedLocalDynamicPages, pruneLocalDynamicPages, ProjectNotFoundError } from '@/store/useProjectSync';
import { LeftSidebar } from '@/components/LeftSidebar';
import { Canvas } from '@/components/Canvas';
import { DesignBar } from '@/components/DesignBar';
import { Footer } from '@/components/Footer';
import { PostEditorProvider, usePostEditor } from '@/context/PostEditorContext';
import { SidebarTabProvider, useSidebarTab } from '@/context/SidebarTabContext';
import {
  ClassStoreProvider,
  SelectionProvider,
  StateProvider,
  BreakpointProvider,
  ThemeProvider as DesignThemeProvider,
  RemoteGraphProvider,
  useDropIndicator,
  DropIndicatorProvider,
  UndoProvider,
  ToolProvider,
  useTool,
} from '@/context';
import { PREVIEW_SLIDE_TRANSITION } from '@/context/previewSlide';
import { PagesProvider } from '@/context/PagesContext';
import { ComponentPickerModal, isThemeComponentTemplate, resolvePreset, type PageTemplatePreset, type ScannedComponent, type ThemeComponentTemplate } from '@/components/ComponentPickerModal';
import { insertTemplateComponents } from '@/store/pageTemplateInsert';
import { planEntryDeletion, publishEntryDeletions, type EntryDeletion } from '@/hooks/keyboardShortcutsHelpers';
import { startMaterializer, requestMaterialization } from '@/services/durableEdits/materializer';
import { armPageSwitchFlushBoundary, flushPendingSourceWrites } from '@/utils/pendingSourceWrites';
import { DeployModal } from '@/components/DeployModal';
import { VersionsWindow } from '@/components/VersionPanel';
import { isDesktop } from '@/services/desktopDriver';
import { createGitClient } from '@/services/git/gitClient';
import { useKeyboardShortcuts, useComponentsModal, useReorderElements } from '@/hooks';
import { useAutoConvertSvgSelection } from '@/hooks/useAutoConvertSvgSelection';
import { clearDropZone } from '@/components/LayersPanel/dropZoneStore';
import { useLayersDrag } from '@/components/Editor/useLayersDrag';
import { TelemetryPanel } from '@/components/DevTools/TelemetryPanel';
import { useVariablesSync } from '@/hooks/useVariablesSync';
import { useFontsSync } from '@/hooks/useFontsSync';
import { useAssetRehydration } from '@/hooks/useAssetRehydration';
import { createDefaultCollection } from '@/core/variables/types';
import { BLOG_SLOT_COMPONENT_TYPE } from '@/core/collections/types';
import { useComponentLibrary } from '@/hooks/useComponentLibrary';
import { useOrphanToast } from '@/hooks/useOrphanToast';
import { masterSaveRequest, resolveRelImport, resolveComponentSourcePath } from '@/utils/astroAssetPaths';
import { useScannedElements, useScannedElementsRef, useSelectionContext, useSelectionRefs } from '@/context/SelectionContext';
import { useProjectCardSources } from '@/utils/cardTitleLock';
import { ListConversionOnOpen } from './ListConversionOnOpen';
import { useContentCollections } from '@/hooks/useContentCollections';
import { useLocalProjectPath } from '@/hooks/useLocalProjectPath';
import { useLocalScanVersion } from '@/hooks/useLocalPageLayout';
import { getFilesTruthSyncStatus, subscribeFilesTruthSyncStatus } from '@/services/filesTruthSync';
import { McpProvider } from '@/mcp/McpContext';
import { findLocalProjectEntry, localPageId, resolveLocalPagePath, resolveLocalPageFile } from '@/utils/localMode';
import { watchLocalPageFiles } from '@/store/localPages';
import { setLocalExpectedRoute, setLocalPageFile } from '@/utils/localPageSync';
import { useLocalCrossFileToast } from './useLocalCrossFileToast';
import { UpdateToast } from './UpdateToast';
import { useSaveConflictToast } from './useSaveConflictToast';
import { insertLocalComponent } from '@/components/Editor/localComponentInsert';
import { bindInsertedBlogSlot } from '@/components/Editor/localBlogInsert';
import { mergeStructuralRecords, type PushStructuralUndo, type StructuralUndoRecord } from '@/store/structuralUndo';
import { waitForLocalScan } from '@/utils/localPageSync';
import { isLayoutComponent, applyLocalPageLayout } from '@/components/Editor/localLayoutApply';
import { moveLocalElement, planGutterLocalMove, isSourceKeyedElementKey } from '@/components/Editor/localStructuralOps';
import { clearLocalPendingSelection } from '@/utils/localPendingSelection';
import { getLocalComponentViewFile } from '@/services/localComponentView';
import { setLocalContentSource } from '@/core/collections/content-ops';
import { useLocalInstance } from '@/hooks/useLocalInstance';
import { useFilesTruthMirror } from '@/hooks/useFilesTruthMirror';
import { desktopDriver } from '@/services/desktopDriver';
import { downloadFilesTruthZip } from '@/export/filesTruthZip';
import { ExportActionError, exportFailureMessage } from '@/export/operationFailure';
import { setServerWriteMode } from '@/services/serverWriteMode';
import { setLocalComponentViewFile } from '@/services/localComponentView';
import { switchLocalComponentView } from '@/context/hooks/useClassPersistenceQueue';
import { awaitProjectFiles, flushDurableSourceWrites } from '@/services/durableEdits/sourceMaterialization';
export { appendComponentToLayoutSource } from '@/services/durableEdits/layoutAppend';
import type { Project } from '@/api/types';
import { YjsGraphStore } from '@/core/state/yjsStore';
import type { GraphMutationCommand, TransactOptions } from '@/core/state/types';
import { DRAG_TYPES, GutterId } from '@/types/drag';
import { ThemesLibraryProvider } from '@/context/ThemesLibraryContext';
import { AIProvider } from '@/ai/AIContext';
import { VariablesProvider, useVariables } from '@/context/VariablesContext';
import { setupTestHelper, cleanupTestHelper } from '@/utils/testHelper';
import { generateId } from '@/utils/generateId';
import { materializeIconComponent } from '@/utils/iconLibrary';

/** Send the new element order to the iframe for immediate visual update. */
function sendReorderToIframe(elementKeys: string[]): void {
  window.postMessage({
    type: 'REORDER_ELEMENTS_IN_IFRAME',
    payload: { elementIds: elementKeys },
  }, '*');
}

interface EditorContentProps {
  projectId: string;
  onProjectMissing?: () => void;
}

const DESIGN_BAR_MIN_WIDTH = 280;
const DESIGN_BAR_MAX_WIDTH = 600;
const DESIGN_BAR_DEFAULT_WIDTH = 320;
const DESIGN_BAR_WIDTH_STORAGE_KEY = 'starquix:design-bar-width';


/** The export action reads the project rows only after accepted edits reach them. */
export async function exportFilesTruthProject(projectId: string, projectName: string, doc: import('yjs').Doc): Promise<void> {
  try { await awaitProjectFiles(projectId); }
  catch (cause) { throw new ExportActionError('files', cause); }
  try { await downloadFilesTruthZip(projectId, projectName, doc); }
  catch (cause) { throw new ExportActionError('archive', cause); }
}

function EditorContent({ projectId, onProjectMissing }: EditorContentProps) {
  const doc = useEditorDoc();
  const dispatch = useDispatch();
  // EditorProvider mounts children only after its durable storage probe succeeds.
  useEffect(() => {
    const stop = startMaterializer(projectId);
    // A restart has no old editor surface to preserve: drain durable layout
    // appends from the previous session before its fresh projection settles.
    void flushDurableSourceWrites(projectId).catch(() => {});
    return stop;
  }, [projectId]);
  useSaveConflictToast(projectId);
  const currentPageId = useCurrentPageId();
  // Deferred source writes (Push-to-source) land at the page-switch boundary,
  // where the preview reload they cause is masked by the navigation. The
  // boundary is a synchronous Yjs observer, NOT an effect on currentPageId: an
  // effect runs after the commit that already pointed ViewportFrame at the new
  // route, so the class queue's flush (postMessage into the preview) raced the
  // old document's teardown and its lost-ack recovery verified against the new
  // page's bytes. The observer fires inside the page-switch transaction, while
  // the old page is still the surface. The mount-time call is a free no-op
  // (flush early-returns on an empty queue); the journal replay recovers class
  // writes a previous session's pagehide flush could not deliver.
  useEffect(() => {
    void flushPendingSourceWrites().catch(() => {});
    const disarmBoundary = armPageSwitchFlushBoundary(doc, () => selectCurrentPageId(doc));
    return () => {
      disarmBoundary();
    };
  }, [doc]);
  // Component library for inline tag expansion when refreshing the editor
  // element's staticMarkup after a source-write to a layout/component.
  const { builtIn: libraryBuiltIn, userProject: libraryUserProject } = useComponentLibrary();
  const fullComponentLibrary = useMemo(() => [...libraryBuiltIn, ...libraryUserProject], [libraryBuiltIn, libraryUserProject]);
  const rootElements = useScopedYjsValue((d) =>
    currentPageId ? selectPageRootElements(d, currentPageId) : [],
    [{ map: 'pages' }, { map: 'elements' }, { map: 'postPageBindings' }],
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  // Publish and Versions are two windows, one open at a time (docs/plans/2026-10-20-publish-sheet-design.md S3).
  const [publishWindow, setPublishWindow] = useState<'publish' | 'versions' | null>(null);
  const deployGithub = useMemo(() => (isDesktop() ? { client: createGitClient(projectId) } : undefined), [projectId]);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [isReorderPending, setHideGutterHandles] = useState(false);
  const reorderPendingRef = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const { takeSnapshot, claimSnapshot, pushStructuralUndo } = useUndoContext();
  const { activeCollectionId } = useVariables();
  const { editingPost, closePost } = usePostEditor();
  const { activeTopTab } = useSidebarTab();
  const { isPreview, sidebarsHidden } = useTool();
  // ⌘\ hides the panels while the window keeps its size. Open flyouts (ui/Popover), the
  // post editor's toolbars and the frame's fixed-layer repaint (ViewportFrame) all follow
  // `resize` already, so tell them the layout moved instead of wiring each one up.
  useEffect(() => { window.dispatchEvent(new Event('resize')); }, [sidebarsHidden]);
  // The side panels float over the canvas, so ⌘\ only shows or hides them: the canvas box never
  // changes and the artboard stays put. Their widths are the canvas chrome's insets (top bar,
  // page-reset fit), 0 while hidden.
  const layoutRef = useRef<HTMLDivElement>(null);
  const leftPanelRef = usePanelInset(layoutRef, '--sq-panel-left');
  const rightPanelRef = usePanelInset(layoutRef, '--sq-panel-right');
  // 🏠 (sidebar top-left): snapshot the canvas as the project's cover, then leave.
  const navigate = useNavigate();
  const { captureScreenshot } = useCoverCapture({ iframeRef, projectId });
  const handleBackToProjects = useCallback(async () => {
    await captureScreenshot();
    navigate('/');
  }, [captureScreenshot, navigate]);

  // Clear post editor when a variable collection is selected
  // (but NOT on page changes — post page navigation should keep editor open)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (activeCollectionId && editingPost) closePost();
  }, [activeCollectionId]);

  // DesignBar resizable width
  const [designBarWidth, setDesignBarWidth] = useState(() => {
    const saved = localStorage.getItem(DESIGN_BAR_WIDTH_STORAGE_KEY);
    return saved ? parseInt(saved, 10) : DESIGN_BAR_DEFAULT_WIDTH;
  });
  const [isResizingDesignBar, setIsResizingDesignBar] = useState(false);

  // DnD sensors with activation constraint
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 8px drag threshold
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const { rootElements: gutterRootElements, reorderRootElements } = useReorderElements();
  const { showDropIndicator, hideDropIndicator } = useDropIndicator();
  // Ref-based: Editor only reads scans inside callbacks — subscribing
  // reactively re-rendered the whole Editor tree on every scan for nothing.
  const { scannedElementsRef, scannedByKeyRef } = useScannedElementsRef();
  // Selection read at click time (picker replace flow) — ref-based: no
  // re-render on selection changes, and the memoized handler never sees a
  // stale value.
  const { selectedKeyRef } = useSelectionRefs();
  const { clearSelection } = useSelectionContext();

  // After a reorder, hide gutter handles until iframe rescans with new positions.
  // This prevents handles flashing at stale positions during the ~50-100ms gap.
  useEffect(() => {
    if (reorderPendingRef.current) {
      reorderPendingRef.current = false;
      setHideGutterHandles(false);
    }
  }, [gutterRootElements]);

  // Selecting a static svg silently converts it into an editable pen shape.
  useAutoConvertSvgSelection();
  const filesTruth = useFilesTruthMirror(projectId);
  useVariablesSync(iframeRef);
  useFontsSync(iframeRef);
  useAssetRehydration(projectId);

  // The project's instance: the desktop app's local server runs its files.
  // The path is the synthetic `wc://<id>` the transport is scoped to; null until
  // the files-truth mirror has resolved, which the hook reports as not-ready.
  const localPath = useMemo(
    () => findLocalProjectEntry(projectId)?.path ?? null,
    [projectId, filesTruth],
  );
  const localInstance = useLocalInstance(projectId, localPath, { driver: desktopDriver, deferDiscovery: true });
  // Accepted edits waiting on a runtime materialize once the instance answers.
  useEffect(() => { if (localInstance.status === 'running') requestMaterialization(projectId); }, [localInstance.status, projectId]);
  // Discovered slugs nest as sub-pages of the page whose content links them
  // (blog convention); the '[slug]' placeholder row is dropped.
  // Re-seeds on EVERY discovery update — seedLocalDynamicPages is idempotent
  // per path, and gating this to run once meant a post created mid-session
  // never appeared as a page until reload (owner, 2026-08-10): the
  // sq:content-changed rescan updated dynamicInstances, but nothing carried
  // the new instance into the pages doc.
  // ...and the INVERSE: a post deleted from the Content tab shrinks
  // dynamicInstances, but seeding only adds — prune doc pages whose post is
  // gone. Gated on discoveryDone so a spawn whose discovery has not resolved
  // yet (boot, retry) never nukes seeded pages with a transient empty list.
  useEffect(() => {
    if (localInstance.dynamicInstances.length > 0) {
      seedLocalDynamicPages(doc, localInstance.dynamicInstances);
    }
    if (localInstance.status === 'running' && localInstance.discoveryDone) {
      pruneLocalDynamicPages(
        doc,
        localInstance.dynamicInstances,
        localInstance.pages.map(p => p.route),
      );
    }
  }, [localInstance.status, localInstance.discoveryDone,
      localInstance.dynamicInstances, localInstance.pages, doc]);
  // task-270: a page file an agent or git creates or removes outside Add /
  // Delete Page becomes / stops being a page without a reopen.
  useEffect(() => watchLocalPageFiles(doc, projectId, localInstance.pages), [doc, projectId, localInstance.pages]);

  // task-136/137: an open user component/layout overrides the iframe route
  // with the injected lone-component view. Set via the sq:local-component-view
  // event from LeftSidebar; cleared on page switch (ledger E1/E3).
  const [localComponentFile, setLocalComponentFile] = useState<string | null>(null);
  // The Assets tab with no component on the frame: Canvas hides the site.
  const componentsTabEmpty = activeTopTab === 'assets' && !localComponentFile;
  // The page canvas is what's on screen — not the variables/post editor, not
  // the Content tab, not an empty Assets tab. Design props and
  // design tools exist only here.
  const designSurface = !activeCollectionId && !editingPost && activeTopTab !== 'content' && !componentsTabEmpty;
  useKeyboardShortcuts(designSurface);
  useEffect(() => {
    const h = (e: Event) => {
      const file = ((e as CustomEvent).detail?.file ?? null) as string | null;
      // Read BEFORE switchLocalComponentView, which writes this store.
      const alreadyOpen = file !== null && file === getLocalComponentViewFile();
      // A surface switch (page ⇄ master view) leaves the OLD surface's key
      // selected; the DesignBar then headlines an element that is not on
      // screen (owner report 2026-09-16: 'Feature2' header back on the page).
      if (file !== getLocalComponentViewFile()) clearSelection();
      // task-143: mirror for deep panels — and the mirror is what flushes the
      // pending class write, so setLocalComponentFile (which moves the iframe's
      // src) only runs once that write is on disk. Setting both here made the
      // frame load PRE-write bytes; switchLocalComponentView owns the order.
      void switchLocalComponentView(file, setLocalComponentFile);
      // Opening a master SELECTS its root (owner report 2026-09-11: "I select
      // the layout, the right panel shows nothing"). The view's scan lists the
      // file's own elements in document order — the layout <body> / the
      // component root first — so the file path is the pending-select prefix.
      // `deferred` when the view is about to CHANGE: the page's own scan also
      // lists the layout file (the body), so an immediate match would select
      // it on the page and the fresh master scan would find nothing pending
      // (owner report 2026-09-11: "go to master → nothing is selected").
      if (file) window.dispatchEvent(new CustomEvent('sq:pending-select', { detail: { elementId: file, deferred: !alreadyOpen } }));
    };
    window.addEventListener('sq:local-component-view', h);
    return () => window.removeEventListener('sq:local-component-view', h);
  }, [clearSelection]);
  useEffect(() => { setLocalComponentFile(null); setLocalComponentViewFile(null); }, [currentPageId]);

  // Current page's real route for the iframe URL (page ids are derived from
  // routes/paths with localPageId — same function the doc seeding used).
  // task-145: the mapping lives in resolveLocalPagePath — a doc page with no
  // backing file must NEVER alias another page's route (edits there
  // source-wrote the aliased file).
  const currentPageName = useScopedYjsValue((d) =>
    currentPageId ? ((d.getMap('pages').get(currentPageId) as Y.Map<unknown> | undefined)?.get('name') as string | undefined) ?? null : null,
    [{ map: 'pages', keys: currentPageId ? [currentPageId] : [] }],
  );
  const currentPagePath = useMemo(() => {
    if (localComponentFile) return `/__sq_component_view/${localComponentFile}`;
    return resolveLocalPagePath({
      currentPageId,
      currentPageName,
      pages: localInstance.pages,
      dynamicInstances: localInstance.dynamicInstances,
    });
  }, [localInstance.pages, localInstance.dynamicInstances, currentPageId, currentPageName, localComponentFile]);

  // Wrong-file-write guard (live-smoke Critical): arm the route the CURRENT
  // page expects the iframe to be showing. Local structural ops refuse while
  // the last scan disagrees with it — currentPageFile flips synchronously with
  // the page id, but the iframe navigation + rescan lag (and if a switch never
  // propagates, they never agree), and a write resolved from the previous
  // page's scan lands in the WRONG real file. null disarms the gate entirely.
  useEffect(() => {
    setLocalExpectedRoute(currentPagePath);
    return () => setLocalExpectedRoute(null);
  }, [currentPagePath]);

  // task-133: the pending-selection singleton must not leak across project
  // switches — it is normally consumed by the next covering scan, but if that
  // rescan never lands (task-146 class) it would survive into the NEXT
  // project and auto-select a wrong element (file:line keys like
  // src/pages/index.astro:N exist in every project). Sweep on
  // both mount and unmount.
  useEffect(() => {
    clearLocalPendingSelection();
    return () => clearLocalPendingSelection();
  }, []);

  // task-133: the current page's backing FILE (src/pages/…) for structural
  // writes. Route ≠ file — currentPagePath is the iframe URL; this is the
  // write target. null = no backing file yet (boot / doc-only page).
  const currentPageFile = useMemo(() => {
    return resolveLocalPageFile({
      currentPageId,
      pages: localInstance.pages,
      dynamicInstances: localInstance.dynamicInstances,
      componentViewFile: localComponentFile,
    });
  }, [localInstance.pages, localInstance.dynamicInstances, currentPageId, localComponentFile]);

  // task-133 Task 9: LIVE getter for the AI structural tools (Footer →
  // useAIAgent → ToolExecutionContext). The AI can select_page mid-run — a
  // value captured at submit time would go stale, so the ref is re-stamped
  // every render and the getter identity stays stable.
  const currentPageFileRef = useRef<string | null>(null);
  currentPageFileRef.current = currentPageFile;
  const getCurrentPageFile = useCallback(() => currentPageFileRef.current, []);

  // Cross-file structural guard (data-loss incident 2026-08-02): publish the
  // page's backing FILE alongside expectedRoute, so a structural op can tell a
  // same-file edit from one that rewrites a SHARED component. null (non-local,
  // boot, doc-only page) reads as "unknown" = treated as cross-file.
  useEffect(() => {
    setLocalPageFile(currentPageFile);
    return () => setLocalPageFile(null);
  }, [currentPageFile]);

  // Refusal UX for that guard: a refused instance-scope edit toasts the
  // component's name with a one-click Open (the Assets panel's own navigation).
  useLocalCrossFileToast();

  // task-108 §7: arm source-writers only when a preview server is the runtime
  useEffect(() => {
    setServerWriteMode(true);
    return () => setServerWriteMode(false);
  }, []);

  // task-138: Content tab reads/writes the local folder's real src/content files
  useEffect(() => {
    setLocalContentSource(localPath);
    return () => setLocalContentSource(null);
  }, [localPath]);

  // task-118: toast when a structural source edit orphans overrides
  useOrphanToast();


  const { isModalOpen, onOpenModal, onCloseModal } = useComponentsModal();

  // Track the replace target for the component picker
  const replacePickerTargetRef = useRef(false);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      replacePickerTargetRef.current = !!detail?.replace;
    };
    window.addEventListener('sq:open-component-picker', handler);
    return () => window.removeEventListener('sq:open-component-picker', handler);
  }, []);
  // Page-level layout slot click → open the picker (the pick is a normal
  // files-truth insert).
  useEffect(() => {
    const handler = () => {
      if (!currentPageId) return;
      const { layoutName } = selectPageLayout(doc, currentPageId);
      if (!layoutName) { toast.error(t("No layout on this page — drop a layout first.")); return; }
      onOpenModal();
    };
    window.addEventListener('sq:layout-slot-click', handler);
    return () => window.removeEventListener('sq:layout-slot-click', handler);
  }, [doc, currentPageId, onOpenModal]);
  // LayoutMenu "Replace layout…" → reopen the picker. Choosing a layout routes
  // through handleSelectComponent's layout branch (applyLocalPageLayout, content
  // preserved). We deliberately do NOT set replacePickerTargetRef — that ref is
  // for element replacement and the layout-drop branch returns early without
  // clearing it, which would leak the flag onto the next component insert.
  useEffect(() => {
    const handler = () => { onOpenModal(); };
    window.addEventListener('sq:replace-page-layout', handler);
    return () => window.removeEventListener('sq:replace-page-layout', handler);
  }, [onOpenModal]);

  useEffect(() => {
    setupTestHelper(doc);
    return () => cleanupTestHelper();
  }, [doc]);

  useEffect(() => {
    localStorage.setItem(DESIGN_BAR_WIDTH_STORAGE_KEY, String(designBarWidth));
  }, [designBarWidth]);

  const handleDesignBarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingDesignBar(true);
  }, []);

  useEffect(() => {
    if (!isResizingDesignBar) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX;
      const clampedWidth = Math.max(DESIGN_BAR_MIN_WIDTH, Math.min(DESIGN_BAR_MAX_WIDTH, newWidth));
      setDesignBarWidth(clampedWidth);
    };

    const handleMouseUp = () => {
      setIsResizingDesignBar(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingDesignBar]);

  const handleSelectComponent = useCallback(
    async (component: ScannedComponent | ThemeComponentTemplate) => {
      if (!currentPageId) return;

      // task-133: files-truth — write the REAL page file through the
      // structural writer. No takeSnapshot, no doc dispatch, no elementId
      // flow (Task 8 wires undo via inverse structural writes). Blog-slot /
      // layout-slot branches don't apply: those components are
      // built-ins and the user-project guard inside returns first.
      //
      // C6 law: a local ⌘K insert either works or refuses with a visible
      // toast — never silently inert. Every named branch inside toasts on
      // its own; this catch covers the remaining class (an unexpected
      // throw became an unhandled rejection with zero user feedback).
      try {
        // A layout pick rewrites the page FILE (import + wrapper) — never
        // SET_PAGE_LAYOUT (a local iframe gets no doc-derived RENDER, so the
        // doc row renders nothing and evaporates on reopen) and never
        // insertLocalComponent (layouts scan with an empty template body —
        // the task-149 guard refused them with "has no markup").
        if (isLayoutComponent(component)) {
          await applyLocalPageLayout({
            component: component as ScannedComponent,
            pageFile: currentPageFile,
            localProjectPath: localPath,
            pushUndo: pushStructuralUndo,
          });
          return;
        }
        const scanned = scannedElementsRef.current;
        const selKey = selectedKeyRef.current;
        // Gap 7: read + clear the Replace flag on THIS path too — it used to
        // survive the early return, silently degrading DragGutter Replace to
        // a plain add (and leaking the flag onto the next insert).
        const shouldReplace = replacePickerTargetRef.current;
        replacePickerTargetRef.current = false;
        // task-240 Phase 4: a BlogSlot insert is followed by its binding
        // (one collection → bind; none → scaffold + bind; many → unbound),
        // and the two gestures are ONE ⌘Z entry.
        const isBlogSlotPick = !isThemeComponentTemplate(component) && component.name === BLOG_SLOT_COMPONENT_TYPE;
        const collected: StructuralUndoRecord[] = [];
        const collect: PushStructuralUndo = (r) => { collected.push(r); };
        const inserted = await insertLocalComponent({
          component,
          selection: selKey ? scanned.find((e) => e.key === selKey) ?? null : null,
          scannedElements: scanned,
          pageFile: currentPageFile,
          pushUndo: isBlogSlotPick ? collect : pushStructuralUndo,
          // Gaps 11/36: lets built-in/theme picks materialize into the project.
          localProjectPath: localPath,
          replaceKey: shouldReplace ? selKey : null,
          scannedByKey: scannedByKeyRef.current,
        });
        if (isBlogSlotPick && inserted.ok && currentPageFile && localPath) {
          // The insert's write full-reloads the iframe — let the rescan land
          // before the bind's bridge write (an in-flight reload drops it).
          await waitForLocalScan();
          await bindInsertedBlogSlot({ pageFile: currentPageFile, localProjectPath: localPath, pushUndo: collect });
        }
        if (collected.length) pushStructuralUndo(mergeStructuralRecords(collected));
      } catch (err) {
        console.error('[local-insert] unexpected failure', err);
        toast.error(sourceActionFailure('insert', err));
      }
    },
    [currentPageId, currentPageFile, localPath, selectedKeyRef, scannedElementsRef, scannedByKeyRef, pushStructuralUndo]
  );

  // Icons tab (task-106): materialize the Lucide icon as src/components/Icon<Name>.astro,
  // then insert through the normal component path. Descriptor mirrors what
  // scan-components would return for the freshly written file — don't wait for
  // the sq:components-changed refetch.
  const handleSelectIcon = useCallback(async (lucideName: string, svg: string) => {
    try {
      const existing = new Set(fullComponentLibrary.map((c) => c.name));
      const { componentName } = await materializeIconComponent(lucideName, svg, existing, localPath);
      await handleSelectComponent({
        name: componentName,
        path: resolveComponentSourcePath(`${componentName}.astro`),
        source: 'user-project',
        html: svg,
        category: 'icons',
        props: [],
        slots: [],
        dependencies: [],
      });
    } catch (err) {
      console.error('[icons] materialize failed:', err);
      toast.error(t("Failed to add icon"));
    }
  }, [fullComponentLibrary, handleSelectComponent, localPath]);

  const handleSelectPageTemplate = useCallback(async (preset: PageTemplatePreset) => {
    if (!currentPageId) return;
    const library = libraryBuiltIn.concat(libraryUserProject);
    const { resolved, missing } = resolvePreset(preset, library);
    if (missing.length > 0) console.warn('[picker] preset components missing from library:', missing);
    if (resolved.length === 0) {
      toast.error(t("Template components not found in library"));
      return;
    }

    // Emptiness from iframe-scan roots, NOT Yjs (Yjs roots can be empty on a
    // page with visible content). No confirm (culture.md Law 6): the deletes and
    // the insert are ONE accepted mutation under the claimed snapshot — one ⌘Z.
    const hasContent = gutterRootElements.length > 0 || rootElements.length > 0;

    takeSnapshot();

    // Delete existing roots through the real per-kind matrix (parity rule —
    // no parallel REMOVE loop). Guarded/undeletable entries survive; count them.
    let survivors = 0;
    const deletions: EntryDeletion[] = [];
    if (hasContent) {
      const yjsRoots = new Set(selectRootElementIds(doc, currentPageId));
      for (const root of gutterRootElements) {
        const elementId = yjsRoots.has(root.key) ? root.key : null;
        const deletion = planEntryDeletion(
          { key: root.key, elementId },
          { doc, scannedElements: scannedElementsRef.current },
        );
        if (deletion) deletions.push(deletion);
        else survivors += 1;
      }
    }

    await insertTemplateComponents({
      doc, pageId: currentPageId, components: resolved, generateId,
      resolveComponent: (name) => library.find((c) => c.name === name),
      snapshot: claimSnapshot(),
      beforeInsert: staged => {
        for (const { command } of deletions) if (!applyCommand(staged, command)) throw new Error('Template replacement refused');
      },
    });
    publishEntryDeletions(deletions);

    if (survivors > 0) {
      toast(`${survivors} existing element(s) could not be removed — template added below them`);
    } else {
      toast.success(t("Applied \"{0}\" template", { 0: preset.name }));
    }
  }, [currentPageId, doc, dispatch, gutterRootElements, rootElements.length, libraryBuiltIn, libraryUserProject, takeSnapshot, claimSnapshot, scannedElementsRef]);

  /** Mark that a reorder/reparent just happened so gutter handles hide until rescan. */
  const markReorderPending = useCallback(() => {
    reorderPendingRef.current = true;
    setHideGutterHandles(true);
  }, []);

  // SINGLE source of truth for LAYERS_PANEL drag handling, shared with the
  // master/component editor (AssetsPanel passes the same hook's handlers to its
  // SortableTreeProvider foreign-drag passthrough). See useLayersDrag.
  const layersDrag = useLayersDrag({ onReorderPending: markReorderPending });

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
    layersDrag.onDragStart(event);
  }, [layersDrag]);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    // Layers drags: publish the live drop ZONE (shared handler).
    layersDrag.onDragMove(event);

    // Only handle gutter drags below
    if (event.active.data.current?.type !== DRAG_TYPES.GUTTER_HANDLE) return;

    // Extract the actual element key from the prefixed gutter ID
    const activeId = String(event.active.id);
    const elementKey = GutterId.parse(activeId) ?? activeId;
    const activeIndex = gutterRootElements.findIndex((el) => el.key === elementKey);
    if (activeIndex === -1) return;

    // Get viewport frame position and scale for coordinate conversion
    const scale = event.active.data.current?.scale || 1;
    const viewportFrameTop = event.active.data.current?.viewportFrameTop || 0;
    const canvasContainerTop = event.active.data.current?.canvasContainerTop || 0;

    // Calculate pointer Y position in iframe coordinates
    // Use actual pointer position (from activatorEvent + delta), NOT the dragged element's position
    // This makes the calculation completely independent of the dragged element
    // 1. Start with clientY (relative to browser viewport)
    // 2. Subtract canvasContainerTop (canvas container's position in viewport)
    // 3. Subtract viewportFrameTop (iframe's position within canvas)
    // 4. Divide by scale to convert to iframe coordinates
    const activatorEvent = event.activatorEvent as PointerEvent;
    const currentPointerScreenY = activatorEvent.clientY + (event.delta?.y || 0);
    const pointerY = (currentPointerScreenY - canvasContainerTop - viewportFrameTop) / scale;

    // Build list of other elements (excluding the one being dragged)
    const otherElements = gutterRootElements
      .map((el, i) => ({ el: scannedByKeyRef.current.get(el.key) ?? el, originalIndex: i }))
      .filter(({ originalIndex }) => originalIndex !== activeIndex);

    if (otherElements.length === 0) {
      hideDropIndicator();
      return;
    }

    // Sort elements by Y position
    const sortedElements = [...otherElements].sort((a, b) => a.el.rect.top - b.el.rect.top);

    // Find which element we're over and determine top/bottom half
    let targetIndex = -1;
    let position: 'above' | 'below' = 'below';
    let indicatorTop = 0;

    for (const { el, originalIndex } of sortedElements) {
      const elTop = el.rect.top;
      const elBottom = el.rect.top + el.rect.height;
      const elCenter = el.rect.top + el.rect.height / 2;

      // Check if pointer is within this element's bounds
      if (pointerY >= elTop && pointerY < elBottom) {
        targetIndex = originalIndex;
        // Top half of target = drop above, bottom half = drop below
        if (pointerY < elCenter) {
          position = 'above';
          indicatorTop = elTop;
        } else {
          position = 'below';
          indicatorTop = elBottom;
        }
        break;
      }
    }

    // If not over any element, check if above first or below last
    if (targetIndex === -1) {
      const firstElement = sortedElements[0];
      const lastElement = sortedElements[sortedElements.length - 1];

      if (pointerY < firstElement.el.rect.top) {
        targetIndex = firstElement.originalIndex;
        position = 'above';
        indicatorTop = firstElement.el.rect.top;
      } else if (pointerY >= lastElement.el.rect.top + lastElement.el.rect.height) {
        targetIndex = lastElement.originalIndex;
        position = 'below';
        indicatorTop = lastElement.el.rect.top + lastElement.el.rect.height;
      }
    }

    if (targetIndex !== -1) {
      showDropIndicator(indicatorTop, position, targetIndex);
    } else {
      hideDropIndicator();
    }
  }, [gutterRootElements, showDropIndicator, hideDropIndicator, layersDrag]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      try {
      const { active } = event;
      const { position, targetIndex } = hideDropIndicator();

      setActiveDragId(null);
      clearDropZone();

      // Gutter drag reordering (canvas handles)
      if (active.data.current?.type === DRAG_TYPES.GUTTER_HANDLE) {
        const activeKey = GutterId.parse(String(active.id)) ?? String(active.id);
        const oldIndex = gutterRootElements.findIndex((el) => el.key === activeKey);

        if (oldIndex === -1 || targetIndex === -1) return;

        // Account for array shift when removing the item, then apply drop position
        const adjusted = oldIndex < targetIndex ? targetIndex - 1 : targetIndex;
        const newIndex = position === 'above' ? adjusted : adjusted + 1;

        if (oldIndex === newIndex) return;

        // task-133 Task 6: local runtime + source-keyed root → the doc has no
        // node for it; express the landing slot as before/after a REAL
        // neighbor and write the file (no doc dispatch, no snapshot — Task 8
        // wires undo via inverse writes). Post-write reselection comes from
        // the pending-selection singleton inside moveLocalElement.
        if (isSourceKeyedElementKey(activeKey)) {
          const plan = planGutterLocalMove(gutterRootElements.map((el) => el.key), oldIndex, newIndex);
          if (plan) {
            void moveLocalElement({ key: activeKey, targetKey: plan.targetKey, position: plan.position, pushUndo: pushStructuralUndo, scannedByKey: scannedByKeyRef.current })
              .then((ok) => { if (ok) markReorderPending(); });
          }
          return;
        }

        await reorderRootElements(oldIndex, newIndex);

        const reordered = [...gutterRootElements];
        const [removed] = reordered.splice(oldIndex, 1);
        reordered.splice(newIndex, 0, removed);
        sendReorderToIframe(reordered.map((el) => el.key));
        markReorderPending();
        return;
      }

      // Layers panel drag (single + group) — shared handler (also used by the
      // master/component editor via AssetsPanel's foreign-drag passthrough).
      await layersDrag.onDragEnd(event);
      } catch (error) { toast.error(t("Move was not saved: {0}", { 0: error instanceof Error ? error.message : String(error) })); }
    },
    [gutterRootElements, reorderRootElements, hideDropIndicator, markReorderPending, layersDrag, pushStructuralUndo]
  );

  useProjectSync({
    projectId,
    doc,
    onLoaded: (p) => {
      setProject(p);
      setIsLoading(false);
      // Fresh doc → seed default collection. The doc is the only variables
      // store; the old disk-JSON hydration leaked tokens across projects.
      const collections = doc.getMap('variableCollections');
      if (collections.size === 0) {
        // Background: it regenerates the variables CSS off the instance, so it
        // settles only after the preview boots — "Back to projects" must not
        // wait for it. A seed lost to leaving mid-boot is re-seeded next open.
        void dispatchDurableAction(doc, { type: 'ADD_VARIABLE_COLLECTION', collection: createDefaultCollection() },
          [], undefined, undefined, { background: true }).catch(error => console.warn('[default collection seed]', error));
      }
    },
    onError: (err) => {
      // Not a project on this device: redirect, never the recovery banner.
      if (err instanceof ProjectNotFoundError) {
        if (err.notice) toast.error(err.notice);
        onProjectMissing?.(); return;
      }
      setError(err.message);
      setIsLoading(false);
    },
  });

  const handleExport = useCallback(async () => {
    if (!project) return;

    setIsExporting(true);
    try {
      // The project IS its files — zip them as-is.
      await exportFilesTruthProject(projectId, project.name, doc);

      toast.success(t("Project exported successfully!"));
    } catch (err) {
      console.error('Export failed:', err);
      toast.error(exportFailureMessage(err));
    } finally {
      setIsExporting(false);
    }
  }, [project, projectId, doc]);

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-bg-contrast">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-btn-primary-fill-default mx-auto mb-4" />
          <p className="text-text-muted">Loading project...</p>
        </div>
      </div>
    );
  }

  if (error) throw new Error(error);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={clearDropZone}
    >
      <CardTitleLockSync />
      <LayerContextMenu />
      <ListConversionOnOpen />
      {/* Editor Layout */}
      <div ref={layoutRef} className="relative h-screen flex overflow-hidden">
        {/* task-116: preview hides every chrome surface — the canvas iframe
            goes full-window and the footer collapses to a single ⏸. The panels
            SLIDE out rather than pop: kept mounted, translated off-screen, and
            lifted to z-50 ONLY in preview so they ride over the fixed full-window
            iframe (z-40) as they go. motion-reduce respects the OS setting.
            Both panels float over the canvas (absolute, the same positioning), so
            the canvas is always the whole window and ⌘\ (sidebarsHidden) only hides
            them; `hidden` keeps them mounted (widths, tabs, scroll and drafts
            survive) and out of the Tab order. */}
        <div ref={leftPanelRef} data-sq-panel="left" className={`absolute left-0 top-0 h-full ${PREVIEW_SLIDE_TRANSITION} ${isPreview ? 'z-50 -translate-x-full' : 'z-10'} ${sidebarsHidden ? 'hidden' : ''}`}>
          <LeftSidebar />
        </div>
        <Canvas
          activeDragId={activeDragId}
          isReorderPending={isReorderPending}
          localInstance={localInstance}
          runtimeFailureKind={!localPath ? 'project-unavailable' : undefined}
          currentPagePath={currentPagePath}
          currentPageFile={currentPageFile}
          iframeRef={iframeRef}
          hideSite={componentsTabEmpty}
        />

        {/* DesignBar with resize handle — hidden when variables/post editor is
            open, or on the Content tab (no design props there) */}
        {designSurface && (
          // task-116: stays mounted in preview and slides off to the right
          // (see the LeftSidebar wrapper above for the floating/z-50 rationale).
          <div ref={rightPanelRef} data-sq-panel="right" className={`absolute right-0 top-0 h-full ${PREVIEW_SLIDE_TRANSITION} ${isPreview ? 'z-50 translate-x-full' : 'z-10'} ${sidebarsHidden ? 'hidden' : ''}`} style={{ width: designBarWidth }}>
            {/* Resize Handle - absolute positioned on left edge */}
            <div
              className="absolute top-0 left-0 w-2 h-full cursor-col-resize group z-10"
              style={{ transform: 'translateX(-50%)' }}
              onMouseDown={handleDesignBarResizeStart}
            >
              <div
                className={`absolute left-1/2 -translate-x-1/2 w-px h-full transition-colors delay-0 group-hover:delay-150 ${
                  isResizingDesignBar ? 'bg-stroke-active' : 'bg-transparent group-hover:bg-stroke-active'
                }`}
              />
            </div>

            <div className="bg-bg border-l border-stroke overflow-y-auto h-full">
              <DesignBar />
            </div>
          </div>
        )}
      </div>

      {/* Overlay to prevent iframe interference during resize */}
      {isResizingDesignBar && (
        <div className="fixed inset-0 z-50 cursor-col-resize" />
      )}

      {/* Floating Footer */}
      {/* MCP session (external coding agents) lives with the Footer: same
          providers as the chat, so AISettings → MCP and the footer chip read it. */}
      <McpProvider projectId={projectId} projectName={project?.name || 'my-project'} componentLibrary={fullComponentLibrary} getCurrentPageFile={getCurrentPageFile}>
        <Footer
          projectId={projectId}
          componentLibrary={fullComponentLibrary}
          getCurrentPageFile={getCurrentPageFile}
          onOpenModal={onOpenModal}
          addOpen={isModalOpen}
          onCloseAdd={onCloseModal}
          onExport={handleExport}
          isExporting={isExporting}
          onDeploy={() => setPublishWindow('publish')}
          onVersions={isDesktop() ? () => setPublishWindow('versions') : undefined}
          onHome={handleBackToProjects}
          hideTools={!designSurface}
        />
      </McpProvider>

      <DragOverlay dropAnimation={null}>
        {/* Gutter handle drag - show handle grip icon */}
        {activeDragId && GutterId.isGutter(activeDragId) && (
          <div className="w-6 h-6 flex items-center justify-center cursor-default rounded bg-bg-secondary border border-stroke-active shadow-flyout">
            <SharedGripIcon className="w-4 h-4 text-text-muted" />
          </div>
        )}
      </DragOverlay>

      {/* Publish and Versions windows (desktop git client only) */}
      {deployGithub && (<>
        <DeployModal
          isOpen={publishWindow === 'publish'}
          onClose={() => setPublishWindow(null)}
          doc={doc}
          projectName={project?.name || 'my-project'}
          client={deployGithub.client}
          onOpenVersions={() => setPublishWindow('versions')}
        />
        <VersionsWindow
          isOpen={publishWindow === 'versions'}
          onClose={() => setPublishWindow(null)}
          client={deployGithub.client}
          projectName={project?.name || 'my-project'}
        />
      </>)}

      {/* Component picker modal (Cmd+K) */}
      <ComponentPickerModal
        isOpen={isModalOpen}
        onClose={onCloseModal}
        onSelectComponent={handleSelectComponent}
        onSelectPageTemplate={handleSelectPageTemplate}
        onSelectIcon={handleSelectIcon}
        localMode
      />

    </DndContext>
  );
}

interface EditorProps {
  projectId: string;
  /** The id has no project on this device — the route redirects to Projects. */
  onProjectMissing?: () => void;
}

// Per-project store instances for browser mode
const browserGraphStores = new Map<string, YjsGraphStore>();

function getBrowserGraphStore(projectId: string): YjsGraphStore {
  if (!browserGraphStores.has(projectId)) {
    browserGraphStores.set(projectId, new YjsGraphStore());
  }
  return browserGraphStores.get(projectId)!;
}

/** Post the current graph state back to RemoteGraphProvider. */
function broadcastGraphState(store: YjsGraphStore): void {
  window.postMessage({
    type: 'GRAPH_STATE_UPDATE',
    payload: {
      state: store.getState(),
      canUndo: store.canUndo(),
      canRedo: store.canRedo(),
    },
  }, '*');
}

/** Process graph commands locally and dispatch state updates. */
const createBrowserPostMessage = (projectId: string) => (message: unknown) => {
  const msg = message as { type: string; payload?: unknown };
  const store = getBrowserGraphStore(projectId);

  switch (msg.type) {
    case 'GRAPH_TRANSACT': {
      const payload = msg.payload as {
        description: string;
        commands: GraphMutationCommand | GraphMutationCommand[];
        options?: TransactOptions;
      };
      store.transact(payload.description, payload.commands, payload.options);
      broadcastGraphState(store);
      break;
    }

    case 'GRAPH_REQUEST_STATE':
      broadcastGraphState(store);
      break;

    case 'GRAPH_UNDO':
      store.undo();
      broadcastGraphState(store);
      break;

    case 'GRAPH_REDO':
      store.redo();
      broadcastGraphState(store);
      break;
  }
};

export function Editor({ projectId, onProjectMissing }: EditorProps) {
  return (
    <EditorProvider key={projectId}>
      <UndoProvider>
        <RemoteGraphProvider postMessage={createBrowserPostMessage(projectId)}>
          <ThemesLibraryProvider projectId={projectId}>
              <PagesProvider>
                <ClassStoreProvider>
                  <SelectionProvider>
                    <DropIndicatorProvider>
                      <StateProvider>
                        <BreakpointProvider>
                          <DesignThemeProvider>
                            <ToolProvider>
                              <AIProvider>
                                <VariablesProvider>
                                  <PostEditorProvider>
                                    <SidebarTabProvider>
                                      <EditorContent projectId={projectId} onProjectMissing={onProjectMissing} />
                                      <UpdateToast />
                                      {import.meta.env.DEV && <TelemetryPanel />}
                                    </SidebarTabProvider>
                                  </PostEditorProvider>
                                </VariablesProvider>
                              </AIProvider>
                            </ToolProvider>
                          </DesignThemeProvider>
                        </BreakpointProvider>
                      </StateProvider>
                    </DropIndicatorProvider>
                  </SelectionProvider>
                </ClassStoreProvider>
              </PagesProvider>
          </ThemesLibraryProvider>
        </RemoteGraphProvider>
      </UndoProvider>
    </EditorProvider>
  );
}

/** Feeds the card cache (title locks + collection assignments) per scan/sync — own component: the Editor itself never re-renders per scan. */
function CardTitleLockSync() {
  const localPath = useLocalProjectPath();
  const scanVersion = useLocalScanVersion(localPath);
  const sync = useSyncExternalStore(subscribeFilesTruthSyncStatus, getFilesTruthSyncStatus);
  const { userProject } = useComponentLibrary();
  const { collections } = useContentCollections();
  const componentFiles = useMemo(() => userProject.map((c) => c.path), [userProject]);
  const collectionNames = useMemo(() => collections.map((c) => c.name), [collections]);
  // Every settled sync (a new snapshot object) re-reads; a save in flight is not a change yet.
  const settled = useRef(sync);
  if (sync.status !== 'saving') settled.current = sync;
  const trigger = useMemo(() => ({ scanVersion, sync: settled.current }), [scanVersion, settled.current]); // eslint-disable-line react-hooks/exhaustive-deps
  useProjectCardSources(localPath, componentFiles, collectionNames, trigger);
  return null;
}

/** A ref for a floating side panel: its width goes to `name` on the editor layout (0 while hidden or unmounted). */
function usePanelInset(layoutRef: RefObject<HTMLDivElement | null>, name: string) {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = layoutRef.current;
    if (!root) return;
    const write = () => root.style.setProperty(name, `${panel?.offsetWidth ?? 0}px`);
    write();
    if (!panel || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(write);
    observer.observe(panel);
    return () => { observer.disconnect(); root.style.setProperty(name, '0px'); };
  }, [layoutRef, name, panel]);
  return setPanel;
}
