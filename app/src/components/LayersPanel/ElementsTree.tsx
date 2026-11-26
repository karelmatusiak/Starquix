import { PenPathIcon as SharedPenPathIcon, SlotIcon as SharedSlotIcon } from '@/assets/icons';
// src/components/LayersPanel/ElementsTree.tsx
/**
 * ElementsTree Component
 *
 * Displays a hierarchical tree view of elements on the current page.
 * Supports drag-and-drop reordering at ALL levels (root + children).
 */

import { t } from '@/i18n';
import { selectOptionsFor } from '@/utils/selectOptions';
import { useState, useCallback, useEffect, useMemo, useRef, useContext, memo, useSyncExternalStore } from 'react';

import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { useDndContext } from '@dnd-kit/core';
import { useEditorDoc, useDispatch, useYjsValue, useScopedYjsValue, useCurrentPageId, useProjectId } from '@/store/hooks';
import { acceptEditorCommands } from '@/store/commandGesture';
import type { EditorCommand } from '@/store/types';
import { selectCurrentPageId, selectPageLayout, selectProjectId } from '@/store/selectors';
import toast from 'react-hot-toast';
import { isLocalProjectId } from '@/utils/localMode';
import {
  isSourceKeyedElementKey,
  moveLocalElement,
  planLocalReparentInsert,
} from '@/components/Editor/localStructuralOps';
import { pageLayoutElementId } from '@/store/layoutElement';
import { useLocalPageLayoutName } from '@/hooks/useLocalPageLayout';
import { slotNameForDropTarget, draggedElementId } from '@/utils/slotDrop';
import { isBlogSlotLabel, isSlotSelection } from '@/utils/slotDetection';
import { isLayoutChromeChildKey, isLayoutChromeKey } from '@/utils/layoutChromeKeys';
import {
  buildMasterEntityKeys,
  collectBlogSlotInstanceIds,
  collectComponentInstanceIds,
  collectPostRootKeys,
  findContainingSlotKey,
  readBlogCardComponentName,
} from '@/store/masterEntity';
import { BLOG_CARD_COMPONENT_NAME } from '@/core/collections/types';
import { useScannedElementsRef, useScannedElements, useSelectionContext } from '@/context/SelectionContext';
import { cardFieldAt, isCardTitleElement, useCardTitleLockVersion } from '@/utils/cardTitleLock';
import { useUndoContext } from '@/context/UndoContext';
import { buildTreeFromScannedElements, deriveLocalLayout, findLocalLayoutBodyRoot, findNode, flattenVisibleKeys, liftLayoutBodyForComponentView, type TreeNode } from '@/utils/treeUtils';
import { canJoinMultiSelection, computeVisibleRange } from '@/store/multiSelect';
import { dispatchSetChildOrder, isValidChildOrderParentKey } from '@/utils/dispatchSetChildOrder';
import { DRAG_TYPES } from '@/types/drag';
import { CONTAINER_TAGS, type DropPosition } from '@/store/planLayersDrop';
import { subscribeDropZone, getDropZoneSnapshot } from './dropZoneStore';
import { Row } from '@/components/ui';
import { Tooltip } from '@/components/ui';
import { resolveLayerLabel, localComponentRootName, localComponentRootFile } from './resolveLabel';
import type { DynamicComponentIndex } from '@/store/folderManifest';
import { useLocalProjectPath } from '@/hooks/useLocalProjectPath';
import { lockedKeyPredicate } from '@/components/DesignBar/lockTier';
import { resolveCloneRedirect } from './resolveCloneRedirect';
import { layerMenu, type MenuPoint } from '@/components/Editor/layerMenuStore';
import { useAI } from '@/ai/AIContext';
import { useTool } from '@/context';

import {
  ComponentIcon,
  LayerTextIcon as TextIcon,
  LayerImageIcon as ImageIcon,
  LayerLinkIcon as LinkIcon,
  SparkleIcon,
  LockIcon,
} from '@/assets/icons';
import { ContainerLayoutIcon } from './ContainerLayoutIcon';
import type { ContainerLayout } from '@/bridge/types';
import { stableContext } from '@/utils/stableContext';

const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'text', 'heading', 'subheading', 'label', 'time', 'small', 'strong', 'em', 'b', 'i', 'u', 'q', 'cite', 'abbr', 'code', 'kbd', 'samp', 'var', 'mark', 'sub', 'sup', 'blockquote']);
const IMAGE_TAGS = new Set(['img', 'image', 'picture', 'svg', 'video']);
const LINK_TAGS = new Set(['a', 'link', 'button']);

function PenShapeIcon({ className }: { className?: string }) {
  return (
    <SharedPenPathIcon className={className} />
  );
}

function SlotIcon({ className }: { className?: string }) {
  return (
    <SharedSlotIcon className={className} />
  );
}

function getElementIcon(
  tagName: string,
  isSelected: boolean,
  isComponent: boolean,
  componentColorClass: string,
  layout?: ContainerLayout,
): React.ReactNode {
  const iconClass = `w-4 h-4 ${
    componentColorClass || (isSelected ? 'text-text-muted' : '')
  }`;
  const tag = tagName.toLowerCase();

  // Component instances (Yjs componentType, master entity, or drawn-slot
  // first child) get the component icon regardless of their underlying HTML
  // tag — otherwise a Hero whose root is <section> reads as a frame and a
  // CTA whose root is <a> reads as a link, contradicting the label.
  if (isComponent) return <ComponentIcon className={iconClass} />;
  if (tag === 'shape') return <PenShapeIcon className={iconClass} />;
  if (tag === 'slot' || tag.startsWith('slot:') || tag.startsWith('slot ') || isBlogSlotLabel(tag)) return <SlotIcon className={iconClass} />;
  if (TEXT_TAGS.has(tag)) return <TextIcon className={iconClass} />;
  if (IMAGE_TAGS.has(tag)) return <ImageIcon className={iconClass} />;
  if (LINK_TAGS.has(tag)) return <LinkIcon className={iconClass} />;
  return <ContainerLayoutIcon layout={layout} className={iconClass} />;
}

function hasBlogDescendant(node: TreeNode): boolean {
  for (const child of node.children) {
    if (isBlogSlotLabel(child.tagName)) return true;
    if (hasBlogDescendant(child)) return true;
  }
  return false;
}

const DROP_INDICATOR_SHADOW = '0 0 6px var(--color-accent-strong)';

function TreeDropIndicator({ position }: { position: 'above' | 'below' }) {
  return (
    <div
      className="absolute left-0 right-0 h-0.5 bg-accent-strong rounded-full mx-2 pointer-events-none z-10"
      style={{
        boxShadow: DROP_INDICATOR_SHADOW,
        top: position === 'above' ? 0 : 'auto',
        bottom: position === 'below' ? 0 : 'auto',
      }}
      data-testid="tree-drop-indicator"
    />
  );
}

type DropFeedback =
  | { kind: 'none' }
  | { kind: 'above' }
  | { kind: 'below' }
  | { kind: 'inside' };

const DROP_NONE: DropFeedback = { kind: 'none' };

/**
 * Determines which drop indicator to show for a node being dragged over.
 * Separated from the component to keep JSX focused on rendering.
 */
/** True when `key` is anywhere in `node`'s subtree (cycle guard for the indicator). */
function nodeSubtreeContains(node: TreeNode | undefined, key: string): boolean {
  if (!node?.children) return false;
  for (const child of node.children) {
    if (child.key === key) return true;
    if (nodeSubtreeContains(child, key)) return true;
  }
  return false;
}

/**
 * The indicator for the row under the pointer, driven by the LIVE drop ZONE
 * (before/inside/after). MUST mirror planLayersDrop's zone resolution so the line
 * the user sees is exactly what the drop does: a container's middle band → inside
 * ring; its edges (and any leaf) → above/below line; root rows included.
 */
function computeDropFeedback(
  active: ReturnType<typeof useDndContext>['active'],
  overId: string | undefined,
  nodeKey: string,
  isContainer: boolean,
  zone: DropPosition | null,
): DropFeedback {
  if (!active || overId !== nodeKey || active.id === nodeKey) return DROP_NONE;
  if (active.data.current?.type !== DRAG_TYPES.LAYERS_PANEL) return DROP_NONE;

  // Cycle: hovering a descendant of the dragged element is not a valid drop.
  const activeNode = active.data.current?.node as TreeNode | undefined;
  if (activeNode && nodeSubtreeContains(activeNode, nodeKey)) return DROP_NONE;

  const activeParentKey = active.data.current?.parentKey ?? null;
  let z: DropPosition = zone ?? 'inside';
  if (z === 'inside' && !isContainer) z = 'after'; // a leaf can't contain

  if (z === 'inside') {
    return activeParentKey === nodeKey ? DROP_NONE : { kind: 'inside' };
  }
  return z === 'before' ? { kind: 'above' } : { kind: 'below' };
}

// Tree-wide state shared across every SortableNode. Lives in a context so the
// recursive renderer doesn't drill 9+ identical props through every level, and
// so child rows only re-render when something they actually consume changes.
/** Click-time modifier flags — drives the Phase-1 multi-select gestures. */
export interface SelectModifiers {
  /** Cmd/Ctrl held: toggle membership in the extension set. */
  toggle: boolean;
  /** Shift held: select the contiguous sibling range from the anchor. */
  range: boolean;
}

interface TreeContextValue {
  expandedNodes: Set<string>;
  selectedKey: string | null;
  /** Keys of multi-selection EXTRAS (the primary stays in selectedKey). */
  multiSelectedKeys: Set<string>;
  /** Primary + extras when a multi-selection exists, else null. Member rows
   *  carry this in their sortable data so a drag moves the whole group. */
  groupKeys: string[] | null;
  showChevrons: boolean;
  aiActiveKeys: Set<string>;
  aiTouchedKeys: Set<string>;
  motherEntityKeys: Set<string>;
  blogSlotKeys: Set<string>;
  postRootKeys: Set<string>;
  postRootLabels: Record<string, string>;
  componentTypeById: Record<string, string>;
  /** Element ids carrying a penPath (pen tool, shape tools, converted svgs) — rendered as "shape". */
  penShapeIds: Record<string, true>;
  /** Library-derived dynamic subset (ONE predicate: isDynamicComponent) —
   *  rows joining it by name/path wear the yellow dynamic accent. */
  dynamicComponentIndex: DynamicComponentIndex;
  baseDepth: number;
  /** task-142 component editor: the viewed component's own file — its rows
   *  are internals (plain), never renamed to the component (null elsewhere). */
  viewedComponentFile: string | null;
  onToggleExpand: (key: string) => void;
  onSelect: (key: string, elementId: string, modifiers?: SelectModifiers) => void;
  /** Select a synthetic (layout/slot) node by its UI-only key — no Yjs element lookup. */
  onDoubleClick: (node: TreeNode) => void;
  /** Right-click: select the row unless it is already a member, then open the layer menu. */
  onContextMenu: (key: string, elementId: string, point: MenuPoint) => void;
}

const TreeContext = stableContext<TreeContextValue | null>('TreeContext', null);

function useTreeContext(): TreeContextValue {
  const ctx = useContext(TreeContext);
  if (!ctx) throw new Error('SortableNode rendered outside <TreeContext.Provider>');
  return ctx;
}

interface SortableNodeProps {
  node: TreeNode;
  index: number;
  siblingKeys: string[];
  parentKey: string | null;
}

const SortableNode = memo(function SortableNode({
  node,
  index,
  siblingKeys,
  parentKey,
}: SortableNodeProps) {
  const {
    expandedNodes,
    selectedKey,
    multiSelectedKeys,
    groupKeys,
    showChevrons,
    aiActiveKeys,
    aiTouchedKeys,
    motherEntityKeys,
    blogSlotKeys,
    postRootKeys,
    postRootLabels,
    componentTypeById,
    penShapeIds,
    dynamicComponentIndex,
    baseDepth,
    viewedComponentFile,
    onToggleExpand,
    onSelect,
    onDoubleClick,
    onContextMenu,
  } = useTreeContext();
  const { attributes, listeners, setNodeRef } = useSortable({
    id: node.key,
    animateLayoutChanges: () => false,
    data: {
      type: DRAG_TYPES.LAYERS_PANEL,
      node,
      parentKey,
      siblingKeys,
      // Only member rows carry the group — dragging a non-member stays single.
      groupKeys: groupKeys?.includes(node.key) ? groupKeys : undefined,
    },
  });

  const { active, over } = useDndContext();
  // Live drop zone for THIS row (before/inside/after) from the pointer — only the
  // hovered row's value changes, so re-renders stay confined to the tree.
  const dropZone = useSyncExternalStore(subscribeDropZone, getDropZoneSnapshot);
  const liveZone = dropZone.overKey === node.key ? dropZone.zone : null;

  const isMultiSelected = multiSelectedKeys.has(node.key);
  const isSelected = selectedKey === node.key || isMultiSelected;
  const isExpanded = expandedNodes.has(node.key);
  const hasChildren = node.children.length > 0;
  const isContainer = hasChildren || CONTAINER_TAGS.has(node.tagName.toLowerCase());
  const isMotherEntity = motherEntityKeys.has(node.key);
  // Pen/shape elements (incl. converted svgs) read as "shape", not "div".
  const isPenShape = !!penShapeIds[node.key];
  const { displayLabel, componentTypeLabel } = resolveLayerLabel({
    nodeKey: node.key,
    nodeElementId: node.elementId,
    nodeDisplayName: node.displayName,
    nodeTagName: node.tagName,
    nodeComponentName: node.componentName,
    componentTypeById,
    postRootKeys,
    postRootLabels,
    blogCardComponentName: BLOG_CARD_COMPONENT_NAME,
    // Layout CHROME rows are parts of the layout, labeled by their tag — the
    // layout's name already lives on the synthetic Layout node above them.
    // Without this exclusion every chrome row (slot container, drawn chrome)
    // relabeled as the layout name (caught live 2026-08-26).
    isMotherEntity: isMotherEntity && !isLayoutChromeKey(node.elementId),
  });
  // task-142 local mode: a source row whose file is a component/layout AND
  // whose parent row lives in a different file is that component's root —
  // purple + component name, like a WC instance root.
  const isLocalProjectTree = !!useLocalProjectPath();
  const localComponentName = isLocalProjectTree ? localComponentRootName(node.key, parentKey, viewedComponentFile) : null;
  // True when the row represents a component instance — Yjs componentType on
  // the instance root, a master entity, or the bridge marking it as the
  // first child of a filled drawn slot. Instance internals (tag children)
  // are NOT components and should render as plain HTML rows.
  const isComponent = !!componentTypeLabel || !!node.componentName || isMotherEntity || !!localComponentName;

  const isAIActive = aiActiveKeys.has(node.key) || aiActiveKeys.has(node.elementId);
  // A created element is recorded by its bare elementId; every descendant row
  // shares that elementId, so gate the elementId match to the SUBTREE ROOT
  // (parent belongs to a different instance) — one badge per AI-made section,
  // not one per child.
  const isSubtreeRoot = !parentKey || parentKey.split(':')[0] !== node.elementId;
  const isAITouched =
    !isAIActive && (aiTouchedKeys.has(node.key) || (isSubtreeRoot && aiTouchedKeys.has(node.elementId)));
  const isBlogSection = node.tagName.toLowerCase() === 'section' && hasBlogDescendant(node);
  // The post title can't be deleted from a card (utils/cardTitleLock) — say so with a lock.
  useCardTitleLockVersion();
  const keyLoc = node.key.match(/^(.+\.astro):(\d+):(\d+)/);
  const isLockedTitle = !!keyLoc && isCardTitleElement({ file: keyLoc[1], line: Number(keyLoc[2]), column: Number(keyLoc[3]) });

  const isBlogSlotEntity = blogSlotKeys.has(node.key);
  // A layout slot is a slot even when filled (rendered as a <div data-sq-slot>).
  const isSlotTag = isSlotSelection({ tagName: node.tagName, slotName: node.slotName });
  // Scanner-labeled blog slot rows ('Blog Slot' / 'Blog: X') — shares the
  // predicate getElementIcon uses, so color can't drift from the icon.
  const isBlogSlotTag = isBlogSlotLabel(node.tagName);
  // Dynamic identity — blog-slot entities, plus any INSTANCE ROOT that joins
  // the library's dynamic subset (ONE predicate: isDynamicComponent) by
  // componentType name (WC Yjs), scanner componentName, or local-mode root
  // file path. Root-gated inputs only, so instance internals stay plain.
  const localComponentFile = isLocalProjectTree ? localComponentRootFile(node.key, parentKey, viewedComponentFile) : null;
  const isDynamicRow = isBlogSlotEntity
    || (!!componentTypeLabel && dynamicComponentIndex.names.has(componentTypeLabel))
    || (!!node.componentName && dynamicComponentIndex.names.has(node.componentName))
    || (!!localComponentFile && dynamicComponentIndex.paths.has(localComponentFile))
    // A mother-entity row is its INSTANCE's rendered root (one row per
    // instance), so the instance's componentType classifies it even though
    // the key carries a tag suffix — e.g. the BlogPost master's `<layout>`
    // wrapper row joins as BlogPost.
    || (isMotherEntity && dynamicComponentIndex.names.has(componentTypeById[node.elementId] ?? ''))
    // Rows LABELED with a dynamic component's (lowercased) name — layout
    // wrappers/chrome display lowercased names. Gated on isComponent so
    // plain tag rows never join by accident — and OFF whenever the row's
    // FILE is known: a components/Main.astro row must stay purple even when
    // a layouts/Main.astro shares the name (path is authoritative; the
    // name fallback painted the component yellow — owner report 2026-08-24).
    || (isComponent && !localComponentFile && dynamicComponentIndex.namesLower.has((localComponentName ?? displayLabel).toLowerCase()));
  // Identity color — applied to the row's own icon AND label (not its
  // descendants'), matching Assets rows and the DesignBar caption: yellow
  // dynamic, cyan slot, purple component, neutral plain element.
  const iconColorClass = isDynamicRow
    ? 'text-dynamic'
    : isSlotTag || isBlogSlotTag
      ? 'text-slot'
      : isComponent
        ? 'text-stroke-component'
        : '';

  const feedback = computeDropFeedback(
    active,
    over?.id as string | undefined,
    node.key,
    isContainer,
    liveZone,
  );

  const handleClick = useCallback((e: React.MouseEvent) => {
    onSelect(node.key, node.elementId, {
      toggle: e.metaKey || e.ctrlKey,
      range: e.shiftKey,
    });
  }, [onSelect, node.key, node.elementId]);

  const handleDoubleClickLocal = useCallback(() => {
    onDoubleClick(node);
  }, [onDoubleClick, node]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenu(node.key, node.elementId, { x: e.clientX, y: e.clientY });
  }, [onContextMenu, node.key, node.elementId]);

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleExpand(node.key);
    },
    [onToggleExpand, node.key],
  );

  const childKeys = useMemo(() => node.children.map(c => c.key), [node.children]);

  const rowClassName = feedback.kind === 'inside'
    ? 'h-7 px-2 rounded gap-1 cursor-default ring-1 ring-accent-strong ring-inset rounded-sm'
    : 'h-7 px-2 rounded gap-1 cursor-default';

  return (
    <>
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        className="relative"
        data-layer-key={node.key}
      >
        {feedback.kind === 'above' && <TreeDropIndicator position="above" />}
        {feedback.kind === 'below' && <TreeDropIndicator position="below" />}

        <Row
          rowProps={{
            'data-testid': 'layer-item',
            'data-element-id': node.elementId,
            'data-multi-selected': isMultiSelected || undefined,
          }}
          depth={node.depth + baseDepth}
          selected={isSelected}
          left={[
            {
              type: 'chevron',
              expanded: isExpanded,
              visible: (showChevrons || isExpanded) && hasChildren,
              onToggle: handleToggle,
            },
            {
              type: 'icon',
              iconSize: 16,
              icon: getElementIcon(isPenShape ? 'shape' : isSlotTag ? 'slot' : node.tagName, isSelected, isComponent, iconColorClass, node.layout),
            },
          ]}
          title={
            <span className="flex items-center gap-1 font-normal">
              <span className={`flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs${iconColorClass ? ` ${iconColorClass}` : ''}`}>
                {isPenShape ? 'shape' : (localComponentName ?? displayLabel)}
              </span>
              {isBlogSection && (
                <span className="text-3xs leading-none text-text-secondary px-1 py-0.5 rounded bg-bg-hover shrink-0">
                  Blog
                </span>
              )}
              {isAIActive && (
                <Tooltip content="AI is editing this">
                  <SparkleIcon data-ai-badge="active" className="w-4 h-4 text-text-secondary animate-pulse shrink-0" />
                </Tooltip>
              )}
              {isLockedTitle && (
                <Tooltip content="Blog title cannot be deleted">
                  <LockIcon data-title-lock aria-label="Blog title cannot be deleted" className="w-4 h-4 text-text-secondary shrink-0" />
                </Tooltip>
              )}
              {isAITouched && (
                <Tooltip content="Edited by AI">
                  <SparkleIcon data-ai-badge="touched" className="w-4 h-4 text-text-secondary shrink-0" />
                </Tooltip>
              )}
            </span>
          }
          className={rowClassName}
          onClick={handleClick}
          onDoubleClick={handleDoubleClickLocal}
          onContextMenu={handleContextMenu}
        />
      </div>

      {hasChildren && isExpanded && (
        <SortableContext items={childKeys} strategy={verticalListSortingStrategy}>
          {node.children.map((child, idx) => (
            <SortableNode
              key={child.key}
              node={child}
              index={idx}
              siblingKeys={childKeys}
              parentKey={node.key}
            />
          ))}
        </SortableContext>
      )}
    </>
  );
});

/** Increase every node's depth by `by` (in place) — used when wrapping the
 *  scanned roots under the Layout node so they indent beneath it. */
function shiftTreeDepth(nodes: TreeNode[], by: number): void {
  for (const n of nodes) {
    n.depth += by;
    shiftTreeDepth(n.children, by);
  }
}

/**
 * The page's Layout node: a single, real-keyed (layoutchrome-<pageId>) node at the
 * TOP of the Layers tree that wraps the scanned chrome/content. The Layout has no
 * DOM element, so it is NOT draggable and selects by its key directly (handleSelect
 * routes a no-scanned-element layout-root key to select(key) → DesignBar layout
 * controls). Its real chrome/content children stay sortable in their own context.
 */
const LayoutRootNode = memo(function LayoutRootNode({ node }: { node: TreeNode }) {
  const ctx = useTreeContext();
  const { selectedKey, showChevrons, baseDepth, onSelect, dynamicComponentIndex } = ctx;
  // Layouts are dynamic (category Layouts) — same identity rule as every row.
  const identityClass = dynamicComponentIndex.names.has(node.displayName)
    ? 'text-dynamic'
    : 'text-stroke-component';
  const [isExpanded, setIsExpanded] = useState(true);

  const isSelected = selectedKey === node.key;
  const hasChildren = node.children.length > 0;
  const childKeys = useMemo(() => node.children.map((c) => c.key), [node.children]);

  const handleClick = useCallback(() => {
    onSelect(node.key, node.elementId);
  }, [onSelect, node.key, node.elementId]);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsExpanded((v) => !v);
  }, []);

  return (
    <>
      <div className="relative" data-layer-key={node.key} data-element-id={node.elementId}>
        <Row
          rowProps={{
            'data-testid': 'layer-item',
            'data-element-id': node.elementId,
          }}
          depth={node.depth + baseDepth}
          selected={isSelected}
          left={[
            {
              type: 'chevron',
              expanded: isExpanded,
              visible: (showChevrons || isExpanded) && hasChildren,
              onToggle: handleToggle,
            },
            {
              type: 'icon',
              iconSize: 16,
              icon: getElementIcon(node.tagName, isSelected, false, identityClass, node.layout),
            },
          ]}
          title={
            <span className="flex items-center gap-1 font-normal">
              <span className={`flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs ${identityClass}`}>
                {node.displayName}
              </span>
            </span>
          }
          className="h-7 px-2 rounded gap-1 cursor-default"
          onClick={handleClick}
        />
      </div>

      {hasChildren && isExpanded && (
        <SortableContext items={childKeys} strategy={verticalListSortingStrategy}>
          {node.children.map((child, idx) => (
            <SortableNode
              key={child.key}
              node={child}
              index={idx}
              siblingKeys={childKeys}
              parentKey={node.key}
            />
          ))}
        </SortableContext>
      )}
    </>
  );
});

interface FlatNode {
  key: string;
  elementId: string;
  parentKey: string | null;
  index: number;
}

function flattenTree(nodes: TreeNode[], parentKey: string | null): FlatNode[] {
  const result: FlatNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    result.push({ key: node.key, elementId: node.elementId, parentKey, index: i });
    if (node.children.length > 0) {
      result.push(...flattenTree(node.children, node.key));
    }
  }
  return result;
}

/**
 * Find the closest tree row to the cursor and whether the cursor is
 * above or below its vertical midpoint.
 */
function findClosestRow(
  rows: NodeListOf<Element>,
  clientY: number,
): { row: Element; insertAbove: boolean } | null {
  let closestRow: Element | null = null;
  let closestDist = Infinity;
  let insertAbove = false;

  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const dist = Math.abs(clientY - midY);
    if (dist < closestDist) {
      closestDist = dist;
      closestRow = row;
      insertAbove = clientY < midY;
    }
  }

  if (!closestRow) return null;
  return { row: closestRow, insertAbove };
}

interface ReparentDropZoneProps {
  nodes: TreeNode[];
  onDrop: (newParentKey: string | null, insertIndex: number) => void;
}

function ReparentDropZone({ nodes, onDrop }: ReparentDropZoneProps) {
  const [indicatorY, setIndicatorY] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ parentKey: string | null; insertIndex: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const flatNodes = useMemo(() => flattenTree(nodes, null), [nodes]);

  // Build a lookup from elementId to flat node for direct matching
  const flatNodesByElementId = useMemo(() => {
    const map = new Map<string, FlatNode>();
    for (const node of flatNodes) {
      // First match wins (preserves tree order)
      if (!map.has(node.elementId)) {
        map.set(node.elementId, node);
      }
    }
    return map;
  }, [flatNodes]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const rows = overlay.parentElement?.querySelectorAll('[data-testid="layer-item"]');
    if (!rows) return;

    const hit = findClosestRow(rows, e.clientY);
    if (!hit) {
      setIndicatorY(null);
      setDropTarget(null);
      return;
    }

    const { row, insertAbove } = hit;
    const rect = row.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    setIndicatorY(insertAbove ? rect.top - overlayRect.top : rect.bottom - overlayRect.top);

    const elementId = row.getAttribute('data-element-id');
    if (!elementId) {
      setDropTarget(null);
      return;
    }

    const match = flatNodesByElementId.get(elementId);
    if (!match) {
      setDropTarget(null);
      return;
    }

    setDropTarget({
      parentKey: match.parentKey,
      insertIndex: insertAbove ? match.index : match.index + 1,
    });
  }, [flatNodesByElementId]);

  const handleMouseUp = useCallback(() => {
    if (dropTarget) {
      onDrop(dropTarget.parentKey, dropTarget.insertIndex);
    }
  }, [dropTarget, onDrop]);

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-50 cursor-crosshair"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {indicatorY !== null && (
        <div
          className="absolute left-0 right-0 h-0.5 bg-accent-strong rounded-full mx-2 pointer-events-none"
          style={{
            top: indicatorY,
            boxShadow: DROP_INDICATOR_SHADOW,
          }}
        />
      )}
    </div>
  );
}

/** Rows join it by name/path for the yellow accent; parents that already hold
 *  the component library pass buildDynamicComponentIndex(...) — no second
 *  scan fetch here (see MediaBlock's no-extra-mount precedent). */
const EMPTY_DYNAMIC_INDEX: DynamicComponentIndex = { names: new Set(), namesLower: new Set(), paths: new Set() };

export function ElementsTree({ baseDepth = 0, viewedComponentFile = null, dynamicIndex = EMPTY_DYNAMIC_INDEX }: { baseDepth?: number; viewedComponentFile?: string | null; dynamicIndex?: DynamicComponentIndex } = {}) {
  const dispatch = useDispatch();
  const { scannedByKeyRef } = useScannedElementsRef();
  const { scannedElements, scannedByKey, expandedNodes, toggleExpand, expandNodes } = useScannedElements();
  const {
    selectedKey,
    select,
    enterContext,
    reparentDragKey,
    setReparentDragKey,
    additionalSelections,
    addAdditionalSelection,
    clearAdditionalSelections,
    toggleInSelection,
  } = useSelectionContext();
  const { takeSnapshot, claimSnapshot, pushStructuralUndo } = useUndoContext();
  const doc = useEditorDoc();
  const currentPageId = useCurrentPageId();
  const projectId = useProjectId();
  const { activeKeys, recentlyTouchedKeys } = useAI();
  const { activeTool } = useTool();
  const aiActiveSet = useMemo(() => new Set(activeKeys), [activeKeys]);
  const aiTouchedSet = useMemo(() => new Set(recentlyTouchedKeys), [recentlyTouchedKeys]);

  // Component markers only (not every staticMarkup carrier) — an AI-added
  // plain frame must not render the purple component accent in Layers.
  const motherEntityKeyList = useScopedYjsValue<string[]>(collectComponentInstanceIds, [{ map: 'elements' }]);
  const blogSlotKeyList = useScopedYjsValue<string[]>(collectBlogSlotInstanceIds, [{ map: 'elements' }]);

  const blogSlotKeys = useMemo(
    () => buildMasterEntityKeys(blogSlotKeyList, scannedElements),
    [blogSlotKeyList, scannedElements],
  );

  const postRootKeys = useMemo(
    () => collectPostRootKeys(scannedElements, scannedByKey),
    [scannedElements, scannedByKey],
  );

  const motherEntityKeys = useMemo(() => {
    const merged = buildMasterEntityKeys(motherEntityKeyList, scannedElements);
    for (const k of postRootKeys) merged.add(k);
    return merged;
  }, [motherEntityKeyList, scannedElements, postRootKeys]);

  const postRootSlotKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const rootKey of postRootKeys) {
      const slotKey = findContainingSlotKey(rootKey, scannedByKey, motherEntityKeys);
      if (slotKey) map.set(rootKey, slotKey);
    }
    return map;
  }, [postRootKeys, scannedByKey, motherEntityKeys]);

  const postRootLabels = useScopedYjsValue<Record<string, string>>((doc) => {
    const out: Record<string, string> = {};
    postRootSlotKey.forEach((slotKey, rootKey) => {
      out[rootKey] = readBlogCardComponentName(doc, slotKey);
    });
    return out;
  }, [{ map: 'elements' }]);

  // One pass over the current page's Yjs elements builds both per-row lookup
  // maps: componentType (display "BlogSlot", not "section") and penPath
  // membership (display "shape", not "div") — pen tool, shape tools,
  // converted svgs.
  const { componentTypeById, penShapeIds } = useScopedYjsValue<{
    componentTypeById: Record<string, string>;
    penShapeIds: Record<string, true>;
  }>((doc) => {
    const out: { componentTypeById: Record<string, string>; penShapeIds: Record<string, true> } = {
      componentTypeById: {},
      penShapeIds: {},
    };
    if (!currentPageId) return out;
    doc.getMap('elements').forEach((value, id) => {
      const yEl = value as import('yjs').Map<unknown>;
      if ((yEl.get('pageId') as string) !== currentPageId) return;
      const type = yEl.get('componentType') as string | undefined;
      if (type) out.componentTypeById[id] = type;
      if (yEl.get('penPath')) out.penShapeIds[id] = true;
    });
    return out;
  }, [{ map: 'elements' }]);

  const [isTreeHovered, setIsTreeHovered] = useState(false);

  // Auto-scroll to selected element in the tree when selection changes (e.g. canvas click)
  useEffect(() => {
    if (!selectedKey) return;

    // Wait for DOM to update (ancestors may have just been expanded)
    const rafId = requestAnimationFrame(() => {
      const el = document.querySelector(`[data-layer-key="${CSS.escape(selectedKey)}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(rafId);
  }, [selectedKey]);

  // The page's applied layout (if any). The Layout is a REAL selectable entity —
  // the layout-chrome instance root keyed layoutchrome-<pageId> — with no DOM node
  // of its own. We surface it as a single node at the TOP of the tree so the
  // Layout ▸ slot ▸ content hierarchy is selectable from Layers (not just canvas).
  const { layoutName } = useScopedYjsValue((doc) => selectPageLayout(doc, currentPageId ?? ''), [{ map: 'pages', keys: currentPageId ? [currentPageId] : [] }]);
  const layoutRootKey = currentPageId ? pageLayoutElementId(currentPageId) : null;
  // Local mode (files-truth) backstop: the layout lives in the page FILE, never
  // the doc. The scan derivation below covers layouts whose own tags render
  // (their <body> is scanned) — but a pure-slot fragment layout contributes
  // nothing scannable, and an apply/undo of applyLocalPageLayout must still
  // reflect in the tree (round-2 S3/S4/S5 finding). Detect the wrapper from
  // the file bytes on every scan arrival as the last-resort name source.
  const localLayoutName = useLocalPageLayoutName();

  // Local mode has no doc layoutName — the user's own layout FILE wraps the page
  // and Astro inlines it, so the wrapper identity only survives in the scan
  // (sourceLocation/usageLocation pointing at src/layouts/*). Derive it back so
  // the tree shows the nesting the page file authors (<Main>…</Main>).
  const localProjectPath = useLocalProjectPath();
  const localLayout = useMemo(
    () => (localProjectPath ? deriveLocalLayout(scannedElements) : null),
    [localProjectPath, scannedElements],
  );

  // Layout-element paradigm (2026-08-24): when the bridge scanned the layout's
  // own <body>, that row IS the Layout node — real key, real selection, real
  // DesignBar. No synthetic node is minted then; the synthetic fallback below
  // stays only for fragment layouts (no <body> of their own).
  const layoutBodyRoot = useMemo(
    () => (localProjectPath ? findLocalLayoutBodyRoot(scannedElements) : null),
    [localProjectPath, scannedElements],
  );

  // The Layers tree is built straight from the iframe scan (chrome is scanned via
  // data-sq-chrome, so slot ▸ content nests automatically via parentKey). When a
  // layout is applied and its chrome is present, wrap the scanned roots under the
  // Layout node so the Layout itself is selectable (real key, NOT synthetic).
  // Local mode reuses the SAME node/key for the file-derived layout.
  // Card elements are named by the field they show ("image", "title"), so a
  // row reads like the Fields panel and the canvas (owner 2026-10-11).
  const cardVersion = useCardTitleLockVersion();
  const nodes = useMemo(() => {
    const base = buildTreeFromScannedElements(scannedElements, (el) => (el.sourceLocation ? cardFieldAt(el.sourceLocation) : null));
    // The scanned body row is the Layout node — label it and skip the
    // synthetic wrapper entirely.
    if (layoutBodyRoot) {
      const lifted = liftLayoutBodyForComponentView(
        base, layoutBodyRoot.key, layoutBodyRoot.sourceLocation?.file, viewedComponentFile,
      );
      if (lifted) return lifted;
      const bodyNode = base.find((n) => n.key === layoutBodyRoot.key);
      if (bodyNode) bodyNode.displayName = localLayout?.name ?? 'Layout';
      return base;
    }
    if (!layoutRootKey) return base;
    // Name precedence: doc (WC/server) → scan derivation (local) → file-bytes
    // detection (local backstop for layouts that contribute nothing scannable).
    const wrapName = layoutName ?? localLayout?.name ?? localLayoutName;
    if (!wrapName) return base;
    if (layoutName) {
      const hasChrome = scannedElements.some((el) => isLayoutChromeChildKey(el.key, layoutRootKey));
      if (!hasChrome) return base;
    }
    // Children render one level deeper under the Layout node.
    shiftTreeDepth(base, 1);
    const layoutNode: TreeNode = {
      key: layoutRootKey,
      displayName: wrapName,
      tagName: 'layout',
      elementId: layoutRootKey,
      children: base,
      depth: 0,
    };
    return [layoutNode];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cardVersion: card sources re-read
  }, [scannedElements, layoutRootKey, layoutName, localLayout, layoutBodyRoot, localLayoutName, viewedComponentFile, cardVersion]);

  // The local synthetic fallback node isn't a scanned root, so the initial-load
  // auto-expand never covers it — expand it once minted, or the tree shows a
  // lone collapsed layout row hiding the page content (round-2/3 blind-judge
  // finding). Scanned body rows and the WC chrome path need no help.
  // Read the memo's ACTUAL output instead of re-deriving the same decision a
  // second (and subtly different) way: layoutRootKey is synthetic, so only the
  // minted Layout node can ever be the root carrying it.
  const mintedSyntheticLayout = !layoutName && !layoutBodyRoot && nodes[0]?.key === layoutRootKey;
  useEffect(() => {
    if (mintedSyntheticLayout && layoutRootKey) expandNodes([layoutRootKey]);
  }, [mintedSyntheticLayout, layoutRootKey, expandNodes]);

  // ReparentDropZone consumes the same tree.
  const baseNodes = nodes;

  // dnd-kit top-level items: every draggable root. The Layout node itself is NOT
  // draggable (it has no DOM element / page position), so exclude it.
  // ONE spelling of "the Layout row's key": the scanned body when present,
  // else the synthetic node. Mutually exclusive by construction (the nodes
  // memo above returns early with the body row and never mints the synthetic).
  const layoutNodeKey = layoutBodyRoot?.key ?? layoutRootKey;

  const rootNodeIds = useMemo(
    () => nodes.filter((n) => n.key !== layoutNodeKey).map((n) => n.key),
    [nodes, layoutNodeKey],
  );

  // Force SortableContext remount when items change to reset dnd-kit internal state.
  // This fixes a bug where drag stops working after the first successful reorder.
  const [sortableVersion, setSortableVersion] = useState(0);
  const itemsSignature = rootNodeIds.join(',');

  useEffect(() => {
    const timeout = setTimeout(() => {
      setSortableVersion(v => v + 1);
    }, 100);
    return () => clearTimeout(timeout);
  }, [itemsSignature]);

  const handleSelect = useCallback(
    (clickedKey: string, clickedElementId: string, modifiers?: SelectModifiers) => {
      // Redirect clone clicks to the real first card — see resolveCloneRedirect.
      const redirectKey = resolveCloneRedirect({ clickedKey, scannedElements });
      const key = redirectKey ?? clickedKey;
      const elementId = redirectKey ? redirectKey.split(':')[0] : clickedElementId;
      const element = scannedByKeyRef.current.get(key);

      // Multi-select: Cmd/Ctrl toggles membership, Shift selects the
      // range. Extras live ONLY in SelectionContext (never Yjs meta);
      // membership is policy-gated (store/multiSelect.ts — any layer,
      // chrome/wrapper excluded). AI tool keeps its existing click semantics.
      const anchor = selectedKey;
      const wantsMulti = !!modifiers && (modifiers.toggle || modifiers.range)
        && activeTool !== 'ai' && !!anchor;
      if (wantsMulti && anchor) {
        if (modifiers.range) {
          const visibleKeys = flattenVisibleKeys(nodes, expandedNodes);
          const range = computeVisibleRange(anchor, key, visibleKeys);
          if (range) {
            clearAdditionalSelections();
            for (const k of range) {
              if (k === anchor) continue;
              if (!canJoinMultiSelection(k, anchor)) continue; // chrome rows skipped silently
              addAdditionalSelection({ key: k, elementId: findNode(k, nodes)?.elementId ?? null });
            }
            return;
          }
          // Range can't be computed (anchor not visible) — fall through to
          // the plain single-select below.
        } else {
          // ⌘/Ctrl-click: the SAME rule as canvas Shift+click (SelectionContext.toggleInSelection
          // → store/multiSelect.ts decideToggle). A policy-rejected candidate is a no-op.
          const decision = toggleInSelection(key, {
            elementId: elementId ?? null,
            isLocked: lockedKeyPredicate(scannedByKeyRef.current, !!localProjectPath),
          });
          if (decision !== 'select') return;
          // 'select': the primary can't anchor a group → plain select below.
        }
      }

      // The Layout root node has no scanned/DOM element — select its real key
      // directly so the DesignBar's layout controls (PageLayoutBlock + Push/Reset/↻)
      // light up. Mirrors the canvas select-layout path.
      if (!element && key === layoutRootKey) {
        select(key);
        return;
      }

      if (element) {
        select(key, selectOptionsFor(element));

        if (activeTool === 'ai' && modifiers?.toggle) {
          window.dispatchEvent(new CustomEvent('sq:add-ai-context', {
            detail: { key, tagName: element.tagName, classes: element.classes },
          }));
          // Async fetch section HTML from iframe to enrich the context chip
          window.dispatchEvent(new CustomEvent('sq:fetch-element-html', { detail: { key } }));
        }
      }
    },
    [
      scannedByKeyRef, select, activeTool, layoutRootKey,
      selectedKey, nodes, expandedNodes, localProjectPath,
      addAdditionalSelection, clearAdditionalSelections, toggleInSelection,
    ],
  );

  const handleDoubleClick = useCallback(
    (node: TreeNode) => {
      if (node.children.length === 0) return;

      enterContext(node.key);

      const firstChild = node.children[0];
      const element = scannedByKeyRef.current.get(firstChild.key);
      if (element) {
        select(firstChild.key, selectOptionsFor(element));
      }
    },
    [scannedByKeyRef, select, enterContext],
  );

  const handleReparentDrop = useCallback(
    async (newParentKey: string | null, insertIndex: number) => {
      try {
      if (!reparentDragKey || !currentPageId) return;

      // task-148 (gap: iframe-exit drag onto Layers): local runtime + source-
      // keyed element — it has NO doc node, so the doc REPARENT_ELEMENT below
      // would only drift the session doc + DOM until the next HMR reload (and
      // push a phantom snapshot undo entry). Route through the SAME structural
      // writeMove the Layers-row drag uses (moveLocalElement); the drop slot
      // becomes a before/after anchor among the new parent's children
      // (planLocalReparentInsert). No DOM touch here — on success the write's
      // HMR reload renders the new position. (The slot branch below is
      // unreachable in local mode: no layout masters → layoutRootKey null.)
      if (isLocalProjectId(projectId ?? '') && isSourceKeyedElementKey(reparentDragKey)) {
        setReparentDragKey(null);
        const childKeys = scannedElements
          .filter((el) => el.parentKey === newParentKey)
          .map((el) => el.key);
        const plan = planLocalReparentInsert(newParentKey, childKeys, insertIndex, reparentDragKey);
        if (plan) {
          void moveLocalElement({
            key: reparentDragKey,
            targetKey: plan.targetKey,
            position: plan.position,
            pushUndo: pushStructuralUndo,
            scannedByKey,
          });
        }
        return;
      }

      // Slot boundary: dropping a content root onto a layout slot re-homes it via
      // SET_ELEMENT_SLOT_NAME (flat storage) — NOT a reparent. Storage stays flat
      // (parentId null); slotName decides membership and the render re-splices.
      const slotName = slotNameForDropTarget(newParentKey, scannedElements, layoutRootKey);
      if (slotName !== null) {
        takeSnapshot();
        await dispatch({ type: 'SET_ELEMENT_SLOT_NAME', elementId: draggedElementId(reparentDragKey), slotName });
        setReparentDragKey(null);
        return;
      }

      // Persist current child order before snapshot so undo can restore original position.
      const actions: EditorCommand[] = [];
      const reparentedEl = scannedElements.find(el => el.key === reparentDragKey);
      if (reparentedEl && isValidChildOrderParentKey(reparentedEl.parentKey)) {
        const siblings = scannedElements.filter(el => el.parentKey === reparentedEl.parentKey);
        dispatchSetChildOrder(
          action => { actions.push(action); return true; }, scannedElements, currentPageId, reparentedEl.parentKey,
          siblings.map(el => el.key),
        );
      }

      takeSnapshot();
      actions.push({
        type: 'REPARENT_ELEMENT',
        pageId: currentPageId,
        elementKey: reparentDragKey,
        newParentKey,
        insertIndex,
      });
      await acceptEditorCommands(doc, actions, claimSnapshot());
      window.postMessage({
        type: 'REPARENT_ELEMENT_IN_IFRAME',
        payload: {
          key: reparentDragKey,
          newParentKey,
          insertIndex,
        },
      }, '*');
      setReparentDragKey(null);
      } catch (error) { toast.error(t("Move was not saved: {0}", { 0: error instanceof Error ? error.message : String(error) })); }
    },
    [doc, reparentDragKey, currentPageId, layoutRootKey, dispatch, takeSnapshot, claimSnapshot, setReparentDragKey, scannedElements, projectId, pushStructuralUndo, scannedByKey],
  );

  const emptyMessage = scannedElements.length === 0 && !localProjectPath
    ? t('Start preview to see elements')
    : t('No elements on page');

  // Keys of multi-selection extras for member-row highlighting.
  const multiSelectedKeys = useMemo(
    () => new Set(additionalSelections.map((e) => e.key)),
    [additionalSelections],
  );

  // Group payload for member-row drags (primary first, extras after).
  const groupKeys = useMemo(
    () => (selectedKey && additionalSelections.length > 0
      ? [selectedKey, ...additionalSelections.map((e) => e.key)]
      : null),
    [selectedKey, additionalSelections],
  );

  const handleContextMenu = useCallback(
    (clickedKey: string, elementId: string, point: MenuPoint) => {
      const key = resolveCloneRedirect({ clickedKey, scannedElements }) ?? clickedKey;
      if (key !== selectedKey && !additionalSelections.some(e => e.key === key)) handleSelect(clickedKey, elementId);
      layerMenu.open(point);
    },
    [scannedElements, selectedKey, additionalSelections, handleSelect],
  );

  const treeContextValue = useMemo<TreeContextValue>(
    () => ({
      expandedNodes,
      selectedKey,
      multiSelectedKeys,
      groupKeys,
      showChevrons: isTreeHovered,
      aiActiveKeys: aiActiveSet,
      aiTouchedKeys: aiTouchedSet,
      motherEntityKeys,
      blogSlotKeys,
      postRootKeys,
      postRootLabels,
      componentTypeById,
      penShapeIds,
      dynamicComponentIndex: dynamicIndex,
      baseDepth,
      // Under a derived local Layout node, the layout file's own tags are plain
      // rows (main, footer) — not fake "Main" component roots duplicating the
      // wrapper's name. Same suppression viewedComponentFile already does.
      viewedComponentFile: viewedComponentFile ?? localLayout?.file ?? null,
      onToggleExpand: toggleExpand,
      onSelect: handleSelect,
      onDoubleClick: handleDoubleClick,
      onContextMenu: handleContextMenu,
    }),
    [
      expandedNodes, selectedKey, multiSelectedKeys, groupKeys, isTreeHovered, aiActiveSet, aiTouchedSet,
      motherEntityKeys, blogSlotKeys, postRootKeys, postRootLabels,
      componentTypeById, penShapeIds, dynamicIndex, baseDepth, viewedComponentFile, localLayout,
      toggleExpand, handleSelect, handleDoubleClick, handleContextMenu,
    ],
  );

  return (
    <div data-testid="layers-panel" data-canvas-keys className="text-sm select-none outline-none relative" tabIndex={0}>
      {reparentDragKey && (
        <ReparentDropZone
          nodes={baseNodes}
          onDrop={handleReparentDrop}
        />
      )}
      <div
        className="p-1 space-y-px"
        onMouseEnter={() => setIsTreeHovered(true)}
        onMouseLeave={() => setIsTreeHovered(false)}
      >
        {nodes.length === 0 ? (
          <div className="p-3 text-text-secondary text-center text-xs">
            {emptyMessage}
          </div>
        ) : (
          <TreeContext.Provider value={treeContextValue}>
            <SortableContext key={sortableVersion} items={rootNodeIds} strategy={verticalListSortingStrategy}>
              {nodes.map((node, index) =>
                node.key === layoutNodeKey ? (
                  <LayoutRootNode key={node.key} node={node} />
                ) : (
                  <SortableNode
                    key={node.key}
                    node={node}
                    index={index}
                    siblingKeys={rootNodeIds}
                    parentKey={null}
                  />
                ),
              )}
            </SortableContext>
          </TreeContext.Provider>
        )}
      </div>
    </div>
  );
}
