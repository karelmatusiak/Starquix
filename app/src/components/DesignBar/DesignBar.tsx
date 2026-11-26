/**
 * DesignBar Component
 *
 * Visual editor for Tailwind CSS classes.
 * Provides controls for styling the selected element.
 * Supports editing different states (hover, active, focus, disabled).
 */

import React, { useState, useCallback, useMemo, useRef, useEffect, useSyncExternalStore } from 'react';
import { t } from '@/i18n';
import { useSelectedElement, useSelectionContext, useTextSelection, useScannedElementsRef, useScannedElements } from '@/context/SelectionContext';
import { useClassStore, useElementClasses } from '@/context/ClassStoreContext';
import { useActiveState } from '@/context/StateContext';
import { useActiveBreakpoint, PRIMARY_BREAKPOINT } from '@/context/BreakpointContext';
import { useEditorDoc, useYjsValue } from '@/store/hooks';
import { useSelectedCellGeometry, selectedCellFor } from '@/store/gridGeometryStore';
import { writeGridPlacement } from '@/utils/gridGeometry';
import { useUndoContext } from '@/context/UndoContext';
import { GestureHostContext, getGestureScope, type GestureHost } from '@/components/ui/valueGesture';
import { holdProjectInput } from '@/services/durableEdits/acceptance';
import { stashClear, stashPut } from '@/services/gestureStash';
import { captureLocalWriteOrigin } from '@/utils/localWriteScope';
import { selectCurrentPageId, selectElementTag, selectActiveContentSlotKey, selectRootElementIds, selectPostPageBinding, selectPageLayout, selectProjectId } from '@/store/selectors';
import { useSourceHtml } from '@/hooks/useSourceHtml';
import { parseKey } from '@/store/types';
import { addDataKeysToHtml, stripDataKeys, extractClassByTagIndex } from '@/store/constants';
import { sanitizeUrl } from '@/utils/sanitizeUrl';
import { resetInstanceToOriginal, makeComponentFromDrawn, pushInstanceToSource, selectInstanceDivergence, collectInstanceDivergence } from '@/store/instanceLifecycle';
import { useComponentLibrary } from '@/hooks/useComponentLibrary';
import { useConvertSvgToShape } from '@/hooks/useConvertSvgToShape';
import toast from 'react-hot-toast';

import * as Y from 'yjs';
import { Button, Row, Tabs } from '@/components/ui';
import { HeaderTags } from './HeaderTags';
import { tokenMatchesCell, tokenHasVariant, VARIANT_LEAD, type Cell } from './variantCell';
import { useActiveTheme } from '@/context/ThemeContext';
import { DesignBarProvider, type DesignBarContextValue } from './DesignBarContext';
import { OrphanedOverridesBadge } from './OrphanedOverridesBadge';
import { BlogBindingBlock } from './blocks/BlogBindingBlock';
import { useBlogBinding } from '@/hooks/useBlogBinding';
import { reemitLocalBlogSlots } from '@/components/Editor/localBlogBind';
import { upgradeLocalCardImage } from '@/components/Editor/localFieldBind';
import { upgradeLocalBlogSlotChrome } from '@/components/Editor/localBlogSlotUpgrade';
import { getLocalPageFile, isLocalPageInSync } from '@/utils/localPageSync';
import { FieldBindingBlock } from './blocks/FieldBindingBlock';
import { CardFieldsBlock } from './blocks/CardFieldsBlock';
import { bindingKindFor } from '@/utils/fieldBinding';
import { cardAssignmentOf, useCardTitleLockVersion } from '@/utils/cardTitleLock';
import { MediaBlock } from './blocks/MediaBlock';
import { MEDIA_MANIFEST, MEDIA_COMPONENT_PATH } from '@/core/manifest/mediaManifest';
import { manifestForComponent } from '@/core/manifest/parseManifest';
import { resolveMediaUnit, isComponentUnitPath } from './mediaUnit';
import { docPostPageTarget, importedPostTargetFor } from './postTarget';
import { resolveComponentUnit } from './componentUnit';
import { SystemComponentBlock } from './blocks/SystemComponentBlock';
import { MEDIA_SYSTEM_COMPONENT } from '@/utils/systemComponents';
import { SlotBlock } from './blocks/SlotBlock';
import { PageLayoutBlock } from './blocks/PageLayoutBlock';
import { PostLayoutBlock } from './blocks/PostLayoutBlock';
import { isPostLayoutFile } from '@/core/post/postLayoutProps';
import { LayoutPropsEditor } from './blocks/LayoutPropsEditor';
import { useLayoutLibrary } from '@/hooks/useLayoutLibrary';
import { isLayoutPath, layoutAstroSource, basenameFromAstroSource } from '@/utils/astroAssetPaths';
import { deriveSelectionDescriptor } from './selectionDescriptor';
import { isPlacementRoot } from './placementRoot';
import { DivergenceMarker } from './DivergenceMarker';
import { ComponentUsageBadge } from './ComponentUsageBadge';
import { useComponentUsage } from '@/hooks/useComponentUsage';
import { goToSourceNameFor } from './utils';
import { LAYOUT_SEO_RESERVED_PROPS } from '@/store/layoutReservedProps';
import { pageLayoutElementId, resolvedLayoutChrome } from '@/store/layoutElement';
import type { EntityMenuItem } from './EntityMenu';
import { GoToSourceButton, goToSource } from './HeaderActionButtons';
import { useLocalProjectPath } from '@/hooks/useLocalProjectPath';
import { subscribeLocalComponentView, getLocalComponentViewFile, requestPageView } from '@/services/localComponentView';
import {
  hasLocalMasterOverrides,
  localMasterOutdated,
  localOverridesForPlacement,
  resetLocalOverrides,
} from '@/store/localMasterOverrides';
import { pushLocalOverridesUndoable } from '@/store/localPushUndo';
// ONE push-feedback builder for every runtime — the report the user reads must
// not be the thing that tells the two apart (blind review 2026-08-04).
import { pushStartNotice, pushNotice } from '@/store/pushNotice';
import { SlotTargetBlock } from './blocks/SlotTargetBlock';
import { BlockErrorBoundary } from './BlockErrorBoundary';
import { InstanceMenu } from './InstanceMenu';
import { ElementHeaderActions } from './ElementHeaderActions';
import { DesignBarHeader } from './DesignBarHeader';
import { VariablesQuickPanel } from './VariablesQuickPanel';
import { ComponentBackdropBlock } from './blocks/ComponentBackdropBlock';
import ElementDesignPanel, { type ElementDesignBundle } from './ElementDesignPanel';
import { MultiDesignPanel } from './multi/MultiDesignPanel';
import { ExpandableRow } from './sections';
import { useBlogSlotContext } from '@/hooks/useBlogSlotContext';
import {
  BLOG_SLOT_COMPONENT_TYPE,
  BLOG_SLOT_DEFAULTS_KEY,
} from '@/core/collections/types';
import { selectContentCollection } from '@/store/collectionSelectors';
import {
  readBlogSlotBinding,
  blogSlotSettingsDivergence,
  blogSlotSettingsOutdated,
} from '@/core/collections/yjsAccessors';
import { usePostEditor } from '@/context/PostEditorContext';
import { ClassesTab, SourceTab } from './tabs/index';
import {
  parseClasses,
  serializeClasses,
  getEffectiveClasses,
  getPropertyGroup,
  cloneStorage,
  computeSlotContent,
  type Breakpoint,
  type Theme,
  type State,
  type ClassStorage
} from '@/core/classes/index';
import { TEXT_ELEMENTS, CLASS_PATTERNS } from './classPatterns';
import { sameTokenSet } from '@/core/classes/index';
import { BREAKPOINTS } from '@/core/classes/types';
import { useDispatch } from '@/store/hooks';
import { COMPONENT_EDITOR_PAGE_ID as COMPONENT_PAGE_ID } from '@/store/constants';
import { baseMarkup, isMasterMarkupOutdated } from '@/store/masters';
import {
  requestPreviewReload,
} from '@/components/Canvas/reloadPreview';
import {
  collectMasterInstanceIds,
  isMasterYjsEntry,
  isRenderedMasterRoot as isRenderedMasterRootHelper,
  isPostRootElement,
  readBlogCardComponentName,
} from '@/store/masterEntity';
import { localPostTargetFor } from '@/utils/localMode';
import { useContentCollections } from '@/hooks/useContentCollections';

// task-028: getSlotSourceMapping deleted. BlogSlot is a regular component
// instance now; its wrapper div is an ordinary instance child with its own
// classOverrides + breakpoint classes, scanned by the standard pipeline.


// ============================================================================
// Unified Class System Helpers
// ============================================================================

/**
 * Check if a slot has overrides (classes stored at that slot).
 */
function getBreakpointOverrides(
  storage: ClassStorage,
  breakpoint: Breakpoint,
  theme: Theme
): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};

  // Check all states at this breakpoint and theme
  const states: State[] = ['default', 'hover', 'focus', 'active', 'disabled'];
  for (const state of states) {
    const classes = storage[breakpoint][theme][state];
    for (const cls of classes) {
      const group = getPropertyGroup(cls);
      overrides[group] = true;
    }
  }

  return overrides;
}

// ============================================================================
// Constants
// ============================================================================

type DesignBarTab = 'design' | 'classes' | 'source';

// ============================================================================
// DesignBar Component
// ============================================================================

export interface DesignBarProps {
  onClassesChange?: (classes: string) => void;
}

export const DesignBar: React.FC<DesignBarProps> = ({ onClassesChange }) => {
  const { key, tagName: selectionTagName, classes: selectedClasses, computedStyles, hasSelection, parentDisplay, imageSrc, imageAlt, imagePreviewDataUrl, postSlug, postLinkPaths } = useSelectedElement();
  // Multi-select gate: while extras exist the bar shows a static count panel
  // and NO editing — showing the primary's blocks would invite edits the user
  // believes apply to the whole group (design doc §4.4).
  const { additionalSelections, selectedSourceLocation: sourceLocation, select } = useSelectionContext();
  const isMultiSelect = hasSelection && additionalSelections.length > 0;
  // For drawn elements, read tag reactively from Yjs (auto-converts div↔section by position)
  const yjsTag = useYjsValue((d) => selectElementTag(d, key));
  const tagName = yjsTag ?? selectionTagName;

  const isGridChild = parentDisplay === 'grid' || parentDisplay === 'inline-grid';
  const { scannedByKey } = useScannedElements();
  const { scannedByKeyRef } = useScannedElementsRef();
  // Auto-convert on selection lives in useAutoConvertSvgSelection (Editor
  // root). This hook instance only backs the manual button, which renders
  // exclusively for svgs the auto-convert could NOT handle — clicking it
  // surfaces the explanatory toast.
  const convertSvgToShape = useConvertSvgToShape();
  const { setClasses, getClassesFromYjs, previewClasses, abortClassesPreview } = useClassStore();
  const projectId = useYjsValue(selectProjectId);
  const { activeState, isEditingState } = useActiveState();
  const { activeBreakpoint, isEditingBreakpoint, viewportBreakpoint } = useActiveBreakpoint();
  const { activeTheme, isEditingDark } = useActiveTheme();
  const doc = useEditorDoc();

  const currentPageId = useYjsValue(selectCurrentPageId);
  const pageLayoutName = useYjsValue((d) => selectPageLayout(d, currentPageId ?? '').layoutName);

  const parsedKey = useMemo(() => parseKey(key), [key]);

  // One subscription covers all per-key element status: drawn flag, slot info,
  // master-entity markers, master-id list. Avoids the ~4 separate `useYjsValue`
  // calls each doing its own `elements.get(key)` lookup on every doc tick.
  const keyElementInfo = useYjsValue((d) => {
    const elements = d.getMap('elements');
    const el = key ? (elements.get(key) as Y.Map<unknown> | undefined) : undefined;
    return {
      isDrawn: !!key && key.startsWith('drawn-') && el?.get('isDrawn') === true,
      hasPenPath: !!el?.get('penPath'),
      elementType: el?.get('type') as string | undefined,
      slotType: el?.get('slotType') as string | undefined,
      slotComponentName: el?.get('slotComponentName') as string | undefined,
      isComponentTypeBlogSlot: el?.get('componentType') === BLOG_SLOT_COMPONENT_TYPE,
      isSelfMaster: isMasterYjsEntry(el),
      masterIds: collectMasterInstanceIds(d),
    };
  });
  const isDrawnElement = keyElementInfo.isDrawn;
  // A <slot> is a compile-time placeholder, never a styleable DOM node, so it
  // gets the minimal slot panel however it's represented:
  //   - codegen-shaped slot element → Yjs type==='slot'
  //   - slot draw tool → Yjs slotType==='slot' (type stays 'frame'/'text')
  //   - layout opened in the editor → the <slot> is a SCANNED source element
  //     (NOT in the Yjs elements map), identified only by its scanned tagName.
  //     This is the same signal ElementsTree uses (tagName==='slot').
  // A FILLED layout slot renders as `<div data-sq-slot>` (tagName 'div'); the scan
  // stamps `slotName` on it (that's how the Layers tree shows it as "slot"). All
  // four slot signals live in one predicate (see isSlotSelection).
  const selectedSlotName = key ? scannedByKey.get(key)?.slotName : undefined;
  const slotType = keyElementInfo.slotType ?? (keyElementInfo.isComponentTypeBlogSlot ? 'blog' : undefined);
  const slotComponentName = keyElementInfo.slotType ? keyElementInfo.slotComponentName : undefined;

  const masterIdsSet = useMemo(
    () => new Set(keyElementInfo.masterIds),
    [keyElementInfo.masterIds],
  );

  const isRenderedMasterRoot = useMemo(() => {
    if (!key || masterIdsSet.size === 0) return false;
    const parentKeyForCheck = scannedByKey.get(key)?.parentKey ?? null;
    return isRenderedMasterRootHelper(key, parentKeyForCheck, masterIdsSet);
  }, [key, masterIdsSet, scannedByKey]);

  const { openPost, previewPost } = usePostEditor();
  const { isInsideBlogSlot, blogSlotKey } = useBlogSlotContext();
  const blogCollection = useYjsValue<{ id: string; name: string } | null>((doc) => {
    if (!blogSlotKey) return null;
    const binding = readBlogSlotBinding(doc, blogSlotKey);
    if (!binding?.collectionId) return null;
    const collection = selectContentCollection(doc, binding.collectionId);
    return collection ? { id: collection.id, name: collection.name } : null;
  });

  const postPageCollectionName = useYjsValue<string | null>((doc) => {
    if (!currentPageId) return null;
    const binding = selectPostPageBinding(doc, currentPageId);
    if (!binding?.collectionId) return null;
    return selectContentCollection(doc, binding.collectionId)?.name ?? null;
  });

  const isPostRoot = useMemo(() => {
    if (!key) return false;
    const self = scannedByKey.get(key);
    return !!self && isPostRootElement(self, scannedByKey);
  }, [key, scannedByKey]);

  // Local mode: seeded dynamic-instance pages are NAMED by their route; the
  // disk collections resolve '/works/<slug>' back to the post it renders.
  const { collections: diskCollections } = useContentCollections();
  const currentLocalPageName = useYjsValue<string | null>((d) => {
    if (!currentPageId) return null;
    const page = d.getMap('pages').get(currentPageId) as Y.Map<unknown> | undefined;
    return (page?.get('name') as string) ?? null;
  });

  const postRootComponentName = useYjsValue<string>((d) =>
    isPostRoot ? readBlogCardComponentName(d, blogSlotKey ?? null) : '',
  );
  const postPageSlotKey = useYjsValue((doc) =>
    currentPageId ? selectActiveContentSlotKey(doc, currentPageId) : null
  );
  const showPostPicker = !!postPageSlotKey && !!key;

  // Layout-in-editor: a LAYOUT opened from Assets enters the component-editor flow
  // with the editor root's astroSource = layouts/<name>.astro. Detect it so the
  // shared LayoutPropsEditor (schema add/delete) renders alongside the InstanceMenu
  // every component-editor selection already gets — a layout reads like any entity.
  const editorRootAstroSource = useYjsValue<string | null>((doc) => {
    if (currentPageId !== COMPONENT_PAGE_ID) return null;
    const rootIds = selectRootElementIds(doc, COMPONENT_PAGE_ID);
    const el = rootIds[0] ? (doc.getMap('elements').get(rootIds[0]) as Y.Map<unknown> | undefined) : undefined;
    return (el?.get('astroSource') as string) ?? null;
  });
  const { layouts: layoutLibrary } = useLayoutLibrary();
  // The editor root's astroSource carries an environment-dependent prefix
  // (`layouts/<Name>.astro` in a clean checkout, `library/<Name>.astro` in this
  // project) AND components share the same prefix — so the path can't tell a
  // layout apart. The reliable signal: the basename matches a known LAYOUT in the
  // library. (isLayoutPath kept as a defensive positive for the layouts/ prefix.)
  const editorRootName = editorRootAstroSource
    ? basenameFromAstroSource(editorRootAstroSource)
    : null;
  const layoutLibraryNames = useMemo(
    () => layoutLibrary.map((l) => l.name),
    [layoutLibrary],
  );

  // task-136: is a local project open at all? (route splat, no arming race)
  const localProjectPathValue = useLocalProjectPath();
  const isLocalProject = !!localProjectPathValue;
  // task-149: …and is it showing the lone-component view rather than a page?
  // Editor owns the value; the store notifies so leaving the view re-renders
  // this panel instead of stranding the previous surface's chrome.
  const localComponentViewFile = useSyncExternalStore(
    subscribeLocalComponentView,
    getLocalComponentViewFile,
    getLocalComponentViewFile,
  );
  const isLocalComponentView = isLocalProject && !!localComponentViewFile;

  // THE selection descriptor — every "what kind of thing is selected" decision
  // below reads from this one derivation instead of inferring inline. Layout
  // selection rides on REAL keys: the page's Layout IS its derived layout-chrome
  // instance ROOT (`layoutchrome-<pageId>`); a slot/chrome tag is an
  // instance-CHILD key — NOT a layout-root selection; it falls through to normal
  // class controls routed to chrome overrides.
  const descriptor = useMemo(
    () =>
      deriveSelectionDescriptor({
        key,
        currentPageId,
        componentEditorPageId: COMPONENT_PAGE_ID,
        tagName: tagName ?? null,
        slotName: selectedSlotName,
        elementType: keyElementInfo.elementType,
        slotType: keyElementInfo.slotType,
        resolvedSlotType: slotType,
        isRenderedMasterRoot,
        isSelfMaster: keyElementInfo.isSelfMaster,
        isPostRoot,
        postRootComponentName,
        editorRootName,
        layoutLibraryNames,
        editorRootIsLayoutPath: isLayoutPath(editorRootAstroSource),
        isLocalComponentView,
      }),
    [key, currentPageId, tagName, selectedSlotName, keyElementInfo.elementType, keyElementInfo.slotType, slotType, isRenderedMasterRoot, keyElementInfo.isSelfMaster, isPostRoot, postRootComponentName, editorRootName, layoutLibraryNames, editorRootAstroSource, isLocalComponentView],
  );
  // Layout-element paradigm (2026-08-24): a layout-file element selected on a
  const {
    isComponentEditor,
    isLayoutSelection,
    isSlotElement,
    isInstanceChild,
    isInstanceRoot,
    isLayoutEditor,
    editorLayoutName,
    effectiveTagName,
    displayLabel: headingLabel,
  } = descriptor;

  const selectedLayoutName = isLayoutSelection ? pageLayoutName : null;
  const editorLayoutDef = editorLayoutName
    ? (layoutLibrary.find((l) => l.name === editorLayoutName) ?? null)
    : null;
  const editorLayoutPropDefs = (editorLayoutDef?.props ?? [])
    .filter((p) => !LAYOUT_SEO_RESERVED_PROPS.has(p.name));

  // Non-null when editing a BlogSlot in the component editor
  const editorBlogSlotKey = useYjsValue<string | null>((doc) => {
    if (!isComponentEditor) return null;
    const rootIds = selectRootElementIds(doc, COMPONENT_PAGE_ID);
    if (rootIds.length === 0) return null;
    const elements = doc.getMap('elements');
    const rootEl = elements.get(rootIds[0]) as Y.Map<unknown> | undefined;
    return rootEl?.get('componentType') === BLOG_SLOT_COMPONENT_TYPE ? rootIds[0] : null;
  });
  // task-028: instanceId no longer special-cases `:blogcard`. BlogSlot is a
  // regular component instance and its BlogCard child has its own Yjs id
  // accessible via the standard instance-child path.
  // A page's layout node resolves to its derived layout-chrome element, so the
  // layout reuses the ENTIRE component-instance lifecycle below (hasLocalOverrides,
  // masterVersion/showReload, push/reset) with no parallel logic.
  const instanceId = isLayoutSelection && currentPageId
    ? pageLayoutElementId(currentPageId)
    : parsedKey?.type === 'instance-child'
    ? parsedKey.instanceId
    : isInstanceRoot ? key
    : null;

  // Lift the owning instance's componentType so `isBlogSlot` recognises a
  // BlogSlot even when the user clicked an inner instance-child (e.g. the
  // visible `<section>` selects `el-X:section-0`, not `el-X`).
  const instanceComponentType = useYjsValue<string | null>((doc) => {
    if (!instanceId) return null;
    const el = doc.getMap('elements').get(instanceId) as Y.Map<unknown> | undefined;
    return (el?.get('componentType') as string) ?? null;
  });
  const isBlogSlot = slotType === 'blog' || !!editorBlogSlotKey || instanceComponentType === BLOG_SLOT_COMPONENT_TYPE;
  // task-098: a materialized nested-component CHILD in the editor gets the full
  // instance lifecycle — its push/↻ target its OWN master (astroSource resolves
  // from instanceId). Only the editor ROOT keeps no push chrome (it IS the
  // source; edits auto-flush into masters — feedback_editor_no_push_chrome).
  const isEditorChildInstance = useYjsValue<boolean>((doc) => {
    if (currentPageId !== COMPONENT_PAGE_ID || !instanceId) return false;
    const el = doc.getMap('elements').get(instanceId) as Y.Map<unknown> | undefined;
    return !!el?.get('parentId') && el.get('pageId') === COMPONENT_PAGE_ID;
  });
  const canResetInstance = (!isComponentEditor || isEditorChildInstance) && (isInstanceChild || isInstanceRoot || isBlogSlot || isInsideBlogSlot || isLayoutSelection);

  const hasDrawnElements = useYjsValue<boolean>((doc) => {
    if (!currentPageId || !instanceId) return false;
    const elements = doc.getMap('elements');
    let found = false;
    elements.forEach((_value) => {
      if (found) return;
      const yEl = _value as Y.Map<unknown>;
      if (!yEl.get('isDrawn') || (yEl.get('pageId') as string) !== currentPageId) return;
      const parentId = yEl.get('parentId') as string | undefined;
      if (parentId === instanceId) found = true;
    });
    return found;
  });

  const dispatch = useDispatch();
  const { takeSnapshot, claimSnapshot, pushStructuralUndo, undo } = useUndoContext();
  const [isMakingComponent, setIsMakingComponent] = useState(false);
  const { builtIn, userProject, refresh: refreshComponents } = useComponentLibrary();

  // task-207 Task 7 / D11: the local scan already carries every component's
  // frontmatter, so Media's knobs come from the USER's own sq/Media.astro.
  // MEDIA_MANIFEST is the fallback when the scan carries none (D9).
  const mediaManifest = useMemo(
    () => manifestForComponent(userProject, MEDIA_COMPONENT_PATH, MEDIA_MANIFEST),
    [userProject],
  );

  // task-028: slotKey / dual-source-tracking deleted. BlogSlot resolves
  // astroSource exactly like any other instance — its own `astroSource`
  // field on the Yjs element.
  const sourceTrackingId = instanceId;

  const astroSource = useYjsValue<string | null>((doc) => {
    if (!instanceId) return null;
    const elements = doc.getMap('elements');
    return ((elements.get(instanceId) as Y.Map<unknown> | undefined)?.get('astroSource') as string) ?? null;
  });

  const fullLibrary = useMemo(() => [...builtIn, ...userProject], [builtIn, userProject]);
  // NO caption identity coloring: the DesignBar heading stays neutral for
  // every selection kind (user call 2026-08-13) — identity colors live on
  // Assets/Layers rows only.
  // The layout-chrome element's astroSource is layouts/<Name>.astro, which
  // useSourceHtml resolves (expanding <Header/>/<Div2/> into their HTML) — so a
  // layout uses the SAME resolved source representation as every component
  // instance. No special raw-body path (that left component tags unexpanded and
  // broke the version comparison + the pull guard).
  const { sourceHtml: componentSourceHtml } = useSourceHtml(astroSource, fullLibrary);
  const sourceHtml = componentSourceHtml;

  // True when the current selection is backed by a derived layout-chrome element.
  const isLayoutChromeInstance = useYjsValue<boolean>((doc) => {
    if (!instanceId) return false;
    const el = doc.getMap('elements').get(instanceId) as Y.Map<unknown> | undefined;
    return el?.get('bindingType') === 'layout-chrome';
  });

  // Materialize the derived layout-chrome element whenever the page HAS a layout
  // (not only when the Layout is selected) — otherwise the page renders through the
  // unkeyed fallback until first selection, so a filled slot's <div> is unkeyed and
  // loses its `…:slot-0` identity (cyan slot → anonymous div). We store the RESOLVED
  // chrome (components expanded via resolveCanvasHtml) so it renders correctly.
  // ensureLayoutElement is create-if-missing + override-preserving, so this is safe.
  useEffect(() => {
    if (!currentPageId || !pageLayoutName) return;
    if (doc.getMap('elements').has(pageLayoutElementId(currentPageId))) return;
    const def = layoutLibrary.find((l) => l.name === pageLayoutName);
    if (!def) return;
    dispatch({
      type: 'ENSURE_LAYOUT_ELEMENT',
      pageId: currentPageId,
      layoutName: pageLayoutName,
      body: resolvedLayoutChrome(def.body ?? '', fullLibrary),
    });
  }, [currentPageId, pageLayoutName, layoutLibrary, fullLibrary, doc, dispatch]);

  // task-028: legacy migration effect for `:blogcard` elements with wrong
  // staticMarkup deleted — those compound-key elements no longer exist.

  // Deep divergence scan (value-aware, overlay-resolved) — lives in
  // store/instanceLifecycle.ts next to the presence-only hasInstanceOverrides.
  const hasLocalOverrides = useYjsValue<boolean>((doc) => {
    if (!instanceId) return false;
    return selectInstanceDivergence(doc, instanceId, currentPageId);
  });

  // Resolved via the masters overlay (task-102): Push bakes the placement
  // markup into `masters`, leaving the element's raw staticMarkup STALE —
  // comparing against the raw markup kept the asterisk lit after Push/Reset.
  const resolvedBaseMarkup = useYjsValue<string>((doc) => {
    if (!instanceId) return '';
    const elements = doc.getMap('elements');
    const yEl = elements.get(instanceId) as Y.Map<unknown> | undefined;
    if (!yEl) return '';
    return baseMarkup(doc, yEl) || (yEl.get('staticMarkup') as string) || '';
  });

  // task-028: slotClasses / postsClasses / slotMapping / hasSlotLevelEdits
  // deleted. BlogSlot is a regular instance — class edits on its root, on
  // the data-blog-source="posts" wrapper, and on its BlogCard child each
  // land on the corresponding Yjs element's own classOverrides + breakpoint
  // classes, which the standard hasLocalOverrides scan already covers.
  const isDivergedFromOriginal = hasLocalOverrides;

  // task-101: BlogSlot settings (blogSlotBindings, outside the markup stores)
  // feed BOTH indicator axes (wiki design-bar.md UC8):
  //   settingsDiverged — instance differs from the effective baseline → the
  //     instance was edited → asterisk + Push enabled.
  //   settingsOutdated — the master has a DEFINED opinion the instance isn't
  //     running → it can't get the update for free → ↻ reload (pull). Outranks
  //     the asterisk.
  // Hard-gated off in the component editor — the editor root writes the
  // defaults key directly and keeps NO push chrome.
  const settingsDiverged = useYjsValue<boolean>((doc) => {
    if (!isBlogSlot || !instanceId || currentPageId === COMPONENT_PAGE_ID) return false;
    return blogSlotSettingsDivergence(doc, instanceId) !== null;
  });
  const settingsOutdated = useYjsValue<boolean>((doc) => {
    if (!isBlogSlot || !instanceId || currentPageId === COMPONENT_PAGE_ID) return false;
    return blogSlotSettingsOutdated(doc, instanceId);
  });
  // task-102 markup-axis ↻: the master DESIGN (markup/classes) moved after
  // this instance's last override write. Coarse by design — any real master
  // bake vs any local override; the overrides may be shadowing the update.
  const markupOutdated = useYjsValue<boolean>((doc) => {
    if (!instanceId || currentPageId === COMPONENT_PAGE_ID) return false;
    const yEl = doc.getMap('elements').get(instanceId) as Y.Map<unknown> | undefined;
    return yEl ? isMasterMarkupOutdated(doc, yEl) : false;
  });

  const isPushingToSource = false; // Phase 6: the host write-back hook is gone

  // handlePushToSource is declared further down, next to docUsage — it reports
  // through the SHARED push notice, whose counts are derived after the divergence scan.

  const handleMakeComponent = useCallback(async () => {
    if (!doc || !key || isMakingComponent || !currentPageId) return;

    setIsMakingComponent(true);
    const result = await makeComponentFromDrawn({
      doc,
      currentPageId,
      key,
      existingNames: builtIn.map(c => c.name),
      takeSnapshot,
    });
    if (result.ok) {
      if (result.instanceId) select(result.instanceId);
      refreshComponents();
      toast.success(t("Component '{0}' created", { 0: result.componentName }));
    } else {
      toast.error(t("Failed to create component"));
    }
    setIsMakingComponent(false);
  }, [doc, key, isMakingComponent, currentPageId, builtIn, takeSnapshot, refreshComponents, select]);

  // headingLabel / elementDisplayName / effectiveTagName all come from the
  // selection descriptor above (deriveSelectionDescriptor).

  // task-136: in local mode, a selected element whose key lives in one of the
  // user's component/layout files gets a ↗ to open that file's lone-component
  // view (sq:go-to-source-component → LeftSidebar → local handleSelectComponent).
  //
  // NOT in the component view itself: there the surface IS that file, so the
  // element is the MASTER, not an instance of it. ↗ would reopen the page you
  // are already on, and Push/Reset/* describe a divergence that cannot exist —
  // edits here write the file directly. Same contract server mode's master view
  // has (ElementHeaderActions' isComponentEditor gate) and the standing rule
  // "the component editor has NO ⋮ menu".
  const localComponentFile = useMemo(() => {
    if (!isLocalProject || isComponentEditor || !key) return null;
    const file = key.split(':')[0];
    return /^src\/(components|layouts)\//.test(file) ? file : null;
  }, [isLocalProject, isComponentEditor, key]);

  // Owner ruling 2026-08-03: the ↗ / ⋮ cluster belongs to the PLACEMENT ROOT
  // alone — server mode's shape, where only the `el-…` instance root carries it
  // and every child is an instance-child with `*` and nothing else. The file
  // path above is true for EVERY element inside the component, which is why the
  // controls appeared everywhere; `isPlacementRoot` reads the scan ancestry for
  // the component boundary the placement segment (task-149) makes visible.
  // Divergence (`*`) deliberately keeps using localComponentFile — an inner
  // element still marks its own edit.
  const isLocalPlacementRoot = useMemo(
    () => isPlacementRoot(key, scannedByKey),
    [key, scannedByKey],
  );
  const localComponentSource = localComponentFile && isLocalPlacementRoot ? localComponentFile : null;
  // Files-truth blog binding (task-240): the BlogSlot on a PAGE is a scanned
  // source element (no Yjs instance, so `isBlogSlot` never fires for it); its
  // binding is the page's own code. Gate = the slot's placement ROOT on a page.
  // A component opened from Assets with its ROOT selected (what opening it selects) → Backdrop.
  const isComponentViewRoot = isLocalComponentView && isLocalPlacementRoot && parsedKey?.type === 'source' && parsedKey.file === localComponentViewFile;
  const isFilesTruthBlogSlot = isLocalProject && !isLocalComponentView && isLocalPlacementRoot
    && parsedKey?.type === 'source' && basenameFromAstroSource(parsedKey.file) === 'BlogSlot';
  // task-240 Phase 2: a text/img element inside a collection card binds to a
  // collection field — writable in the card MASTER (component view of that
  // file), read-only on a page instance (never a write from the instance).
  // Which collections a card serves = its assignment (utils/cardAssignment —
  // the ONE rule: own code > name > usage > unassigned), fed per
  // scan/sync into utils/cardTitleLock's cache. A file the cache does not know
  // is no card — except BlogCard before the first read (shared fallback).
  const cardCacheVersion = useCardTitleLockVersion();
  const cardCollectionsOf = useCallback((file: string) => {
    const a = cardAssignmentOf(file)?.card ? cardAssignmentOf(file) : null;
    if (!a && basenameFromAstroSource(file) !== 'BlogCard') return null;
    const names = a ? a.collections : diskCollections.map((c) => c.name);
    return diskCollections.filter((c) => names.includes(c.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cardCacheVersion: re-read the cache when it changes
  }, [diskCollections, cardCacheVersion]);
  const cardField = useMemo<{ mode: 'master' | 'instance'; loc: { file: string; line: number; column: number }; collections: typeof diskCollections } | null>(() => {
    if (!isLocalProject || !tagName || !bindingKindFor(tagName) || parsedKey?.type !== 'source') return null;
    const collections = cardCollectionsOf(parsedKey.file);
    if (!collections) return null;
    const mode = localComponentViewFile === parsedKey.file ? 'master' : 'instance';
    return { mode, loc: { file: parsedKey.file, line: parsedKey.line, column: parsedKey.col }, collections };
  }, [isLocalProject, tagName, parsedKey, localComponentViewFile, cardCollectionsOf]);
  // The card's fields + eyes whenever any element of a card is selected — in
  // the card view or on a page (owner 2026-10-09). An eye edits the card FILE,
  // so it applies to every page rendering that collection's card.
  const selectedCard = isLocalProject && parsedKey?.type === 'source' ? (() => {
    const collections = cardCollectionsOf(parsedKey.file);
    const a = cardAssignmentOf(parsedKey.file);
    return collections ? { file: parsedKey.file, collections, conflict: a?.conflict ?? [], typedFor: a?.typed ?? undefined } : null;
  })() : null;

  // task-149: the instance lifecycle for that element. In local mode a page
  // renders its components inline, so an edit here is an INSTANCE edit that
  // lives as a doc overlay (see store/localMasterOverrides.ts). These give it
  // the ⋮ menu: * when the component carries
  // unpushed edits, Push writes the real .astro file, Reset drops them.
  // task-149: WHICH invocation of that component file this element belongs to.
  // Push / Reset / `*` must act on the selected placement alone — a file-wide
  // scope would ship an edit the user made on a page they are not looking at,
  // and would light `*` for one they cannot see.
  const localComponentPlacement =
    parsedKey?.type === 'source' ? parsedKey.placement : undefined;

  const localMasterDiverged = useYjsValue(
    (d) => hasLocalMasterOverrides(d, localComponentFile, localComponentPlacement),
  );
  // task-184 ↻. NOT useYjsValue: one half of the comparison is the scan-fed
  // class-write baseline (a module singleton, not doc state), so the doc tick
  // is the wrong trigger — `scannedByKey` is. It changes on exactly the event
  // that can flip this: a fresh scan, which is what an HMR-delivered master
  // edit produces.
  const localOutdated = useMemo(
    () => localMasterOutdated(doc, localComponentFile, localComponentPlacement),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scannedByKey is the recompute trigger
    [doc, localComponentFile, localComponentPlacement, scannedByKey, localMasterDiverged],
  );
  const [isPushingLocalMaster, setIsPushingLocalMaster] = useState(false);

  // Declared here (not with docUsage below) because the push handler's dep array
  // is evaluated at render time and would hit the TDZ otherwise.
  // The placement is passed so `overriddenPlacements` answers "how many
  // placements does a Push FROM HERE leave overriding" — the question the toast
  // subtracts 1 from (task-187).
  const localUsage = useComponentUsage(localComponentFile, localComponentPlacement);

  const handlePushLocalMaster = useCallback(async () => {
    if (!localComponentFile || isPushingLocalMaster) return;
    // DISPLAY name, not a filename: `Header`, not `Header.astro`. The suffix
    // leaked into local's toast while the doc-instance path (which has
    // always used basenameFromAstroSource) showed the bare name — the review's item 2. Every
    // other surface that names a component (layers rows, go-to-source labels,
    // the component library) shows the bare name too.
    const name = basenameFromAstroSource(localComponentFile) ?? localComponentFile;
    // ONE react-hot-toast id, updated in place: the writes are sequential and
    // each can sit on the writer's 10s timeout, so a result-only toast leaves
    // the user with no signal for the whole push (round-5: "Push produces no
    // confirmation message"). The menu's "Pushing..." label is no substitute —
    // the click already closed the menu.
    const toastId = `local-push:${localComponentFile}`;
    const pushEntries = localOverridesForPlacement(doc, localComponentFile, localComponentPlacement);
    setIsPushingLocalMaster(true);
    let acceptedCount = 0;
    let pendingStep = 'prepare Push';
    try {
      toast.loading(pushStartNotice(name, pushEntries.length), { id: toastId });
      // ONE ⌘Z takes the Push back — the same code path the AI's push_instance_to_source runs.
      const result = await pushLocalOverridesUndoable(doc, localComponentFile, localComponentPlacement,
        { takeSnapshot, claimSnapshot }, pushed => { acceptedCount = pushed.pushed; pendingStep = 'prepare Undo'; });
      // The master file moved: every OTHER placement on this page must re-render
      // from source. The write's own Vite reload already refreshes the canvas in
      // place (seamless canvas); this one also clears the parent's retry queue
      // and covers a byte-identical no-op. A targeted repaint stays rejected: the
      // writers TRANSFORM values on their way into the file, so only the served
      // HTML is a faithful answer.
      if (result.pushed > 0) requestPreviewReload();
      // Failed overrides stay in the doc, so the canvas keeps showing them — it is
      // not lying, and a retry is one more click.
      // The loading toast is resolved only now, AFTER the canvas is consistent, so
      // the user's "done" signal means done rather than "the write returned".
      const { level, message } = pushNotice(name, result, {
        pageCount: localUsage.pages.length || undefined,
        overriddenPlacements: localUsage.overriddenPlacements,
      });
      if (level === 'error') toast.error(message, { id: toastId });
      else if (level === 'success') toast.success(message, { id: toastId });
      else toast(message, { id: toastId });
    } catch (error) {
      const accepted = acceptedCount > 0
        ? `${acceptedCount} ${acceptedCount === 1 ? 'change was' : 'changes were'} accepted.`
        : 'No changes were accepted.';
      const reason = error instanceof Error ? error.message : String(error);
      toast.error(t("{0}: {1} Could not {2}: {3}", { 0: name, 1: accepted, 2: pendingStep, 3: reason }), { id: toastId });
    } finally {
      setIsPushingLocalMaster(false);
    }
  }, [
    doc, localComponentFile, localComponentPlacement, isPushingLocalMaster,
    localUsage.pages.length, localUsage.overriddenPlacements, takeSnapshot, claimSnapshot,
  ]);

  const handleResetLocalMaster = useCallback(async () => {
    if (!localComponentFile) return;
    const entries = localOverridesForPlacement(doc, localComponentFile, localComponentPlacement);
    if (entries.length === 0) return;
    takeSnapshot(); // ⌘Z brings the discarded edits back — and the page props (files)
    await resetLocalOverrides(doc, entries, claimSnapshot?.());
    // No file changed, so nothing refreshes on its own — re-render the preview
    // from source to get bare master output back onto the canvas. Its ⌘Z goes
    // through the SAME mechanism (store/localUndoRepaint.ts), not a second one.
    requestPreviewReload();
  }, [doc, localComponentFile, localComponentPlacement, takeSnapshot, claimSnapshot]);

  const mediaProjectId = useYjsValue(selectProjectId);
  // task-206 D4: a click inside a rendered <Media/> selects the MEDIA UNIT —
  // MediaBlock replaces the whole block stack and the master chrome hides.
  const unitSelected = useMemo(() => {
    const el = key ? scannedByKey.get(key) : null;
    return el ? { mediaUnit: el.mediaUnit, astroSource: el.sourceLocation?.file ?? null } : null;
  }, [key, scannedByKey]);
  // Finding 27: both resolvers are runtime-scoped — in the local runtime the
  // template shapes (src/components/Media.astro) name the USER's own file
  // and must keep normal component chrome, never MediaBlock/SystemComponentBlock.
  const mediaSelection = useMemo(
    () => resolveMediaUnit(unitSelected, isLocalProject),
    [unitSelected, isLocalProject],
  );

  // task-207 Task 9: any OTHER sq/ component gets the generic manifest panel.
  // Media keeps its own block (count + width are not plain attributes).
  // Off the local runtime, isComponentUnitPath routes the system Media
  // (src/components/Media.astro, no sq/ copy — D6) to MediaBlock, and a PROMOTED component named Media
  // (library/sq/Media.astro) here.
  const componentUnit = useMemo(() => {
    const unit = resolveComponentUnit(unitSelected);
    return unit && unit.path && isComponentUnitPath(unit.path, isLocalProject) ? unit : null;
  }, [unitSelected, isLocalProject]);
  const componentManifest = useMemo(
    () => (componentUnit?.path ? manifestForComponent(userProject, componentUnit.path) : null),
    [componentUnit?.path, userProject],
  );

  const goToSourceComponentName = useMemo(() => goToSourceNameFor({
    isPostRoot,
    postRootComponentName,
    isEditorChildInstance,
    isBlogSlot,
    blogSlotComponentType: BLOG_SLOT_COMPONENT_TYPE,
  }), [isPostRoot, postRootComponentName, isEditorChildInstance, isBlogSlot]);

  // task-240 files-truth: the page's own code names the collection and the
  // emitted card wrapper stamps data-sq-post-slug (the bridge reads the nearest
  // stamp) — resolve the disk post with the same rules an imported link uses.
  // The selection's line on the PAGE (its own, or the usage of the component it
  // sits in): on a page with several BlogSlots it picks which one Blog
  // Settings, the card picker and Go to post act on (task-244 L18).
  const selectedPageLine = useMemo(() => {
    const file = getLocalPageFile();
    let cur = key ? scannedByKey.get(key) : undefined;
    for (let i = 0; cur && file && i < 64; i++) {
      if (cur.usageLocation?.file === file) return cur.usageLocation.line;
      if (cur.sourceLocation?.file === file) return cur.sourceLocation.line;
      cur = cur.parentKey ? scannedByKey.get(cur.parentKey) : undefined;
    }
    return null;
  }, [key, scannedByKey]);
  const pageBlogBinding = useBlogBinding(selectedPageLine);
  // Our own canonical page code evolves (2026-09-12: the post-link wrapper +
  // its data-sq-post-slug stamp). A bound, non-custom page written by an older
  // build is upgraded ONCE when the user works on it — the writer is a no-op
  // when the shape is already current, journaled + undoable when it is not.
  // Gated on the page being IN SYNC: the binding can arrive before that
  // page's scan lands (the page file is published first) and the writer
  // refuses until the scan vouches for the page — the scan re-runs the effect
  // (scannedByKey). Attempts per page are capped; a success spends the cap.
  const upgradeAttemptsRef = useRef<Map<string, number>>(new Map());
  /** ≤3 attempts per key while this DesignBar lives; a success spends them. */
  const attemptUpgrade = useCallback((key: string, run: () => Promise<{ ok: boolean } | undefined>) => {
    const attempts = upgradeAttemptsRef.current.get(key) ?? 0;
    if (attempts >= 3) return;
    upgradeAttemptsRef.current.set(key, attempts + 1);
    void Promise.resolve(run()).then((res) => { if (res?.ok) upgradeAttemptsRef.current.set(key, 3); });
  }, []);
  useEffect(() => {
    const file = getLocalPageFile();
    if (!localProjectPathValue || !file || !pageBlogBinding?.hasSlot || !isLocalPageInSync()) return;
    // Every slot of the page (L20): a custom one is skipped, the others still upgrade.
    attemptUpgrade(`page|${file}`, () => reemitLocalBlogSlots({ pageFile: file, localProjectPath: localProjectPathValue, pushUndo: pushStructuralUndo }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scannedByKey: re-check once the page's scan lands
  }, [localProjectPathValue, pageBlogBinding, pushStructuralUndo, scannedByKey]);
  // The card the bound page renders upgrades with it: a placeholder box left by
  // an older build binds to the collection's image field (see
  // localFieldBind.upgradeLocalCardImage — a no-op unless the box is still the
  // library placeholder). The image-field gate keeps a run before the
  // collection's fields have loaded from spending the cap.
  useEffect(() => {
    const collection = pageBlogBinding?.collection;
    if (!localProjectPathValue || !collection || !isLocalPageInSync()) return;
    const fields = diskCollections.find((c) => c.name === collection)?.inferredFields ?? [];
    if (!fields.some((f) => f.type === 'image')) return;
    attemptUpgrade(`card|${collection}`, () => upgradeLocalCardImage({ fields }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scannedByKey: re-check once the page's scan lands
  }, [localProjectPathValue, pageBlogBinding, diskCollections, scannedByKey]);
  // The slot chrome the page renders upgrades with it too: a BlogSlot.astro
  // written by an older build lets a Flex/Grid section put the pagination
  // BESIDE the cards (owner 2026-09-20); the library shape claims a full row.
  useEffect(() => {
    if (!localProjectPathValue || !pageBlogBinding?.hasSlot || !isLocalPageInSync()) return;
    attemptUpgrade(`slot|${localProjectPathValue}`, () => upgradeLocalBlogSlotChrome());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scannedByKey: re-check once the page's scan lands
  }, [localProjectPathValue, pageBlogBinding, scannedByKey]);
  const goToPostTarget = useMemo(() => {
    if (isLocalProject && postSlug && pageBlogBinding?.collection) {
      const filesTruth = importedPostTargetFor([`/${pageBlogBinding.collection}/${postSlug}`], diskCollections);
      if (filesTruth) return filesTruth;
    }
    if (isInsideBlogSlot && blogCollection && postSlug && isPostRoot) {
      return { collection: blogCollection.name, slug: postSlug };
    }
    // Doc-bound post page: the <article> root, or ANY Media/sq-component unit
    // inside the rendered body (see docPostPageTarget for the rationale).
    const docPostTarget = docPostPageTarget({
      collectionName: postPageCollectionName,
      previewPostSlug: previewPost?.slug ?? null,
      effectiveTagName,
      isUnitSelection: !!(mediaSelection || componentUnit),
    });
    if (docPostTarget) return docPostTarget;
    // Local mode: the current page IS a post's rendered route
    // ('/works/timepad-redesign') — any selection on it offers "Go to post".
    return localPostTargetFor(currentLocalPageName, diskCollections) ?? importedPostTargetFor(postLinkPaths, diskCollections);
  }, [isLocalProject, pageBlogBinding, isInsideBlogSlot, blogCollection, postSlug, isPostRoot, postPageCollectionName, previewPost, effectiveTagName, mediaSelection, componentUnit, currentLocalPageName, diskCollections, postLinkPaths]);

  // Get classes from ClassStore (source of truth) instead of SelectionContext
  // This ensures we see updates immediately after setClasses() is called
  const storeClasses = useElementClasses(key);

  // For blog card children: compare current classes against the `:blogcard`
  // element's staticMarkup — which is kept in sync with BlogSlot.astro on
  // every push. Using the library BlogCard.astro here would falsely flag
  // divergence forever once anything has been pushed, since pushes write to
  // BlogSlot.astro (not BlogCard.astro).
  // Handles both instance-child keys (drawn-xxx:blogcard:tag-N) and legacy
  // dynamic keys (dynamic:tag:N@hash) as a fallback.
  const isBlogCardChildDiverged = useMemo(() => {
    if (!isInsideBlogSlot || !key || !selectionTagName) return false;
    if (!resolvedBaseMarkup) return false;

    let tag: string | null = null;
    let tagIndex: number | null = null;

    const parsed = parseKey(key);
    if (parsed?.type === 'instance-child') {
      const selectorMatch = parsed.selector.match(/^([a-z][a-z0-9]*)-(\d+)$/i);
      if (selectorMatch) {
        tag = selectorMatch[1];
        tagIndex = parseInt(selectorMatch[2], 10);
      }
    }

    if (tag === null) {
      const parts = key.split(':');
      if (parts.length >= 3) {
        const tagPart = parts[parts.length - 1];
        const indexMatch = tagPart.match(/^(\d+)/);
        if (indexMatch) {
          tagIndex = parseInt(indexMatch[1], 10);
          tag = parts[parts.length - 2];
        }
      }
    }

    if (!tag || tagIndex === null) return false;

    const originalClasses = extractClassByTagIndex(resolvedBaseMarkup, tag, tagIndex);
    if (originalClasses === null) return false;
    // Token-SET compare — serialization order differs between the overlay
    // markup and the flat class string; order must not read as divergence.
    return !sameTokenSet((storeClasses || '').split(/\s+/).filter(Boolean), stripDataKeys(originalClasses));
  }, [isInsideBlogSlot, key, selectionTagName, resolvedBaseMarkup, storeClasses]);

  const isDiverged = isDivergedFromOriginal || isBlogCardChildDiverged || settingsDiverged;

  // Indicator state machine (wiki design-bar.md UC8). INDEPENDENT, not
  // mutually exclusive (user call 2026-07-03): * = unpushed local edits,
  // ↻ = master moved past this instance's edit — when both are true, both
  // show. Today the only outdated axis is BlogSlot settings vs the defaults
  // binding — markup masters are live via the `masters` overlay, so markup
  // never goes stale.
  // showReload is derived below, once the divergence SCOPE ROOT is known — see
  // the note there.
  // ── The `*` marker, ATTRIBUTED (owner acceptance criterion 2, 2026-08-03) ──
  //
  // `*` used to be lit from one instance-wide boolean, so every untouched
  // sibling inside an edited placement claimed the edit. It now means "THIS
  // element diverged"; a container that merely HOLDS changes gets the visually
  // distinct `N edited inside` badge instead (DivergenceMarker.tsx).
  //
  // Both paths feed the same two numbers — the doc-instance path from
  // collectInstanceDivergence, local from localOverridesForPlacement — so the
  // rendered contract is identical. `\n`-joined because useYjsValue caches by
  // value and a fresh array every doc tick would defeat it.
  //
  // task-119 gate preserved: * advertises divergence-from-master and Push
  // targets astroSource, so an element with no master (AI/markup-only,
  // astroSource null) carries overrides that aren't pushable anywhere — no *.
  const docDivergedJoined = useYjsValue<string>((d) =>
    instanceId ? collectInstanceDivergence(d, instanceId, currentPageId).join('\n') : '');
  const localDivergedJoined = useYjsValue<string>((d) =>
    localOverridesForPlacement(d, localComponentFile, localComponentPlacement)
      .map((e) => e.key).join('\n'));
  const docMarkerGate = canResetInstance && astroSource !== null;
  // An instance ROOT is addressed TWO ways for the same DOM node: the instance
  // key itself (what the canvas selects) and `instanceId:<outermost tag>-0`
  // (where its own class / markup / link overrides are written). Attributing
  // only the first would file the root's own edit as something it "contains".
  const rootAliases = useMemo(() => {
    const set = new Set<string>();
    if (!instanceId) return set;
    set.add(instanceId);
    const tag = /<\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(resolvedBaseMarkup)?.[1];
    if (tag) set.add(`${instanceId}:${tag.toLowerCase()}-0`);
    return set;
  }, [instanceId, resolvedBaseMarkup]);
  const isRootSelection = !!key && rootAliases.has(key);
  const selfKeys = useMemo(
    () => (isRootSelection ? rootAliases : new Set(key ? [key] : [])),
    [isRootSelection, rootAliases, key],
  );
  const { selfDiverged, containedChanges } = useMemo(() => {
    const split = (s: string) => (s ? s.split('\n') : []);
    const docKeys = docMarkerGate ? split(docDivergedJoined) : [];
    const local = split(localDivergedJoined);
    const isSelf = (k: string) => selfKeys.has(k);
    const self =
      docKeys.some(isSelf) || local.some(isSelf)
      || (docMarkerGate && isBlogCardChildDiverged)
      // BlogSlot settings live on the instance ROOT, so they are the root's own
      // divergence, never a child's.
      || (docMarkerGate && settingsDiverged && isRootSelection);
    const contained =
      docKeys.filter((k) => !isSelf(k)).length
      + local.filter((k) => !isSelf(k)).length
      // Drawn children inside a BlogSlot are content it CONTAINS, not an edit
      // to the slot element itself.
      + (docMarkerGate && isBlogSlot && hasDrawnElements ? 1 : 0);
    return { selfDiverged: self, containedChanges: contained };
  }, [
    selfKeys, isRootSelection, docMarkerGate, docDivergedJoined, localDivergedJoined,
    isBlogCardChildDiverged, settingsDiverged, isBlogSlot, hasDrawnElements,
  ]);
  // Only the SCOPE ROOT reports what it contains: the instance root in
  // the doc-instance path, the placement root in local. A sibling is not an ancestor, so it
  // must stay silent about the element next to it.
  const isDivergenceScopeRoot = isRootSelection || isLocalPlacementRoot;
  const showAsterisk = selfDiverged;
  const containedChangeCount =
    !selfDiverged && isDivergenceScopeRoot ? containedChanges : 0;
  const canResetFromMenu = isDiverged || hasDrawnElements || settingsOutdated;

  // ── ↻ (pull from source) is a SCOPE-ROOT affordance, in every runtime ──
  //
  // Blind review 2026-08-04 item 4: "An extra ↻ appears on an overridden child
  // in one runtime only." `canResetInstance` is true for `instance-child` keys,
  // so the doc-instance path rendered ↻ on every child of an outdated instance; local never
  // rendered it at all (its keys are `source` kind, so canResetInstance is
  // false, and by construction a local master cannot go stale — the file IS the
  // master and HMR delivers it).
  //
  // The doc-instance path's placement was the wrong one, not local's absence: the ↻ axis is
  // `masterBaseRev` on the INSTANCE (store/masters.ts isMasterMarkupOutdated),
  // and clicking it resets the whole instance. Offering an instance-scoped
  // action from a child selection is exactly the defect the 2026-08-03 ruling
  // removed from `↗` / `⋮`; this closes the last control that still did it.
  // Result: on an overridden child both runtimes now show nothing.
  //
  // task-184 REVERSES the second half of that note. "Local cannot go stale
  // because HMR delivers the master immediately" was measured false: HMR does
  // deliver it, and `reapplySourceClassOverrides` then repaints the stored
  // override over it on the same scan, so the placement renders the pre-edit
  // master while its un-overridden siblings move. That is precisely "the master
  // moved past your edit and you are not receiving it". `localOutdated` is the
  // same base-vs-now question `markupOutdated` asks, one tier down — see
  // store/localMasterOverrides.ts. Same SCOPE-ROOT rule: `localComponentSource`
  // is already null unless this selection is the placement root.
  const showReload =
    (canResetInstance
      && isDivergenceScopeRoot
      && (settingsOutdated || (markupOutdated && hasLocalOverrides)))
    || (!!localComponentSource && localOutdated);

  // ── Push / Reset act at once (⌘Z takes them back — culture.md Law 6); the Push report names its blast radius ──
  const docUsage = useComponentUsage(astroSource ?? null);
  // localUsage is declared above, next to the push handler that also reads it.
  // Body extracted to store/instanceLifecycle.ts (pushInstanceToSource). The
  // doc-instance push is a doc/masters write, not a file write, so the shared
  // notice says "pushed" and names the component — it never invents a file path
  // this runtime does not touch.
  const docComponentName = (astroSource ? basenameFromAstroSource(astroSource) : undefined) ?? 'this component';
  const docPendingChanges = docDivergedJoined ? docDivergedJoined.split('\n').length : 0;
  const handlePushToSource = useCallback(async () => {
    if (!instanceId || !astroSource) {
      toast.error(t("Push failed: no source component resolved for this selection."));
      return;
    }
    const result = await pushInstanceToSource({
      doc,
      dispatch,
      takeSnapshot,
      instanceId,
      astroSource,
      currentPageId,
    });
    // A discarded {ok:false} here used to be a fully silent no-op — the user
    // pressed Push, nothing happened anywhere, and nothing said why.
    if (!result.ok) {
      toast.error(t("Push failed: {0}", { 0: result.reason ?? 'unknown reason' }));
      return;
    }
    // The doc write is synchronous and all-or-nothing: everything that diverged
    // is now baked into the master, so `pushed` is the pre-push count and
    // `failed` is structurally 0.
    const { level, message } = pushNotice(
      docComponentName,
      { pushed: docPendingChanges, failed: 0 },
      { pageCount: docUsage.pages.length || undefined, overriddenPlacements: docUsage.overriddenPlacements },
    );
    if (level === 'error') toast.error(message);
    else if (level === 'success') toast.success(message);
    else toast(message);
  }, [
    instanceId, astroSource, doc, dispatch, takeSnapshot, currentPageId,
    docPendingChanges, docComponentName, docUsage.pages.length, docUsage.overriddenPlacements,
  ]);

  // task-149 review: the master view was a dead end — no list of instances, no
  // "3 uses", no route back to a placement that diverged. The master's own file
  // is the editor root's astroSource on the doc-instance path and the open component file in
  // local; ONE badge, fed by ONE hook.
  const masterViewSource = isComponentEditor
    ? (localComponentViewFile ?? editorRootAstroSource ?? null)
    : null;
  const openUsagePage = useCallback((pageId: string) => {
    // Leave the master view EXPLICITLY, before navigating. Local's master view
    // is not a doc page — Editor keeps the page id you came from and only
    // overrides the iframe route, and it leaves the view from an effect keyed on
    // `currentPageId`. Picking the page you came FROM leaves that id unchanged,
    // the effect never re-runs, and the row does nothing at all (round-5: the
    // `/` row was dead while `/about` worked). requestPageView: LeftSidebar sends
    // the view event, so Editor stays the only writer of that state.
    requestPageView();
    dispatch({ type: 'SET_CURRENT_PAGE', pageId });
  }, [dispatch]);

  const [activeTab, setActiveTab] = useState<DesignBarTab>('design');

  const handleTabChange = useCallback((value: string) => {
    setActiveTab(value as DesignBarTab);
  }, []);

  // The class-merge BASE. `storeClasses` (the sourceClasses tier) is only
  // populated by ClassStore.registerElement, which runs on the iframe-click
  // path alone — a Layers-panel selection (or an undo that deleted the entry)
  // leaves it ABSENT, and every block would then compute its edit from NO
  // classes: one colour click stored a single token as the element's ENTIRE
  // class attribute, wiping typography and every responsive variant (and in
  // server/local mode the writers bake that truncation into the real .astro).
  // The scan and the click payload both carry the element's live class string,
  // so fall back to them.
  //
  // `??`, never `||`: an entry holding '' means the user deliberately stripped
  // the element to nothing, and falling through on that would resurrect the
  // classes they just deleted on the very next click. Absence is null;
  // emptiness is authoritative. Branch-free on purpose — byte-identical
  // whenever the tier HAS an entry.
  // Regression: __tests__/DesignBar.classMergeBase.test.tsx
  const fullClasses =
    storeClasses ?? scannedByKey.get(key ?? '')?.classes ?? selectedClasses ?? '';

  const handleClassesTabChange = useCallback((newClasses: string) => {
    if (!key) return;
    setClasses(key, newClasses);
    onClassesChange?.(newClasses);
  }, [key, setClasses, onClassesChange]);

  // Parse into unified storage structure
  const storage = useMemo(() => {
    return parseClasses(fullClasses);
  }, [fullClasses]);

  // Ref for storage to avoid stale closures in handleClassesChange
  // Update during render, not in useEffect (per CLAUDE.md pattern)
  const storageRef = useRef(storage);
  storageRef.current = storage;

  // Pending storage for accumulating rapid sequential changes. The ref is for
  // same-task handler chains (before React re-renders); the state forces a
  // re-render so blocks receiving `classes` props see the latest in-flight
  // edit — without this, a second axis edit reads a stale `classes` prop and
  // silently drops the previous edit.
  const pendingStorageRef = useRef<ClassStorage | null>(null);
  const [pendingStorage, setPendingStorage] = useState<ClassStorage | null>(null);
  pendingStorageRef.current = pendingStorage;

  // Clear pending storage when actual storage updates (React has re-rendered)
  useEffect(() => {
    setPendingStorage(null);
  }, [storage]);

  // Map activeBreakpoint to our Breakpoint type
  const currentBreakpoint = (activeBreakpoint === PRIMARY_BREAKPOINT ? 'xs' : activeBreakpoint) as Breakpoint;
  const currentTheme = activeTheme as Theme;
  const currentState = activeState as State;
  // Grid placement is read and written on the layer the CANVAS shows — the one
  // its drag and resize write — not on the editing layer: at an lg canvas a
  // base col-start loses to an lg: one and the edit changes nothing (owner
  // 2026-11-12, proven live). `??` only covers test mocks without a viewport.
  const placementBreakpoint = viewportBreakpoint ?? currentBreakpoint;

  // Derive parent grid dimensions from Yjs (cascade-aware) for grid child placement inputs
  const parentGridInfo = useMemo(() => {
    const none = { cols: 0, rows: 0 };
    if (!isGridChild || !key) return none;

    const parentKey = scannedByKey.get(key)?.parentKey;
    const parentClasses = parentKey ? getClassesFromYjs(parentKey) : '';
    if (!parentClasses) return none;

    const parentStorage = parseClasses(parentClasses);
    const effective = getEffectiveClasses(parentStorage, placementBreakpoint, currentTheme, 'default');

    const extractGridDim = (prefix: string): number => {
      const token = effective.find(cls => cls.startsWith(prefix));
      return token ? parseInt(token.slice(prefix.length), 10) || 0 : 0;
    };

    return { cols: extractGridDim('grid-cols-'), rows: extractGridDim('grid-rows-') };
  }, [isGridChild, key, scannedByKey, getClassesFromYjs, placementBreakpoint, currentTheme]);

  // Selected child's rendered cell (bridge geometry) — feeds the Layout block's
  // Start+Span fallback so col-span-only / auto-placed children aren't empty.
  // Gated on element key + frame breakpoint: a Layers-panel selection or a
  // breakpoint switch must NOT show another element's / another frame's cell
  // (task-090 review — stale-geometry guard).
  const rawSelectedCell = useSelectedCellGeometry();
  // The frame measures at the canvas breakpoint. Frames speak 'base',
  // BreakpointContext speaks 'xs' for the primary — map before gating.
  const frameBreakpoint = placementBreakpoint === PRIMARY_BREAKPOINT ? 'base' : placementBreakpoint;
  const selectedCell = useMemo(
    () => (rawSelectedCell ? selectedCellFor(key, frameBreakpoint) : null),
    [rawSelectedCell, key, frameBreakpoint],
  );
  const gridCell = useMemo(() => (
    selectedCell
      ? { colStart: selectedCell.start, colSpan: selectedCell.span, rowStart: selectedCell.rowStart, rowSpan: selectedCell.rowSpan }
      : null
  ), [selectedCell]);
  // Prefer the real geometry track counts (more reliable than Yjs-derived) for
  // clamping and col-span-full translation; fall back to the class-derived count.
  // sizeIsExact: only geometry counts may bound edits — the class fallback is
  // resolved at the active breakpoint and can be the wrong value (task-094 B1).
  const effectiveParentGrid = useMemo(() => ({
    cols: selectedCell?.parentCols || parentGridInfo.cols,
    rows: selectedCell?.parentRows || parentGridInfo.rows,
    sizeIsExact: !!selectedCell,
  }), [selectedCell, parentGridInfo]);

  // Get effective classes for current breakpoint, theme, and state. Prefer
  // pending storage when set so blocks rebuilding from this prop (e.g. the
  // Spacing block's four-sided padding state) don't lose the previous edit.
  const effectiveClasses = useMemo(() => {
    return getEffectiveClasses(pendingStorage ?? storage, currentBreakpoint, currentTheme, currentState);
  }, [pendingStorage, storage, currentBreakpoint, currentTheme, currentState]);

  // Check for breakpoint overrides (for UI indicators)
  const breakpointOverrides = useMemo(() => {
    return getBreakpointOverrides(storage, currentBreakpoint, currentTheme);
  }, [storage, currentBreakpoint, currentTheme]);

  // The storage an edit starts from: the pending one while React has not
  // re-rendered (rapid sequential updates), else fresh from Yjs — stale React
  // state would make the new class replace everything (undo depends on this).
  // A gesture's stash/preview never sets the pending one (instant-edit P2).
  const freshStorage = useCallback((): ClassStorage => {
    if (getGestureScope() === 'commit' && pendingStorageRef.current) return pendingStorageRef.current;
    const fresh = key ? getClassesFromYjs(key) : '';
    return fresh ? parseClasses(fresh) : storageRef.current;
  }, [key, getClassesFromYjs]);
  // Persist a class string. Its storage stays pending until React re-renders:
  // the ref is read by the next handler call in the same task, the state makes
  // blocks see the fresh classes on the next render.
  // A value gesture in flight (instant-edit P2): 'stash' = a typed draft's keystroke, 'preview' = a stepper tick.
  const commitClasses = useCallback((finalClasses: string, newStorage: ClassStorage = parseClasses(finalClasses)) => {
    if (!key) return;
    const gestureScope = getGestureScope();
    if (gestureScope !== 'commit') {
      // The safety net first (synchronous), then — for a stepper tick — the paint and the panel echo. NEVER the lane, never
      // onClassesChange, and never pendingStorage: it clears only when the rendered storage changes, and an aborted gesture
      // leaves the rendered storage as it was, so the aborted value would stay the merge base of the NEXT edit.
      if (projectId) stashPut({ projectId, key, classes: finalClasses, baseline: getClassesFromYjs(key), origin: captureLocalWriteOrigin(), opId: null });
      if (gestureScope === 'preview') previewClasses(key, finalClasses);
      return;
    }
    pendingStorageRef.current = newStorage;
    setPendingStorage(newStorage);
    setClasses(key, finalClasses);
    onClassesChange?.(finalClasses);
  }, [key, setClasses, previewClasses, onClassesChange, getClassesFromYjs, projectId]);

  // Handle class changes from blocks
  const handleClassesChange = useCallback((newBlockClasses: string) => {
    if (!key) return;
    const newStorage = cloneStorage(freshStorage());
    // The current slot stores only what differs from what it inherits.
    newStorage[currentBreakpoint][currentTheme][currentState] = computeSlotContent(
      newStorage, currentBreakpoint, currentTheme, currentState, newBlockClasses.split(/\s+/).filter(Boolean));
    commitClasses(serializeClasses(newStorage), newStorage);
  }, [key, currentBreakpoint, currentTheme, currentState, freshStorage, commitClasses]);

  // Grid placement goes through the canvas's own write on the canvas's layer,
  // so the panel and a drag never disagree about where a child sits.
  const placementClasses = useMemo(
    () => getEffectiveClasses(pendingStorage ?? storage, placementBreakpoint, 'light', 'default').join(' '),
    [pendingStorage, storage, placementBreakpoint],
  );
  const handleGridPlacementChange = useCallback((axis: 'col' | 'row', tokens: string[], stripsFixedSize: boolean) => {
    if (!key) return;
    const fresh = serializeClasses(freshStorage());
    const prefix = placementBreakpoint === 'xs' ? '' : `${placementBreakpoint}:`;
    // Always state the span: 1 has to beat a wider span from a smaller
    // breakpoint (the write drops it again when 1 is already in force).
    // shortcut: clearing Start here cannot undo a start set on a smaller breakpoint (needs col-start-auto), add it if asked.
    const axisTokens = (tokens.some(t => t.includes('-span-')) ? tokens : [...tokens, `${axis}-span-1`])
      .map(t => prefix + t).join(' ');
    commitClasses(writeGridPlacement(fresh, axis === 'col' ? axisTokens : '', axis === 'row' ? axisTokens : '', stripsFixedSize));
  }, [key, placementBreakpoint, freshStorage, commitClasses]);

  // The grid's own column/row count is edited where the count in force on
  // canvas lives (grid-cols-1 md:grid-cols-2 lg:grid-cols-3 at an lg canvas →
  // the lg one): a base count beside it changes nothing there. No count in
  // force, or a breakpoint layer chosen by hand → the editing layer, as before.
  const handleGridTemplateChange = useCallback((axis: 'col' | 'row', count: number | null) => {
    if (!key) return;
    const prefix = axis === 'col' ? 'grid-cols-' : 'grid-rows-';
    const next = cloneStorage(freshStorage());
    const onCanvas = BREAKPOINTS.slice(0, BREAKPOINTS.indexOf(placementBreakpoint) + 1).reverse();
    const layer = (!isEditingBreakpoint && onCanvas.find(bp => next[bp].light.default.some(t => t.startsWith(prefix)))) || currentBreakpoint;
    const slot = layer === currentBreakpoint ? next[layer][currentTheme][currentState] : next[layer].light.default;
    slot.splice(0, slot.length, ...slot.filter(t => !t.startsWith(prefix)), ...(count ? [`${prefix}${count}`] : []));
    commitClasses(serializeClasses(next), next);
  }, [key, placementBreakpoint, currentBreakpoint, currentTheme, currentState, isEditingBreakpoint, freshStorage, commitClasses]);

  // The value gesture kit's host: what the number fields commit into, how a barrier pushes a pending gesture, what an abort
  // restores. The pin changes with the selection, breakpoint, theme and state: a pending gesture then commits with the closure
  // it began with, never into the new element.
  const gestureHost = useMemo<GestureHost>(() => ({
    pin: `${key ?? ''}|${currentBreakpoint}|${currentTheme}|${currentState}`,
    hold: push => (projectId ? holdProjectInput(projectId, push, { user: true }) : () => {}),
    undo: () => { void undo(); },
    abort: () => { if (key) { abortClassesPreview(key); if (projectId) stashClear(projectId, key); } },
  }), [key, currentBreakpoint, currentTheme, currentState, projectId, undo, abortClassesPreview]);

  // Reset current state's overrides
  const handleResetState = useCallback(() => {
    if (!key || activeState === 'default') return;

    const newStorage = cloneStorage(storage);
    newStorage[currentBreakpoint][currentTheme][currentState] = []; // Clear state overrides

    const finalClasses = serializeClasses(newStorage);
    setClasses(key, finalClasses);
    onClassesChange?.(finalClasses);
  }, [key, storage, currentBreakpoint, currentTheme, currentState, activeState, setClasses, onClassesChange]);

  // Reset current breakpoint's overrides (all states at current theme)
  const handleResetBreakpoint = useCallback(() => {
    if (!key || !isEditingBreakpoint) return;

    const newStorage = cloneStorage(storage);
    // Clear all states at this breakpoint and theme
    const states: State[] = ['default', 'hover', 'focus', 'active', 'disabled'];
    for (const state of states) {
      newStorage[currentBreakpoint][currentTheme][state] = [];
    }

    const finalClasses = serializeClasses(newStorage);
    setClasses(key, finalClasses);
    onClassesChange?.(finalClasses);
  }, [key, storage, currentBreakpoint, currentTheme, isEditingBreakpoint, setClasses, onClassesChange]);

  // Reset current theme's overrides (all states at current breakpoint for dark theme)
  const handleResetTheme = useCallback(() => {
    if (!key || !isEditingDark) return;

    const newStorage = cloneStorage(storage);
    // Clear all states at current breakpoint for dark theme
    const states: State[] = ['default', 'hover', 'focus', 'active', 'disabled'];
    for (const state of states) {
      newStorage[currentBreakpoint].dark[state] = [];
    }

    const finalClasses = serializeClasses(newStorage);
    setClasses(key, finalClasses);
    onClassesChange?.(finalClasses);
  }, [key, storage, currentBreakpoint, isEditingDark, setClasses, onClassesChange]);

  // Remove a specific breakpoint override for a utility prefix
  const handleRemoveBreakpointOverride = useCallback((utilityPrefix: string) => {
    if (!key || !isEditingBreakpoint) return;

    const newStorage = cloneStorage(storage);

    // Filter out classes with this utility prefix from current breakpoint and theme's default state
    newStorage[currentBreakpoint][currentTheme].default = newStorage[currentBreakpoint][currentTheme].default.filter(cls => {
      const group = getPropertyGroup(cls);
      return group !== utilityPrefix;
    });

    const finalClasses = serializeClasses(newStorage);
    setClasses(key, finalClasses);
    onClassesChange?.(finalClasses);
  }, [key, storage, currentBreakpoint, isEditingBreakpoint, setClasses, onClassesChange]);

  // Reset = sync instance with the current source file.
  // Blog slots: reset the slot element's classes from BlogSlot source + card from BlogCard library.
  // Regular instances: reset staticMarkup from source file.
  // (Body extracted to store/instanceLifecycle.ts — shared with the AI tools.)
  const handleResetInstanceToOriginal = useCallback(async () => {
    if (!instanceId) return;
    const result = await resetInstanceToOriginal({
      doc,
      dispatch,
      takeSnapshot,
      instanceId,
      currentPageId,
      isBlogSlot,
      builtIn,
    });
    if (!result.ok) toast.error(result.reason ?? 'Reset was not saved');
  }, [instanceId, dispatch, currentPageId, takeSnapshot, isBlogSlot, doc, builtIn]);

  const currentClasses = effectiveClasses.join(' ');

  // Detect if sections have relevant classes (for +/- toggle)
  const hasComputedBgImage = computedStyles?.backgroundImage && computedStyles.backgroundImage !== 'none';
  const hasFillClasses = useMemo(() => CLASS_PATTERNS.fill.test(currentClasses) || !!hasComputedBgImage, [currentClasses, hasComputedBgImage]);
  const hasStrokeClasses = useMemo(() => CLASS_PATTERNS.stroke.test(currentClasses), [currentClasses]);
  const hasEffectsClasses = useMemo(() => CLASS_PATTERNS.effects.test(fullClasses), [fullClasses]);

  const hasBreakpointClasses = useMemo(() => {
    if (!isEditingBreakpoint) return false;
    const states: State[] = ['default', 'hover', 'focus', 'active', 'disabled'];
    return states.some(state => storage[currentBreakpoint][currentTheme][state].length > 0);
  }, [storage, currentBreakpoint, currentTheme, isEditingBreakpoint]);

  const hasThemeClasses = useMemo(() => {
    if (!isEditingDark) return false;
    const states: State[] = ['default', 'hover', 'focus', 'active', 'disabled'];
    return states.some(state => storage[currentBreakpoint].dark[state].length > 0);
  }, [storage, currentBreakpoint, isEditingDark]);

  const isTextElement = TEXT_ELEMENTS.has(effectiveTagName);
  const isImageElement = effectiveTagName === 'img';
  const isVideoElement = effectiveTagName === 'video';

  // Helper to add classes to current element
  const addClasses = useCallback((classesToAdd: string) => {
    const tokens = currentClasses.split(/\s+/).filter(Boolean);
    const newTokens = classesToAdd.split(/\s+/).filter(Boolean);
    // Add only classes that don't already exist
    newTokens.forEach(cls => {
      if (!tokens.includes(cls)) {
        tokens.push(cls);
      }
    });
    handleClassesChange(tokens.join(' '));
  }, [currentClasses, handleClassesChange]);

  // Helper to remove classes matching a pattern
  const removeClassesMatching = useCallback((patterns: RegExp[]) => {
    const tokens = currentClasses.split(/\s+/).filter(Boolean);
    const filtered = tokens.filter(cls => {
      // Keep the class if it doesn't match any pattern
      return !patterns.some(pattern => pattern.test(cls));
    });
    handleClassesChange(filtered.join(' '));
  }, [currentClasses, handleClassesChange]);

  // ClassStore stages its snapshot and commits it only after durable acceptance.
  const deleteClassesByPredicate = useCallback((keep: (token: string) => boolean) => {
    if (!key) return;
    // Read fresh from store to avoid stale closure
    const classes = getClassesFromYjs(key);
    if (!classes) return;
    const filtered = classes.split(/\s+/).filter(Boolean).filter(keep);
    setClasses(key, filtered.join(' '));
  }, [key, getClassesFromYjs, setClasses]);

  // Remove prefixed classes matching a block pattern (e.g. hover:bg-* for Fill block)
  const deletePrefixClasses = useCallback((prefix: string, blockPattern: RegExp) => {
    deleteClassesByPredicate(t => !(tokenHasVariant(t, prefix) && blockPattern.test(t.replace(VARIANT_LEAD, ''))));
  }, [deleteClassesByPredicate]);

  // Remove every class whose variant cell exactly equals `cell` (header pill ×).
  // Exact-cell: deleting md:hover removes md:hover:* but leaves md:* and hover:*.
  const deleteVariantCell = useCallback((cell: Cell) => {
    deleteClassesByPredicate(t => !tokenMatchesCell(t, cell));
  }, [deleteClassesByPredicate]);

  // Add/Remove handlers for Fill
  const handleAddFill = useCallback(() => {
    addClasses('bg-white');
  }, [addClasses]);

  const handleRemoveFill = useCallback(() => {
    removeClassesMatching([/^bg-/]);
  }, [removeClassesMatching]);

  // Add/Remove handlers for Stroke
  const handleAddStroke = useCallback(() => {
    addClasses('border border-black');
  }, [addClasses]);

  const handleRemoveStroke = useCallback(() => {
    removeClassesMatching([/^border/, /^outline/, /^ring/]);
  }, [removeClassesMatching]);

  // Add handler for Effects - add default shadow directly
  // (can't use ref because EffectsBlock may not be rendered when hasEffectsClasses is false)
  const handleAddEffects = useCallback(() => {
    addClasses('shadow-sm'); // ui-lint-line: user-document class generation
  }, [addClasses]);

  // A text session's link handlers - dispatch custom events that ViewportFrame forwards to iframe
  const { hasTextSelection, isInsideLink, isLinkInteracting, setLinkInteracting } = useTextSelection();
  const { key: selectionContextKey, isEditingText } = useSelectedElement();

  const handleLinkChange = useCallback((href: string) => {
    if (!selectionContextKey) return;

    // Defense-in-depth: sanitize href before dispatching to bridge
    const sanitized = sanitizeUrl(href);
    if (sanitized === null) return;

    // Dispatch custom event that ViewportFrame listens for and forwards to iframe
    document.dispatchEvent(new CustomEvent('sq:wrap-link', {
      detail: {
        key: selectionContextKey,
        href: sanitized
      }
    }));
  }, [selectionContextKey]);

  const handleUnlink = useCallback(() => {
    if (!selectionContextKey) return;

    // Dispatch custom event that ViewportFrame listens for and forwards to iframe
    document.dispatchEvent(new CustomEvent('sq:unwrap-link', {
      detail: {
        key: selectionContextKey,
        linkSelector: '' // Let bridge find the current link
      }
    }));
  }, [selectionContextKey]);

  // The link is the selected element's own (scan row), never the click point's.
  // A text session shows it for its selection; keep the block mounted while the
  // user is in it, or clicking it (the iframe loses focus) would unmount it.
  const linkRow = key ? scannedByKey.get(key) : undefined;
  const hasElementLink = linkRow?.linkHref !== undefined;
  const showLinkBlock = isLinkInteracting || (isEditingText
    ? hasTextSelection || isInsideLink
    : hasElementLink || (!!linkRow?.sourceLocation && !linkRow.linkBlocked));

  // Context value for blocks to access breakpoint override info + the
  // selection descriptor (so sub-panels never need kind booleans as props)
  const designBarContextValue: DesignBarContextValue = useMemo(() => ({
    breakpointOverrides,
    activeBreakpoint,
    isEditingBreakpoint,
    onRemoveBreakpointOverride: handleRemoveBreakpointOverride,
    descriptor,
  }), [breakpointOverrides, activeBreakpoint, isEditingBreakpoint, handleRemoveBreakpointOverride, descriptor]);

  // A layout opened from Assets sits in the editor with nothing selected — show
  // the Layout panel (not the empty Styles/variables panel) so the right bar is
  // identical to selecting the layout node on the canvas.
  const layoutEditorPanel = isLayoutEditor && !!editorLayoutName && !hasSelection;

  // Bundle for the extracted ElementDesignPanel (task-043). Recreated each
  // render — NOT memoized — to preserve the inline JSX's re-render semantics
  // (ledger #17). pendingStorageRef + handleClassesChange stay here (ledger #18).
  const elementDesign: ElementDesignBundle = {
    fillVariant: [currentBreakpoint !== 'xs' ? currentBreakpoint : '', currentTheme !== 'light' ? currentTheme : '', currentState !== 'default' ? currentState : ''].filter(Boolean).map(part => `${part}:`).join(''),
    getCurrentClasses: () => {
      const fresh = key ? getClassesFromYjs(key) : null;
      return getEffectiveClasses(pendingStorageRef.current ?? (fresh ? parseClasses(fresh) : storageRef.current), currentBreakpoint, currentTheme, currentState).join(' ');
    },
    key, currentClasses, fullClasses, handleClassesChange, deletePrefixClasses, computedStyles,
    isTextElement, isImageElement, isVideoElement, hasPenPath: keyElementInfo.hasPenPath, isEditingText, isGridChild, parentGridInfo: effectiveParentGrid, gridCell,
    placementClasses, handleGridPlacementChange, handleGridTemplateChange,
    isInsideBlogSlot, blogSlotKey, showPostPicker, postPageSlotKey,
    hasFillClasses, handleAddFill, handleRemoveFill,
    hasStrokeClasses, handleAddStroke, handleRemoveStroke,
    hasEffectsClasses, handleAddEffects,
    showLinkBlock, handleLinkChange, handleUnlink, setLinkInteracting, imageSrc, imageAlt, imagePreviewDataUrl,
    // Static inline svg instance child (no penPath) → offer conversion into a
    // real pen shape so node editing works. Rendered rect refines the scale.
    onConvertSvgToShape:
      key && /:svg-\d+$/.test(key) && !keyElementInfo.hasPenPath
        ? () => convertSvgToShape(key, scannedByKeyRef.current.get(key)?.rect ?? null)
        : null,
  };

  return (
    <GestureHostContext.Provider value={gestureHost}>
    <DesignBarProvider value={designBarContextValue}>
    <div data-testid="design-bar" className="font-sans text-sm bg-bg">
      {/* Tabs Header — shown for any selection so the layout panel reads as the
          same Design Bar. A synthetic layout node has no classes/source, so it
          gets ONLY the relevant Design tab; a real element gets all three. A
          layout open in the editor with nothing selected shows the Design tab too,
          so its panel is identical to the canvas layout node. */}
      {(hasSelection || layoutEditorPanel) && !isMultiSelect && (
        <div className="flex items-stretch gap-2 px-3 h-10 box-border border-b border-stroke">
          <Tabs
            options={isLayoutSelection || layoutEditorPanel
              ? [{ value: 'design', label: 'Design' }]
              : [
                  { value: 'design', label: 'Design' },
                  { value: 'classes', label: 'Classes' },
                  { value: 'source', label: 'Source' },
                ]}
            value={activeTab}
            onChange={handleTabChange}
            size="sm"
          />
        </div>
      )}

      {/* Tab Content */}
      {!hasSelection ? (
        layoutEditorPanel ? (
          // A layout opened from Assets enters the editor with nothing selected.
          // Render the SAME Layout panel the canvas layout node shows (name +
          // actions + LayoutPropsEditor) so the right bar is identical regardless
          // of how the layout was reached. No page here → schema-only props.
          <div className="p-2">
            {/* No source-relationship actions here: opening a layout in Assets IS
                editing the source, so there is no push/sync/reset/go-to-source — the
                800ms auto-flush saves edits silently, exactly like the component
                editor (which shows no menu when nothing is selected). Just the name
                + the layout-specific props schema. */}
            <DesignBarHeader heading={editorLayoutName} />
            <div className="px-2 pt-2 pb-3 border-b border-stroke">
              <LayoutPropsEditor layoutName={editorLayoutName!} propDefs={editorLayoutPropDefs} mode="editor" />
            </div>
          </div>
        ) : (
          <VariablesQuickPanel />
        )
      ) : isMultiSelect ? (
        // ≥2 selected: the editable multi panel (design docs/plans/2026-11-16-multi-select-edit-design.md).
        // The gate sits ABOVE the descriptor consumers; the tab strip is hidden while multi and
        // activeTab survives, so the previous tab returns after collapse (C2).
        // No value gesture host here: the multi sink (useMultiStyleEdit → setClassesMany) does not read the gesture scope, so a
        // 'stash' keystroke or a 'preview' tick would reach it as a real group edit and the settled commit would repeat it.
        // The number fields fall back to per-event commits, exactly as before the gesture kit.
        <GestureHostContext.Provider value={null}>
          <MultiDesignPanel
            memberKeys={[key!, ...additionalSelections.map(e => e.key)]}
            slot={{ breakpoint: currentBreakpoint, theme: currentTheme, state: currentState }}
          />
        </GestureHostContext.Provider>
      ) : (
      <div className="p-2">
      {isLayoutSelection ? (
        // A page's layout node now resolves to its derived layout-chrome element,
        // so it reuses the component-instance header verbatim: dirty `*` and the
        // InstanceMenu (Push / Reset / Go to source) with the layout-specific
        // Replace / Detach / Delete appended. The standard style blocks are
        // suppressed; only PageLayoutBlock (prop inputs) renders below.
        <>
          <DesignBarHeader
            heading={<>{selectedLayoutName}<DivergenceMarker self={showAsterisk} contained={containedChangeCount} /></>}
            actions={selectedLayoutName && currentPageId && (
              <>
                {/* ↗ go-to-source — the SAME affordance/handler a component
                    instance uses (shared via HeaderActionButtons). */}
                <GoToSourceButton path={layoutAstroSource(selectedLayoutName)} name={selectedLayoutName} />
                {/* Reuse the component InstanceMenu (Push/Reset/Go-to-source) and
                    append the layout-specific items (Replace/Detach/Delete). One
                    menu, one code path — no parallel LayoutMenu. */}
                <InstanceMenu
                  canPush={!!(isDiverged && astroSource)}
                  isPushing={isPushingToSource}
                  onPush={handlePushToSource}
                  canReset={canResetFromMenu}
                  onReset={handleResetInstanceToOriginal}
                  onGoToSource={() => goToSource(layoutAstroSource(selectedLayoutName), selectedLayoutName)}
                  extraItems={[
                    { label: 'Replace layout…', onClick: () => window.dispatchEvent(new CustomEvent('sq:replace-page-layout')) },
                    { label: 'Detach (keep content)', onClick: () => { takeSnapshot(); dispatch({ type: 'SET_PAGE_LAYOUT', pageId: currentPageId, layoutName: null }); } },
                    // No confirm (culture.md Law 6): a doc command after a snapshot — ⌘Z puts it all back.
                    { label: 'Delete layout + content', danger: true, onClick: () => {
                      takeSnapshot();
                      dispatch({ type: 'DELETE_PAGE_LAYOUT_WITH_CONTENT', pageId: currentPageId });
                    } },
                  ] as EntityMenuItem[]}
                />
              </>
            )}
          />
          {/* A post page's PostLayout: header variant + toggles (writes its <PostLayout …> tag). */}
          {selectedLayoutName === 'PostLayout'
            ? <PostLayoutBlock />
            : currentPageId && <PageLayoutBlock pageId={currentPageId} />}
        </>
      ) : activeTab === 'design' ? (
        <>
          {/* Unified element header */}
          <DesignBarHeader
            heading={<>{keyElementInfo.hasPenPath ? 'Shape' : localComponentSource ? basenameFromAstroSource(localComponentSource) : headingLabel}<DivergenceMarker self={showAsterisk} contained={containedChangeCount} /><OrphanedOverridesBadge astroSource={astroSource ?? null} /><ComponentUsageBadge source={masterViewSource} onOpenPage={openUsagePage} /></>}
            tags={
              !isSlotElement && key
                ? <HeaderTags classes={fullClasses} onDeleteCell={deleteVariantCell} />
                : undefined
            }
            actions={
              <ElementHeaderActions
                goToPostTarget={goToPostTarget}
                onOpenPost={openPost}
                slotType={slotType}
                slotComponentName={slotComponentName}
                slotKey={key}
                isComponentEditor={isComponentEditor && !isEditorChildInstance}
                canResetInstance={canResetInstance}
                showReload={showReload}
                onReset={handleResetInstanceToOriginal}
                isInstanceRoot={isInstanceRoot}
                isBlogSlot={isBlogSlot}
                isPostRoot={isPostRoot}
                astroSource={astroSource ?? null}
                goToSourceComponentName={goToSourceComponentName}
                isDiverged={isDiverged}
                isPushingToSource={isPushingToSource}
                onPush={handlePushToSource}
                canResetFromMenu={canResetFromMenu}
                isDrawnElement={isDrawnElement}
                onMakeComponent={handleMakeComponent}
                isMakingComponent={isMakingComponent}
                localComponentSource={localComponentSource}
                localMasterDiverged={localMasterDiverged}
                isPushingLocalMaster={isPushingLocalMaster}
                onLocalPush={localComponentSource ? handlePushLocalMaster : undefined}
                onLocalReset={localComponentSource ? handleResetLocalMaster : undefined}
                systemMaster={mediaSelection ? MEDIA_SYSTEM_COMPONENT : undefined}
              />
            }
          />

          {/* task-206 D4: Media unit selected — MediaBlock is the ONLY panel;
              the entire block stack below is suppressed. */}
          {mediaSelection && (
            <BlockErrorBoundary blockName="Media" resetKey={key}>
              <MediaBlock
                selection={mediaSelection}
                postTarget={goToPostTarget}
                projectId={mediaProjectId}
                demo={isComponentEditor}
                manifest={mediaManifest}
              />
            </BlockErrorBoundary>
          )}

          {/* A post page's PostLayout (files-truth: a local placement root). */}
          {isPostLayoutFile(localComponentSource) && (
            <BlockErrorBoundary blockName="Post layout" resetKey={key}>
              <PostLayoutBlock />
            </BlockErrorBoundary>
          )}

          {/* Slot name (Astro <slot /> marker). A <slot> is a compile-time
              placeholder — its panel is this and ONLY this: the name editor
              (+ future fallback). No layout props, no style stack, no
              breakpoint/theme/state. So it renders ABOVE the !isSlotElement
              region below and that whole region is suppressed for a slot. */}
          {/* task-207: a promoted sq/ component — manifest-driven settings.
              Same suppression law as Media: this panel replaces the stack. */}
          {!mediaSelection && componentUnit && componentManifest && (
            <BlockErrorBoundary blockName={componentUnit.name ?? 'Component'} resetKey={key}>
              <SystemComponentBlock
                unit={componentUnit}
                postTarget={goToPostTarget}
                manifest={componentManifest}
              />
            </BlockErrorBoundary>
          )}

          {!mediaSelection && isSlotElement && key && (
            <ExpandableRow title="Slot" className="mt-2" defaultExpanded>
              <BlockErrorBoundary blockName="Slot" resetKey={key}>
                {/* The name persists only where it has a write-back path: a Yjs
                    slot element (SET_SLOT_NAME), or a source slot inside the
                    component/layout editor. On a real PAGE a filled layout slot
                    is owned by the layout — show the name read-only (rename it in
                    the layout editor). fallbackName = the scanned slot name (the
                    filled slot is a <div data-sq-slot>, not a parseable <slot>). */}
                <SlotBlock
                  elementKey={key}
                  editable={parsedKey?.type !== 'instance-child' || isComponentEditor}
                  fallbackName={selectedSlotName ?? ''}
                />
              </BlockErrorBoundary>
            </ExpandableRow>
          )}

          {!mediaSelection && !isSlotElement && (
            <>
          {/* Layout open in the editor: the shared layout-props editor (schema
              add/delete). No page context here, so it's schema-only (no values). */}
          {isLayoutEditor && editorLayoutName && (
            <div className="px-2 pt-2 pb-3 border-b border-stroke">
              <LayoutPropsEditor layoutName={editorLayoutName} propDefs={editorLayoutPropDefs} mode="editor" />
            </div>
          )}

          {/* Breakpoint/Theme/State are now the header pill cluster (HeaderTags). */}

          {/* Slot target: place a content root into a named layout slot.
              Self-hides unless the page's layout declares named slots. */}
          {!isInstanceChild && key && currentPageId && (
            <BlockErrorBoundary blockName="Slot target" resetKey={key}>
              <SlotTargetBlock elementKey={key} pageId={currentPageId} />
            </BlockErrorBoundary>
          )}

          {/* Blog Settings — files-truth (task-240): a UI over the page code. */}
          {isFilesTruthBlogSlot && (
            <ExpandableRow title="Blog Settings" className="mt-2" defaultExpanded>
              <BlockErrorBoundary blockName="Blog binding" resetKey={key}>
                <BlogBindingBlock binding={pageBlogBinding} collections={diskCollections} builtIn={builtIn} />
              </BlockErrorBoundary>
            </ExpandableRow>
          )}

          {isComponentViewRoot && (
            <BlockErrorBoundary blockName="Backdrop" resetKey={key}>
              <ComponentBackdropBlock file={localComponentViewFile} />
            </BlockErrorBoundary>
          )}

          {/* BlogCard field binding (task-240 Phase 2). */}
          {selectedCard && (
            <BlockErrorBoundary blockName="Card fields" resetKey={key}>
              <CardFieldsBlock file={selectedCard.file} collections={selectedCard.collections} conflict={selectedCard.conflict}
                allCollections={diskCollections} listingCollection={pageBlogBinding?.collection ?? undefined} />
            </BlockErrorBoundary>
          )}
          {cardField && (
            <BlockErrorBoundary blockName="Field binding" resetKey={key}>
              <FieldBindingBlock sourceLocation={cardField.loc} tagName={tagName!} mode={cardField.mode} collections={cardField.collections} listingCollection={pageBlogBinding?.collection ?? undefined} />
            </BlockErrorBoundary>
          )}

          {/* The doc-truth Blog Settings (Yjs blogSlotBindings) block is retired —
              task-240: a files-truth BlogSlot's settings are its page code (above). */}

          {/* Selected-element style stack (Position→Effects). Extracted to its
              own component (task-043); the bundle is recreated each render to
              match the old inline JSX's re-render semantics (ledger #17). */}
          <ElementDesignPanel design={elementDesign} />
            </>
          )}
        </>
      ) : activeTab === 'classes' ? (
        <ClassesTab
          key={key} // an unapplied draft belongs to the element it was typed for
          classes={fullClasses}
          onClassesChange={handleClassesTabChange}
        />
      ) : (
        <>
          {isDrawnElement && (
            <div className="px-3 py-2 text-xs text-text-muted italic">
              Drawn element — not in source
            </div>
          )}
          <SourceTab
            elementKey={key}
            sourceLocation={sourceLocation}
          />
        </>
      )}
      </div>
      )}
    </div>
    </DesignBarProvider>
    </GestureHostContext.Provider>
  );
};

export default DesignBar;
