import { FolderPlusIcon as SharedFolderPlusIcon, SwatchesIcon as SharedSwatchesIcon } from '@/assets/icons';
import React, { Fragment, useState, useCallback, useMemo, useEffect, useRef, useLayoutEffect } from 'react';
import { t } from '@/i18n';
import { createPortal } from 'react-dom';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useComponentLibrary, type ScannedComponent } from '@/hooks/useComponentLibrary';
import { useLayoutLibrary, layoutToScannedComponent, type ScannedLayout } from '@/hooks/useLayoutLibrary';
import { MediaSection } from './LocalMediaSection';
import {
  resolveFolderTree,
  materializeTree,
  mergeScannedComponents,
  deleteFolder,
  componentItemId,
  repointComponentId,
  newFolderId,
  partitionRoots,
  ensureDynamicFolder,
  isDynamicComponent,
  buildDynamicComponentIndex,
  DYNAMIC_FOLDER_ID,
  type AssetItem,
  type FolderManifest,
  type DynamicComponentIndex,
} from '@/store/folderManifest';
import { planFolderMove } from '@/store/planFolderMove';
import { useFolderManifest } from '@/hooks/useFolderManifest';
import toast from 'react-hot-toast';
import { useComponentFileOps } from '@/hooks/useComponentFileOps';
import { useContentCollections } from '@/hooks/useContentCollections';
import { allCardAssignments, useCardTitleLockVersion } from '@/utils/cardTitleLock';
import { deleteCards } from '@/components/Editor/localCardMove';
import { CARD_FILE } from '@/utils/cardFields';
import { setCardCollectionView } from '@/utils/cardCollectionView';
import { overlayBlogSection } from './collectionFolders';
import { acquireStructuralWrite, releaseStructuralWrite } from '@/store/structuralWriteGuard';
import { isLocalProjectId } from '@/utils/localMode';
// task-206: sq/ components are SYSTEM files — badged, never renamed or
// deleted from the panel. The path prefix is the gate, not the runtime.
import { isOurSystemComponent, isSystemComponentPath } from '@/utils/systemComponents';
import { useTreeMultiSelect, type RowClickModifiers } from '@/hooks/useTreeMultiSelect';
import {
  Row,
  OperationNotice,
  EmptyState,
  Button,
  Badge,
  MenuItem,
  SortableTreeProvider,
  useTreeNodeDnd,
  TreeDropIndicator,
  type TreeItemBase,
} from '@/components/ui';
import { useLayersDrag } from '@/components/Editor/useLayersDrag';
import { ComponentIcon, FolderIcon, PageIcon, TrashIcon } from '@/assets/icons';
import { PlusIcon } from '@/assets/icons';
import { DRAG_TYPES } from '@/types/drag';
import { useUndoContext } from '@/context/UndoContext';
import { useYjsValue, useDispatch, useEditorDoc } from '@/store/hooks';
import { selectVariableCollections } from '@/store/variableSelectors';
import { selectEditorRootElementId, selectAllPages } from '@/store/selectors';
import { isPageWrapperKey } from '@/utils/pageWrapperKey';
import { useVariables } from '@/context/VariablesContext';
import { ElementsTree } from '@/components/LayersPanel/ElementsTree';
import { viewRootKey } from '@/utils/treeUtils';
import { useSelectionContext, useScannedElementsRef } from '@/context/SelectionContext';
import { createDefaultCollection } from '@/core/variables/types';

// ── Shared class constants ─────────────────────────────────────────────

const CONTEXT_MENU_CLASS = 'fixed bg-bg border border-stroke rounded-inner shadow-flyout py-1 z-flyout min-w-[120px]';

function editInputClassName(
  isEditing: boolean,
  opts?: { cursor?: string; extraClasses?: string; idleTextClass?: string },
): string {
  const extra = opts?.extraClasses ?? '';
  const base = `w-full min-w-0 text-xs outline-none overflow-hidden text-ellipsis ${extra}`;
  if (isEditing) {
    return `${base} text-text border border-stroke-active rounded px-1 cursor-text bg-bg-input-editing`;
  }
  const cursor = opts?.cursor ?? 'cursor-pointer';
  const idleText = opts?.idleTextClass ?? 'text-inherit';
  return `${base} ${idleText} border-transparent ${cursor} bg-transparent`;
}

// ── Shared row interactions ────────────────────────────────────────────

/**
 * An open editor-doc row (isActive) wears the SELECTION highlight when the
 * selection is at the DOCUMENT TOP LEVEL — i.e. nothing is selected, or the doc's
 * OWN ROOT is selected. The highlight only moves OFF the doc row when a deeper
 * CHILD element is selected, so the doc row and a child never both read as
 * selected. Used by both the root and child loops.
 *
 * The `isPageWrapperKey` clause is DEFENSIVE: the infrastructure wrapper
 * (#sq-components / [pageId].astro) is no longer selected on editor load (the
 * auto-context-enter passes select:false — see SelectionContext.enterContext), so
 * selectedKey is normally null there. The clause only matters if the wrapper is
 * ever selected by some other path; it keeps the row reading as document-level.
 */
export function docRowSelected(
  isActive: boolean,
  selectedKey: string | null,
  editorRootId: string | null,
): boolean {
  if (!isActive) return false;
  return !selectedKey || selectedKey === editorRootId || isPageWrapperKey(selectedKey);
}

/**
 * Right-click context menu anchored under a row: tracks open state, positions
 * the menu at the row's bottom-right, and closes on outside click or resize. Shared by the
 * component, category, layout and variable-collection rows.
 */
function useContextMenu(
  rowRef: React.RefObject<HTMLDivElement | null>,
  /** Anchor at the cursor instead of the row's bottom-right. The row still
   *  supplies the fallback, so a keyboard-opened menu stays positioned. */
  cursor?: { top: number; left: number } | null,
) {
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!showMenu) return;
    if (cursor) { setMenuPos(cursor); return; }
    if (rowRef.current) {
      const rect = rowRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom, left: rect.right - 120 });
    }
  }, [showMenu, rowRef, cursor]);

  useEffect(() => {
    if (!showMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false);
    };
    // The menu sits at a fixed point: a layout change (⌘\ hides the sidebars) leaves it stranded.
    const close = () => setShowMenu(false);
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('resize', close);
    };
  }, [showMenu]);

  return { showMenu, setShowMenu, menuRef, menuPos };
}

/**
 * Inline rename for a tree row: focuses/selects on edit, resyncs the draft to
 * `name` when not editing, and commits (Enter/blur, empty → name) or cancels
 * (Escape). `onCommit`/`onCancel` let each caller bind its own id arity.
 */
function useInlineEdit(
  name: string,
  isEditing: boolean,
  onCommit: (value: string) => void,
  onCancel: () => void,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(name);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (!isEditing) setValue(name);
  }, [name, isEditing]);

  const commit = useCallback(() => onCommit(value.trim() || name), [value, name, onCommit]);
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); setValue(name); onCancel(); }
  }, [commit, name, onCancel]);

  return { value, setValue, inputRef, commit, onKeyDown };
}

// ── Icons ──────────────────────────────────────────────────────────────

function FolderPlusIcon({ className }: { className?: string }) {
  return (
    <SharedFolderPlusIcon className={className} />
  );
}

// ── Data model ─────────────────────────────────────────────────────────
//
// The tree is DERIVED — `resolveFolderTree(scannedComponents, manifest)` — and
// never held in React state. That is the whole fix for "my folders reset":
// there is nothing left for a scan/HMR rebuild to drop on the floor. Folder
// structure lives in a sidecar manifest file; component files never move.
// Design: docs/plans/2026-08-09-component-folders-redesign-design.md

/** AssetItem already satisfies TreeItemBase (id + children). */
type AssetTreeItem = AssetItem & TreeItemBase;

/** Everything the recursive tree rows need, passed as one object so a folder
 *  can render its children without a 15-prop relay at every level. */
interface TreeCtx {
  canEditTree: boolean;
  unavailablePaths: Set<string>;
  itemById: Map<string, AssetTreeItem>;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  /** Multi-select click policy, already bound to the current visible row order. */
  onRowClick: (id: string, mods: RowClickModifiers) => void;
  isMultiSelected: (id: string) => boolean;
  /** Right-click arming: keeps a selection the row belongs to, else selects it. */
  onArmContextMenu: (id: string) => void;
  selectionCount: number;
  onNewFolderFromSelection: () => void;
  onDeleteSelection: () => void;
  /** Force a row into / out of the Dynamic section (the reserved folder). */
  onSetDynamic: (id: string, dynamic: boolean) => void;
  /** Rows the USER forced dynamic — only these offer "Remove from Dynamic". */
  forcedDynamicIds: Set<string>;
  /** Library-derived dynamic subset — passed to the nested ElementsTree so its
   *  rows wear the same yellow accent (built once per library change). */
  dynamicIndex: DynamicComponentIndex;
  /** task-207 Task 12: move a component into/out of sq/. Works in BOTH
   *  runtimes (useComponentFileOps routes local vs WC); null only when a
   *  runtime has no promote path, so the menu item hides instead of lying. */
  onPromoteComponent: ((componentPath: string, promote: boolean) => void) | null;
  activeComponentPath: string | null;
  onSelectComponent: (component: ScannedComponent) => void;
  editingId: string | null;
  onStartEditing: (id: string) => void;
  onFinishEditing: (id: string, newName: string) => void;
  /** Open editor doc's root id — computed once by AssetsPanel so each row
   *  doesn't open its own (identical) Yjs subscription. */
  editorRootId: string | null;
  selectedKey: string | null;
}

/**
 * The row context menu. Delete acts on the WHOLE selection when the row is part
 * of one (onArmContextMenu has already made sure the row is selected), so a
 * multi-select delete is one gesture and one undo entry.
 */
function RowMenu({ ctx, onClose, rowId, hideDelete = false, promotable }: {
  ctx: TreeCtx;
  onClose: () => void;
  /** The row the menu was opened on — the Static/Dynamic toggle acts on it. */
  rowId: string;
  hideDelete?: boolean;
  /** The component this row is for, when promote/un-promote applies to it.
   *  Absent for folders, for OURS (locked), and off local mode. */
  promotable?: { path: string; isPromoted: boolean };
}) {
  const isForced = ctx.forcedDynamicIds.has(rowId);
  return (
    <>
      <MenuItem
        label="New folder from selection"
        icon={<FolderPlusIcon className="w-4 h-4" />}
        className="px-3"
        onSelect={() => { onClose(); ctx.onNewFolderFromSelection(); }}
      />
      {/* Only the FORCED direction is offered. A Blog/Database/sq component is
          dynamic by what it renders, so "make it Static" would be a lie — the
          derived rows deliberately get no toggle back. */}
      <MenuItem
        label={isForced ? 'Move to Static' : 'Move to Dynamic'}
        icon={<ComponentIcon className="w-4 h-4" />}
        className="px-3"
        onSelect={() => { onClose(); ctx.onSetDynamic(rowId, !isForced); }}
      />
      {promotable && ctx.onPromoteComponent && (
        <MenuItem
          label={promotable.isPromoted ? 'Remove from components menu' : 'Add to components menu'}
          icon={<ComponentIcon className="w-4 h-4" />}
          className="px-3"
          onSelect={() => {
            onClose();
            ctx.onPromoteComponent!(promotable.path, !promotable.isPromoted);
          }}
        />
      )}
      {!hideDelete && (
        <MenuItem
          label={ctx.selectionCount > 1 ? `Delete ${ctx.selectionCount} items` : 'Delete'}
          icon={<TrashIcon className="w-4 h-4" />}
          className="px-3"
          onSelect={() => { onClose(); ctx.onDeleteSelection(); }}
        />
      )}
    </>
  );
}


// ── Sortable component node ────────────────────────────────────────────

interface ComponentNodeProps {
  item: AssetTreeItem;
  depth: number;
  /** Drives "open in editor": nested ElementsTree + scroll-into-view. */
  isActive: boolean;
  /** Drives the SELECTION highlight only — gated separately from isActive so the
   *  open-doc row drops its highlight when an element inside its tree is selected. */
  isSelected: boolean;
  isEditing: boolean;
  ctx: TreeCtx;
  onSelect: (component: ScannedComponent) => void;
  onStartEditing: () => void;
  onFinishEditing: (newName: string) => void;
}

/** ⇧/⌘ mapping mirrors ElementsTree.tsx exactly — one policy, no invention. */
function rowMods(e: React.MouseEvent): RowClickModifiers {
  return { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey };
}

function ComponentNode({ item, depth, isActive, isSelected, isEditing, ctx, onSelect, onStartEditing, onFinishEditing }: ComponentNodeProps) {
  const { onRowClick, onArmContextMenu } = ctx;
  const unavailable = ctx.unavailablePaths.has(item.component?.path ?? '');
  const { setNodeRef, attributes, listeners, isDragging, dropZone } = useTreeNodeDnd(
    item.id,
    DRAG_TYPES.ASSETS_PANEL,
    isEditing || !ctx.canEditTree,
  );
  const rowRef = useRef<HTMLDivElement>(null);
  const { showMenu, setShowMenu, menuRef, menuPos } = useContextMenu(rowRef);
  const { value: editValue, setValue: setEditValue, inputRef, commit: commitEdit, onKeyDown: onEditKeyDown } =
    useInlineEdit(item.name, isEditing, (v) => onFinishEditing(v), () => onFinishEditing(item.name));

  // Scroll the row into view when it becomes active (e.g. via "Go to source"
  // expanding its parent category). No-op when already visible.
  useEffect(() => {
    if (isActive) rowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [isActive]);

  // task-207 D5: the lock is OURS, not the sq/ folder. A component the user
  // promoted lives there too and stays a normal row — renamable, deletable,
  // editable. Narrowing this is what makes promotion non-punitive.
  const isSystem = isOurSystemComponent(item.component?.path);
  const assignment = item.component ? allCardAssignments().get(item.component.path) : undefined;
  const servedIn = assignment?.card ? assignment.collections[0] : undefined;

  // Dynamic rows (derived OR user-forced) wear the yellow dynamic accent on
  // icon AND label — same treatment as Layers rows and the DesignBar caption.
  const isDynamic = isDynamicComponent(item.component) || ctx.forcedDynamicIds.has(item.id);
  const identityClass = isDynamic ? 'text-dynamic' : 'text-stroke-component';

  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className="relative group/row" style={{ opacity: isDragging ? 0.5 : 1 }}>
      {dropZone === 'above' && <TreeDropIndicator position="above" />}
      {dropZone === 'below' && <TreeDropIndicator position="below" />}

      <Row
        ref={rowRef}
        depth={depth}
        selected={isSelected}
        disabled={unavailable}
        rowProps={{ 'aria-disabled': unavailable || undefined }}
        left={[
          { type: 'chevron', expanded: false, visible: false },
          {
            type: 'icon',
            icon: item.component?.pageTemplate
              ? <PageIcon className={`w-4 h-4 ${identityClass}`} aria-label="Page template" />
              : <ComponentIcon className={`w-4 h-4 ${identityClass}`} />,
          },
        ]}
        title={
          <input
            ref={inputRef}
            type="text"
            value={isEditing ? editValue : t(item.name)}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={onEditKeyDown}
            onBlur={commitEdit}
            readOnly={!isEditing}
            className={editInputClassName(isEditing, { cursor: 'cursor-grab', extraClasses: 'font-normal', idleTextClass: identityClass })}
            onClick={(e) => { if (isEditing) e.stopPropagation(); }}
            onPointerDown={(e) => { if (isEditing) e.stopPropagation(); }}
          />
        }
        right={[
          ...(isSystem ? [{ type: 'custom' as const, unboxed: true, node: <Badge size="sm">System</Badge> }] : []),
        ]}
        className={`h-7 px-2 rounded gap-1 cursor-grab active:cursor-grabbing ${dropZone === 'inside' ? 'ring-2 ring-accent-strong ring-inset' : ''}`}
        onClick={(e) => {
          const mods = rowMods(e);
          onRowClick(item.id, mods);
          // A plain click still opens the component; only the modifier variants
          // are pure selection gestures.
          if (!mods.toggle && !mods.range && item.component) {
            if (servedIn) setCardCollectionView(item.component.path, servedIn);
            onSelect(item.component);
          }
        }}
        onDoubleClick={isSystem || !ctx.canEditTree ? undefined : onStartEditing}
        onContextMenu={(e) => { e.preventDefault(); if (!ctx.canEditTree) return; onArmContextMenu(item.id); setShowMenu(true); }}
      />

      {showMenu && ctx.canEditTree && createPortal(
        <div
          ref={menuRef}
          className={CONTEXT_MENU_CLASS}
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          <RowMenu
            ctx={ctx}
            rowId={item.id}
            onClose={() => setShowMenu(false)}
            hideDelete={isSystem || item.component?.path === CARD_FILE}
            promotable={!isSystem && item.component?.path
              ? { path: item.component.path, isPromoted: isSystemComponentPath(item.component.path) }
              : undefined}
          />
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Tree node dispatch ─────────────────────────────────────────────────

/** One rendered row (plus its subtree when it is an expanded folder). */
function TreeNode({ id, depth, ctx }: { id: string; depth: number; ctx: TreeCtx }) {
  const item = ctx.itemById.get(id);
  if (!item) return null;

  if (item.kind === 'folder') {
    return <FolderNode item={item} depth={depth} ctx={ctx} />;
  }

  const path = item.component?.path;
  const isActive = ctx.activeComponentPath === path;
  return (
    <>
      <ComponentNode
        item={item}
        depth={depth}
        isActive={isActive}
        isSelected={docRowSelected(isActive, ctx.selectedKey, ctx.editorRootId) || ctx.isMultiSelected(item.id)}
        isEditing={ctx.editingId === item.id}
        ctx={ctx}
        onSelect={ctx.onSelectComponent}
        onStartEditing={() => ctx.onStartEditing(item.id)}
        onFinishEditing={(newName) => ctx.onFinishEditing(item.id, newName)}
      />
      {isActive && <ElementsTree baseDepth={depth + 1} viewedComponentFile={item.component?.path ?? null} dynamicIndex={ctx.dynamicIndex} />}
    </>
  );
}

// ── Sortable folder node ───────────────────────────────────────────────

interface FolderNodeProps {
  item: AssetTreeItem;
  depth: number;
  ctx: TreeCtx;
}

/**
 * Recursive: a folder's children may themselves be folders, at any depth. The
 * old CategoryNode hard-coded root-category → component, which is why nesting
 * "unwrapped" on every rebuild.
 */
function FolderNode({ item, depth, ctx }: FolderNodeProps) {
  const { expanded, onToggle, onRowClick, isMultiSelected, onArmContextMenu, editingId, onStartEditing, onFinishEditing } = ctx;
  const isExpanded = expanded.has(item.id);
  const isEditing = editingId === item.id;
  const { setNodeRef, attributes, listeners, isDragging, dropZone } = useTreeNodeDnd(item.id, DRAG_TYPES.ASSETS_PANEL, isEditing || !ctx.canEditTree);
  const rowRef = useRef<HTMLDivElement>(null);
  const { showMenu, setShowMenu, menuRef, menuPos } = useContextMenu(rowRef);
  const { value: editValue, setValue: setEditValue, inputRef, commit: commitEdit, onKeyDown: onEditKeyDown } =
    useInlineEdit(item.name, isEditing, (v) => onFinishEditing(item.id, v), () => onFinishEditing(item.id, item.name));

  const showNestHighlight = dropZone === 'inside';

  useEffect(() => {
    if (showNestHighlight && !isExpanded) {
      const timer = setTimeout(() => onToggle(item.id), 500);
      return () => clearTimeout(timer);
    }
  }, [showNestHighlight, isExpanded, onToggle, item.id]);

  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className="relative" style={{ opacity: isDragging ? 0.5 : 1 }}>
      {dropZone === 'above' && <TreeDropIndicator position="above" />}
      {dropZone === 'below' && <TreeDropIndicator position="below" />}

      <Row
        ref={rowRef}
        depth={depth}
        left={[
          {
            type: 'chevron',
            expanded: isExpanded,
            onToggle: () => onToggle(item.id),
          },
          { type: 'icon', icon: <FolderIcon className="w-4 h-4" /> },
        ]}
        title={
          <input
            ref={inputRef}
            type="text"
            value={isEditing ? editValue : t(item.name)}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={onEditKeyDown}
            onBlur={commitEdit}
            readOnly={!isEditing}
            className={editInputClassName(isEditing, { cursor: 'cursor-grab', extraClasses: 'font-medium' })}
            onClick={(e) => { if (isEditing) e.stopPropagation(); }}
            onPointerDown={(e) => { if (isEditing) e.stopPropagation(); }}
          />
        }
        selected={isMultiSelected(item.id)}
        className={`h-7 px-2 rounded gap-1 cursor-grab active:cursor-grabbing ${showNestHighlight ? 'ring-2 ring-accent-strong ring-inset' : ''}`}
        onClick={(e) => {
          const mods = rowMods(e);
          onRowClick(item.id, mods);
          if (!mods.toggle && !mods.range) onToggle(item.id);
        }}
        onDoubleClick={ctx.canEditTree ? () => onStartEditing(item.id) : undefined}
        onContextMenu={(e) => { e.preventDefault(); if (!ctx.canEditTree) return; onArmContextMenu(item.id); setShowMenu(true); }}
      />

      {showMenu && ctx.canEditTree && createPortal(
        <div
          ref={menuRef}
          className={CONTEXT_MENU_CLASS}
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          <RowMenu ctx={ctx} rowId={item.id} onClose={() => setShowMenu(false)} />
        </div>,
        document.body
      )}

      {isExpanded && (
        <SortableContext items={item.children} strategy={verticalListSortingStrategy}>
          {item.children.map((childId) => (
            <TreeNode key={childId} id={childId} depth={depth + 1} ctx={ctx} />
          ))}
        </SortableContext>
      )}
    </div>
  );
}

// ── Variable Collection Row ────────────────────────────────────────────

function VariableCollectionIcon({ className }: { className?: string }) {
  return (
    <SharedSwatchesIcon className={className} />
  );
}

function VariableCollectionRow({
  id,
  name,
  isSelected,
  isEditing,
  canDelete,
  onSelect,
  onStartEditing,
  onFinishEditing,
  onDelete,
}: {
  id: string;
  name: string;
  isSelected: boolean;
  isEditing: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onStartEditing: () => void;
  onFinishEditing: (name: string) => void;
  onDelete: () => void;
}) {
  const [editValue, setEditValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<{ top: number; left: number } | null>(null);
  const { showMenu, setShowMenu, menuRef, menuPos } = useContextMenu(rowRef, cursor);

  useEffect(() => { setEditValue(name); }, [name]);
  useEffect(() => { if (isEditing) inputRef.current?.select(); }, [isEditing]);

  const commitEdit = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== name) onFinishEditing(trimmed);
    else { setEditValue(name); onFinishEditing(name); }
  };

  return (
    <div ref={rowRef} className="relative">
      <Row
        depth={0}
        selected={isSelected}
        left={[
          { type: 'chevron', expanded: false, visible: false },
          {
            type: 'icon',
            icon: <VariableCollectionIcon className={isSelected ? 'w-4 h-4 text-text-muted' : 'w-4 h-4'} />,
          },
        ]}
        title={
          <input
            ref={inputRef}
            type="text"
            value={isEditing ? editValue : t(name)}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
              else if (e.key === 'Escape') { e.preventDefault(); setEditValue(name); onFinishEditing(name); }
            }}
            onBlur={commitEdit}
            readOnly={!isEditing}
            className={editInputClassName(isEditing, { extraClasses: 'font-normal' })}
            onClick={(e) => { if (isEditing) e.stopPropagation(); }}
            onPointerDown={(e) => { if (isEditing) e.stopPropagation(); }}
          />
        }
        className="h-7 px-2 rounded gap-1"
        onClick={onSelect}
        onDoubleClick={onStartEditing}
        onContextMenu={(e) => { e.preventDefault(); setCursor({ top: e.clientY, left: e.clientX }); setShowMenu(true); }}
      />

      {showMenu && createPortal(
        <div
          ref={menuRef}
          className={CONTEXT_MENU_CLASS}
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          <MenuItem
            label="Rename"
            className="px-3"
            onSelect={() => { setShowMenu(false); onStartEditing(); }}
          />
          {canDelete && (
            <MenuItem
              label="Delete"
              icon={<TrashIcon className="w-4 h-4" />}
              className="px-3"
              onSelect={() => { setShowMenu(false); onDelete(); }}
            />
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

/**
 * A Layouts-section row. Self-contained menu, like CollectionRow — layouts left
 * the folder tree (2026-08-22 layouts-section design), so the selection-based
 * RowMenu does not apply to them.
 */
function LayoutRow({ layout, selected, disabled, onSelect, onDelete }: {
  layout: ScannedLayout;
  selected: boolean;
  /** The layout list is unavailable/loading — the row reads as inert and its
   *  context menu does not open (deleting a layout we could not list would act
   *  on a stale name). */
  disabled: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<{ top: number; left: number } | null>(null);
  const { showMenu, setShowMenu, menuRef, menuPos } = useContextMenu(rowRef, cursor);

  return (
    <div ref={rowRef}>
      <Row
        depth={0}
        disabled={disabled}
        rowProps={{ 'aria-disabled': disabled || undefined }}
        // Same convention as ComponentNode: the open-doc highlight moves OFF
        // this row whenever a deeper node is selected — a parent row and a
        // child row never both read as selected.
        selected={selected}
        left={[
          { type: 'chevron', expanded: false, visible: false },
          { type: 'icon', icon: <ComponentIcon className="w-4 h-4 text-dynamic" /> },
        ]}
        title={<span className="text-xs text-dynamic truncate">{t(layout.name)}</span>}
        className="h-7 px-2 rounded gap-1 cursor-pointer"
        onClick={onSelect}
        onContextMenu={(e) => {
          e.preventDefault();
          if (disabled) return;
          setCursor({ top: e.clientY, left: e.clientX });
          setShowMenu(true);
        }}
      />
      {showMenu && createPortal(
        <div ref={menuRef} className={CONTEXT_MENU_CLASS} style={{ top: menuPos.top, left: menuPos.left }}>
          <MenuItem
            label="Delete"
            icon={<TrashIcon className="w-4 h-4" />}
            className="px-3"
            onSelect={() => { setShowMenu(false); onDelete(); }}
          />
        </div>,
        document.body
      )}
    </div>
  );
}

// ── AssetsPanel ────────────────────────────────────────────────────────

interface AssetsPanelProps {
  activeComponentPath: string | null;
  onSelectComponent: (component: ScannedComponent) => void;
  /** Callback to clear component selection when a variable collection is selected */
  onClearComponent?: () => void;
  /** When true, auto-select the first component and expand its parent folder */
}

const MIN_VARS_HEIGHT = 60;
const DEFAULT_VARS_HEIGHT = 80;
const VARS_HEIGHT_KEY = 'starquix:assets-vars-height';

export function AssetsPanel({ activeComponentPath, onSelectComponent, onClearComponent }: AssetsPanelProps) {
  // Folder ops write the sidecar manifest and component-file ops go through
  // useComponentFileOps, which is the only thing that knows which runtime it is.
  const componentFiles = useComponentFileOps();
  const { builtIn, userProject, isLoading, error, refresh, projectState } = useComponentLibrary();
  const { layouts, isLoading: layoutsLoading, error: layoutsError, refresh: refreshLayouts, readState: layoutReadState } = useLayoutLibrary();
  const displayProject = projectState?.data ?? userProject;
  const displayLayouts = layoutReadState?.data ?? layouts;
  const unavailablePaths = useMemo(() => new Set(isLoading || error ? displayProject.map(c => c.path) : []), [isLoading, error, displayProject]);
  // Dynamic subset for the nested ElementsTree's yellow accent — one build
  // per library change, same predicate the section split itself uses.
  // Layouts live in their OWN library — map them in or they never classify.
  const dynamicIndex = useMemo(
    () => buildDynamicComponentIndex([...builtIn, ...userProject, ...layouts.map(layoutToScannedComponent)]),
    [builtIn, userProject, layouts],
  );
  const { takeSnapshot, claimSnapshot } = useUndoContext();
  const { selectedKey } = useSelectionContext();
  const { scannedElementsRef } = useScannedElementsRef();
  // Files-truth: the master's ROOT (utils/treeUtils viewRootKey — the layout
  // <body>, lifted out of the nested tree so it has no row of its own, or the
  // component root). Selecting it IS selecting the master row (owner report
  // 2026-09-11: DesignBar showed Body, the left showed nothing). Ref + memo on
  // selectedKey: a rect tick must not re-render this panel, and every scan that
  // can change the root ends in a select.
  const docEditorRootId = useYjsValue(selectEditorRootElementId);
  const viewRoot = useMemo(
    () => viewRootKey(activeComponentPath, scannedElementsRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedKey is the recompute trigger
    [activeComponentPath, selectedKey],
  );
  const editorRootId = docEditorRootId ?? viewRoot;
  const collections = useYjsValue(selectVariableCollections);
  const { activeCollectionId, setActiveCollectionId } = useVariables();
  const dispatch = useDispatch();
  // Read DIRECTLY, never through useYjsValue: handleDeleteLayout needs every
  // page's layout at click time, and subscribing to that would re-render this
  // panel on every doc change for a value only a handler reads.
  const doc = useEditorDoc();
  const containerRef = useRef<HTMLDivElement>(null);
  // The nested ElementsTree (master/component editor) renders inside this panel's
  // SortableTreeProvider DndContext. Without delegating, its element (LAYERS_PANEL)
  // drags get swallowed (SortableTree returns on a non-asset type). Route them to
  // the SAME shared Layers-drag handler the main editor uses.
  const layersDrag = useLayersDrag({ viewedComponentFile: activeComponentPath });

  // Draggable variables section height
  const [varsHeight, setVarsHeight] = useState(() => {
    const saved = localStorage.getItem(VARS_HEIGHT_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_VARS_HEIGHT;
  });
  const [isDraggingDivider, setIsDraggingDivider] = useState(false);

  useEffect(() => {
    localStorage.setItem(VARS_HEIGHT_KEY, String(varsHeight));
  }, [varsHeight]);

  useEffect(() => {
    if (!isDraggingDivider) return;
    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();
      const containerHeight = containerRect.height;
      const newHeight = e.clientY - containerRect.top;
      const minComponentsHeight = 100;
      const maxVarsHeight = containerHeight - minComponentsHeight;
      setVarsHeight(Math.max(MIN_VARS_HEIGHT, Math.min(maxVarsHeight, newHeight)));
    };
    const handleMouseUp = () => setIsDraggingDivider(false);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingDivider]);

  const handleAddCollection = useCallback(() => {
    takeSnapshot();
    const col = createDefaultCollection();
    dispatch({ type: 'ADD_VARIABLE_COLLECTION', collection: col });
    setActiveCollectionId(col.id);
  }, [dispatch, takeSnapshot, setActiveCollectionId]);

  const handleSelectCollection = useCallback((id: string) => {
    setActiveCollectionId(id);
    onClearComponent?.();
  }, [setActiveCollectionId, onClearComponent]);

  const handleRenameCollection = useCallback((id: string, name: string) => {
    takeSnapshot();
    dispatch({ type: 'RENAME_VARIABLE_COLLECTION', collectionId: id, name });
  }, [dispatch, takeSnapshot]);

  const handleDeleteCollection = useCallback((id: string) => {
    takeSnapshot();
    dispatch({ type: 'DELETE_VARIABLE_COLLECTION', collectionId: id });
    if (activeCollectionId === id) setActiveCollectionId(null);
  }, [dispatch, takeSnapshot, activeCollectionId, setActiveCollectionId]);

  const [editingCollectionId, setEditingCollectionId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());

  // Layouts are NOT in this tree. They render in their own section straight
  // from useLayoutLibrary — which is what makes them undraggable and makes
  // "drop a component into Layouts" impossible, with no guard code.
  const allComponents = useMemo(
    () => mergeScannedComponents(builtIn, displayProject),
    [builtIn, displayProject],
  );

  // ── The tree is DERIVED, never stored ──────────────────────────────
  // Folder structure lives in the manifest file; the tree is a pure function of
  // (scanned components, manifest). Nothing here can be dropped by an HMR
  // rebuild, which is exactly why folders stopped resetting.
  const { manifest, loaded: manifestLoaded, save: persistManifest, issue: folderIssue,
    retry: retryFolders, reload: reloadFolders, isSaving: foldersSaving } = useFolderManifest();
  // Folder Undo carries its exact file inverse in the accepted snapshot.
  // Publish dependent selection/editing state only after this gesture commits.
  const saveManifest = useCallback((next: FolderManifest, snapshot?: ReturnType<typeof claimSnapshot>, onAccepted?: () => void) => {
    void Promise.resolve(persistManifest(next, snapshot)).then(onAccepted).catch(() => { /* the owner reports acceptance failure */ });
  }, [persistManifest]);
  const canEditTree = !isLoading && !error && manifestLoaded && !foldersSaving && (!folderIssue || folderIssue.outcome === 'no-write');
  const canCreate = canEditTree && !layoutsLoading && !layoutsError;
  const { items: treeItems, rootIds: treeRootIds } = useMemo(
    () => resolveFolderTree(allComponents, manifest),
    [allComponents, manifest],
  );
  // The Blog section: a RENDER overlay (overlayBlogSection); manifest writes
  // below keep using treeItems/treeRootIds (the real tree).
  const { collections: contentCollections } = useContentCollections();
  const cardsVersion = useCardTitleLockVersion();
  const view = useMemo(
    () => overlayBlogSection({ items: treeItems, rootIds: treeRootIds }, { assignments: allCardAssignments() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cardsVersion: the assignments changed
    [treeItems, treeRootIds, cardsVersion],
  );
  const itemById = useMemo(() => new Map(view.items.map((i) => [i.id, i])), [view]);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Static vs Dynamic is a PRESENTATION split over the same derived tree —
  // identical in every runtime, and the provider still gets the full rootIds
  // so drop indexes stay counted against the real root order.
  const { staticIds, dynamicIds, blogIds, forcedDynamicIds } = useMemo(() => {
    const p = partitionRoots(view);
    const inBlog = new Set(view.blogIds);
    return {
      staticIds: p.staticIds.filter((id) => !inBlog.has(id)),
      dynamicIds: p.dynamicIds.filter((id) => !inBlog.has(id)),
      blogIds: view.blogIds,
      forcedDynamicIds: p.forcedIds,
    };
  }, [view]);

  // ── Multi-select ───────────────────────────────────────────────────
  const sel = useTreeMultiSelect();

  /** Depth-first over what is actually RENDERED — a collapsed folder's members
   *  are not visible, so ⇧click can never sweep them in. */
  const visibleIds = useMemo(() => {
    const out: string[] = [];
    const walk = (ids: string[]) => {
      for (const id of ids) {
        out.push(id);
        const item = itemById.get(id);
        if (item?.kind === 'folder' && expandedFolders.has(id)) walk(item.children);
      }
    };
    // Render order, not manifest order — ⇧click sweeps what the eye sees, and
    // the two sections interleave the raw root list.
    walk([...staticIds, ...dynamicIds, ...blogIds]);
    return out;
  }, [staticIds, dynamicIds, blogIds, itemById, expandedFolders]);

  const handleRowClick = useCallback(
    (id: string, mods: RowClickModifiers) => sel.onRowClick(id, mods, visibleIds),
    [sel, visibleIds],
  );

  // Esc clears. Bound on the document, not the container: the panel wrapper is
  // not focusable, so a keydown after a row click would never reach it. Skipped
  // while an inline rename input has focus — Esc cancels the rename there.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
      sel.clear();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [sel]);

  // When the active component changes (e.g. via "Go to source"), expand its
  // parent folder so the selected row is visible in the tree.
  useEffect(() => {
    if (!activeComponentPath) return;
    const childId = componentItemId(activeComponentPath);
    const parent = treeItems.find(i => i.kind === 'folder' && i.children.includes(childId));
    if (!parent) return;
    setExpandedFolders(prev => {
      if (prev.has(parent.id)) return prev;
      return new Set(prev).add(parent.id);
    });
  }, [activeComponentPath, treeItems]);

  // When a component is created via HTTP, we don't know its ID until HMR rebuilds the tree.
  // Store the expected name so we can auto-edit and auto-select it when it appears.
  const pendingEditNameRef = useRef<string | null>(null);
  useEffect(() => {
    const name = pendingEditNameRef.current;
    if (!name || !canEditTree) return;
    const newItem = treeItems.find(i => i.kind === 'component' && i.name === name);
    if (!newItem) return;
    pendingEditNameRef.current = null;
    setEditingId(newItem.id);
    if (newItem.component) onSelectComponent(newItem.component);
  }, [canEditTree, treeItems, onSelectComponent]);

  // No auto-select on open (owner report 2026-09-16): opening the Assets tab
  // used to open the FIRST component's view — the frame navigated away from
  // the page the user was on, and that in-flight switch raced their own click
  // ("Source gesture owner changed" on the copy they actually asked for).

  const handleCreateComponent = useCallback(async () => {
    // Layouts count too. They left `allComponents` (see the merge above), but a
    // component sharing a layout's name is the documented drift incident — two
    // same-named .astro files — so the collision set spans both libraries.
    const existingNames = new Set([...allComponents.map(c => c.name), ...layouts.map(l => l.name)]);
    let index = 1;
    let name = 'Component1';
    while (existingNames.has(name)) {
      index++;
      name = `Component${index}`;
    }

    const astroContent = `---\n---\n<section>\n  <p>${name}</p>\n</section>\n`;

    pendingEditNameRef.current = name;
    const createdPath = await componentFiles.create(name, astroContent);
    if (!createdPath) { pendingEditNameRef.current = null; return; }

    takeSnapshot({
      reverse: () => { componentFiles.remove(createdPath); },
      forward: () => {
        pendingEditNameRef.current = name;
        componentFiles.create(name, astroContent);
      },
    });
  }, [allComponents, layouts, takeSnapshot, componentFiles]);

  /**
   * Scaffold a new layout. A FULL Astro document, not a fragment: codegen emits
   * <LayoutN …> as the page's only wrapper, so a fragment ships pages with no
   * <html>/<head>. The preview is unaffected — stripDocumentBoilerplate removes
   * the scaffold before splicing content into the slot position.
   *
   * The bridge <script> is safe in both runtimes: the local plugin dedupes it
   * (sq-source-plugin.js, `if (!html.includes('/scripts/bridge.js'))`).
   *
   * `title` must be declared — SEO feeds title= to every wrapper via
   * buildSeoLayoutProps, and a layout that ignores it drops the page <title>.
   */
  const handleCreateLayout = useCallback(async () => {
    // Names are checked against COMPONENTS TOO: a layout sharing a component's
    // name is the documented drift incident, two same-named .astro files.
    const taken = new Set([...allComponents.map(c => c.name), ...layouts.map(l => l.name)]);
    let index = 1;
    let name = 'Layout1';
    while (taken.has(name)) { index++; name = `Layout${index}`; }

    const astroContent = `---\nimport '../styles/global.css';\ninterface Props { title?: string; }\nconst { title = '${name}' } = Astro.props;\n---\n\n<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>{title}</title>\n  </head>\n  <body>\n    <slot />\n    <script is:inline src="/scripts/bridge.js"></script>\n  </body>\n</html>\n`;

    const projectId = doc.getMap('meta').get('projectId');
    const durable = typeof projectId === 'string' && isLocalProjectId(projectId);
    if (durable) takeSnapshot();
    const created = durable ? await componentFiles.createLayout(name, astroContent, claimSnapshot())
      : await componentFiles.createLayout(name, astroContent);
    // No snapshot on failure — an undo entry for a file that was never written
    // would delete whatever else is sitting at that name.
    if (!created) { toast.error(t("Could not create the layout")); return; }

    if (!durable) takeSnapshot({
      reverse: () => { void componentFiles.deleteLayout(name); },
      forward: () => { void componentFiles.createLayout(name, astroContent); },
    });
  }, [allComponents, layouts, componentFiles, takeSnapshot, claimSnapshot, doc]);

  /**
   * Delete a layout. Every page that used it keeps its chrome as a real element,
   * so nothing on screen changes except that the layout is gone from the library.
   *
   * The claimed snapshot keeps the current document and receives exact file
   * inverses from acceptance. Source dispatch may finish after this panel closes.
   */
  const activeLayoutDeleteSelection = useRef(activeComponentPath);
  useLayoutEffect(() => { activeLayoutDeleteSelection.current = activeComponentPath; }, [activeComponentPath]);
  const handleDeleteLayout = useCallback(async (l: ScannedLayout) => {
    // Every direct importer is planned against accepted source before any file
    // changes. Undo journals the exact inverse of that whole accepted batch.
    const projectId = doc.getMap('meta').get('projectId');
    const durable = typeof projectId === 'string' && isLocalProjectId(projectId);
    if (durable) takeSnapshot();
    const previous = durable ? await componentFiles.inlineDeleteLayout(l.name, claimSnapshot())
      : await componentFiles.inlineDeleteLayout(l.name);
    // null = refused (a file uses it twice) or the group rolled back. Nothing
    // on disk changed, so there is nothing to undo.
    if (previous === null) { toast.error(t("Could not delete the layout")); return; }
    if (activeLayoutDeleteSelection.current === layoutToScannedComponent(l).path) onClearComponent?.();
    if (!durable) takeSnapshot({
      reverse: () => {
        // The asset side effect is not covered by the structural-write guard
        // (UndoContext.tsx:1051,1099); take it so this cannot interleave with
        // an in-flight structural write.
        // Its turn, never skipped (owner 2026-11-10: nothing is lost).
        void acquireStructuralWrite().then(() => componentFiles.restoreFiles(previous).finally(releaseStructuralWrite));
      },
      forward: () => { void componentFiles.inlineDeleteLayout(l.name); },
    });
  }, [componentFiles, takeSnapshot, claimSnapshot, doc, onClearComponent]);

  /**
   * Folder acceptance attaches exact before/after bytes to the claimed Undo
   * snapshot. Undo and Redo journal those inverses with their own acceptance.
   */
  const commitManifest = useCallback((next: FolderManifest, onAccepted?: () => void) => {
    takeSnapshot();
    saveManifest(next, claimSnapshot(), onAccepted);
  }, [takeSnapshot, claimSnapshot, saveManifest]);

  /**
   * materializeTree mints a fresh `f_*` id for every `fallback:<category>`
   * folder, so any id the UI is still holding — an expanded folder, a selected
   * row — must follow it or that folder visibly collapses and deselects.
   */
  const rekeyUiState = useCallback((idMap: Map<string, string>) => {
    if (idMap.size === 0) return;
    setExpandedFolders(prev => new Set([...prev].map(id => idMap.get(id) ?? id)));
  }, []);

  const handleCreateFolder = useCallback(() => {
    const existingNames = new Set(treeItems.filter(i => i.kind === 'folder').map(i => i.name));
    let index = 1;
    let name = 'Folder';
    while (existingNames.has(name)) {
      index++;
      name = `Folder ${index}`;
    }

    // The folder now exists in a FILE, so it survives the next scan even while
    // empty — that is reported bug 2.
    const id = newFolderId();
    const { manifest: base, idMap } = materializeTree(manifest, { items: treeItems, rootIds: treeRootIds });
    const next: FolderManifest = {
      version: 1,
      roots: [...base.roots, id],
      folders: { ...base.folders, [id]: { name, children: [] } },
    };

    commitManifest(next, () => {
      rekeyUiState(idMap);
      setExpandedFolders(prev => new Set(prev).add(id));
      setEditingId(id);
    });
  }, [treeItems, treeRootIds, manifest, commitManifest, rekeyUiState]);

  /**
   * Rename a component FILE. The manifest is keyed by scanned path, so the
   * member id must follow the file or the component drops out of its folder
   * and falls back to its @category (repointComponentId).
   */
  const renameComponent = useCallback(async (componentPath: string, oldName: string, newName: string) => {
    const newPath = await componentFiles.rename(componentPath, newName);
    if (!newPath) return; // refused (name taken) or the write failed

    const prev = manifest;
    const next = repointComponentId(prev, componentItemId(componentPath), componentItemId(newPath));

    takeSnapshot({
      reverse: () => { void componentFiles.rename(newPath, oldName); },
      forward: () => { void componentFiles.rename(componentPath, newName); },
    });
    const snapshot = claimSnapshot();
    if (next !== prev) saveManifest(next, snapshot);
    else snapshot?.commit();
  }, [componentFiles, manifest, saveManifest, takeSnapshot, claimSnapshot]);

  const handleToggle = useCallback((id: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleStartEditing = useCallback(setEditingId, []);

  const handleFinishEditing = useCallback((id: string, newName: string) => {
    if (!canEditTree) return;
    setEditingId(null);
    const item = itemById.get(id);
    if (!item || item.name === newName) return;

    if (item.kind === 'folder') {
      // Manifest-only write. Renaming no longer rewrites the @category of every
      // child file — and because folder identity is an opaque f_* id, a rename
      // can no longer change which folder a component belongs to.
      const { manifest: base, idMap } = materializeTree(manifest, { items: treeItems, rootIds: treeRootIds });
      const fid = idMap.get(id) ?? id;
      if (!base.folders[fid]) return;
      commitManifest({
        ...base,
        folders: { ...base.folders, [fid]: { ...base.folders[fid], name: newName } },
      }, () => rekeyUiState(idMap));
      return;
    }

    if (item.component) {
      void renameComponent(item.component.path, item.name, newName);
    }
  }, [canEditTree, itemById, treeItems, treeRootIds, manifest, commitManifest, rekeyUiState, renameComponent]);

  /**
   * Every move is one whole-manifest swap. Dropping onto a component row means
   * "insert as a sibling there" — the old branch that invented a folder named
   * after the drop TARGET is gone; it surprised everyone who hit it.
   *
   * Dragging a SELECTED row moves the whole selection; dragging an unselected
   * row moves just that row. That is what every file manager does.
   */
  const handleMove = useCallback(
    (itemId: string, newParentId: string | null, insertIndex: number) => {
      if (!itemById.has(itemId)) return;
      // A drop at the Blog section's top level lands in the Blog folder (a note — it binds nothing).
      const blogTail = view.rootIds.length - view.blogIds.length;
      if (newParentId === null && view.blogFolderId && insertIndex >= blogTail) {
        newParentId = view.blogFolderId;
        insertIndex -= blogTail;
      }
      // The index counts the VIEW's siblings; the manifest only knows the real ones.
      const viewSiblings = newParentId === view.blogFolderId ? view.blogIds : newParentId ? itemById.get(newParentId)?.children ?? [] : view.rootIds;
      const realSiblings = new Set(newParentId ? treeItems.find((i) => i.id === newParentId)?.children ?? [] : treeRootIds);
      insertIndex = viewSiblings.slice(0, insertIndex).filter((id) => realSiblings.has(id)).length;
      const movingIds = sel.isSelected(itemId) ? sel.selectedIds : [itemId];

      // materializeTree first: planFolderMove only knows the manifest, and an
      // insert index counted over rendered rows only means the same thing once
      // the visible order and the @category folders are explicit there.
      const { manifest: base, idMap } = materializeTree(manifest, { items: treeItems, rootIds: treeRootIds });
      const next = planFolderMove(base, {
        selectedIds: movingIds.map((id) => idMap.get(id) ?? id),
        targetFolderId: newParentId ? (idMap.get(newParentId) ?? newParentId) : null,
        insertIndex,
      });
      if (next === base) return; // refused (e.g. folder into its own descendant)

      commitManifest(next, () => {
        rekeyUiState(idMap);
        if (idMap.size > 0) sel.select(movingIds.map((id) => idMap.get(id) ?? id));
      });
    },
    [itemById, view, sel, treeItems, treeRootIds, manifest, commitManifest, rekeyUiState],
  );

  // ── Selection-level context-menu actions ───────────────────────────

  /**
   * Force a row into the Dynamic section, or back out to the Static root.
   *
   * This is a normal folder move into the reserved DYNAMIC_FOLDER_ID, which is
   * why it needed no manifest schema change: undo, materialize and self-healing
   * already cover it. Acts on the whole selection when the row is part of one,
   * same as delete.
   */
  const handleSetDynamic = useCallback((id: string, dynamic: boolean) => {
    if (!itemById.has(id)) return;
    const movingIds = sel.isSelected(id) ? sel.selectedIds : [id];

    const { manifest: base, idMap } = materializeTree(manifest, { items: treeItems, rootIds: treeRootIds });
    const target = dynamic ? ensureDynamicFolder(base) : base;
    const next = planFolderMove(target, {
      selectedIds: movingIds.map((i) => idMap.get(i) ?? i),
      targetFolderId: dynamic ? DYNAMIC_FOLDER_ID : null,
      insertIndex: dynamic ? (target.folders[DYNAMIC_FOLDER_ID]?.children.length ?? 0) : target.roots.length,
    });
    if (next === target) return; // refused

    commitManifest(next, () => rekeyUiState(idMap));
  }, [itemById, sel, treeItems, treeRootIds, manifest, commitManifest, rekeyUiState]);

  /** Right-click KEEPS a multi-selection the row belongs to; on an unselected
   *  row it selects just that row first. Same as every file manager. */
  const handleArmContextMenu = useCallback((id: string) => {
    if (!sel.isSelected(id)) sel.select([id]);
  }, [sel]);

  const handleNewFolderFromSelection = useCallback(() => {
    const ids = sel.selectedIds.filter((id) => itemById.has(id));
    if (ids.length === 0) return;

    const { manifest: base, idMap } = materializeTree(manifest, { items: treeItems, rootIds: treeRootIds });
    const mapped = ids.map((id) => idMap.get(id) ?? id);

    const parentOf = new Map<string, string | null>();
    for (const r of base.roots) parentOf.set(r, null);
    for (const [fid, n] of Object.entries(base.folders)) {
      for (const c of n.children) parentOf.set(c, fid);
    }
    const depthOf = (id: string) => {
      let d = 0;
      let cursor = parentOf.get(id);
      const seen = new Set<string>();
      while (cursor != null && !seen.has(cursor)) { d++; seen.add(cursor); cursor = parentOf.get(cursor); }
      return d;
    };
    // The new folder lands at the shallowest member's slot, so the block does
    // not jump across the tree when the selection spans several levels.
    const shallowest = mapped.reduce((a, b) => (depthOf(b) < depthOf(a) ? b : a));
    // Cards shown in the Blog section get their folder IN the Blog folder (a note — binds nothing).
    const blogFolder = view.blogFolderId ? idMap.get(view.blogFolderId) ?? view.blogFolderId : null;
    const inBlogSection = (id: string) => view.blogIds.includes(id) || parentOf.get(idMap.get(id) ?? id) === blogFolder;
    const parent = blogFolder && ids.every(inBlogSection) ? blogFolder : parentOf.get(shallowest) ?? null;

    const existingNames = new Set(treeItems.filter((i) => i.kind === 'folder').map((i) => i.name));
    let index = 1;
    let name = 'Folder';
    while (existingNames.has(name)) { index++; name = `Folder ${index}`; }

    const id = newFolderId();
    const insertAtSlot = (list: string[]) => {
      const at = list.indexOf(shallowest);
      return at === -1 ? [...list, id] : [...list.slice(0, at), id, ...list.slice(at)];
    };
    const withFolder: FolderManifest = {
      version: 1,
      roots: parent === null ? insertAtSlot(base.roots) : base.roots,
      folders: {
        ...Object.fromEntries(Object.entries(base.folders).map(([k, n]) =>
          [k, k === parent ? { ...n, children: insertAtSlot(n.children) } : n])),
        [id]: { name, children: [] },
      },
    };

    const next = planFolderMove(withFolder, { selectedIds: mapped, targetFolderId: id, insertIndex: 0 });
    commitManifest(next, () => {
      rekeyUiState(idMap);
      sel.select(mapped);
      setExpandedFolders((prev) => new Set(prev).add(id));
      setEditingId(id);
    });
  }, [sel, itemById, treeItems, treeRootIds, manifest, commitManifest, rekeyUiState, view]);

  /** Folders use folder-delete semantics (no file touched), components use the
   *  existing per-file delete. ONE takeSnapshot for the whole batch. */
  /**
   * task-207 Task 12: promote a component into the sq/ folder so it shows in
   * the post editor's `/` menu — or take it back out. The file MOVES; the
   * scan refresh repoints everything that keys off the path.
   *
   * Both runtimes: local moves within the project's src/components/sq/, WC
   * within the built-in library's library/sq/ (useComponentFileOps picks).
   * A refusal carries its actual reason when one is known (reserved system
   * name, occupied destination, half-landed move rolled back) and we show it
   * verbatim; only a reason-less endpoint failure falls back to the generic
   * copy — still never inventing a cause. A success can carry a warning (the
   * running preview could not mirror the move and needs a reload).
   */
  const handlePromoteComponent = useCallback(async (componentPath: string, promote: boolean) => {
    const res = await componentFiles.promote(componentPath, promote);
    if (!res.ok) {
      toast.error(res.reason ?? (promote
        ? 'Could not add this component to the menu — the name may already be in use'
        : 'Could not remove this component from the menu'));
      return;
    }
    if (res.warning) toast(res.warning);
    // Repoint doc instances (componentPath/astroSource) at the moved file so
    // ↗ go-to-source and manifest lookups keep resolving (finding 26).
    dispatch({ type: 'REMAP_COMPONENT_SOURCE', oldPath: componentPath, newPath: res.path });
    refresh();
  }, [componentFiles, refresh, dispatch]);

  const handleDeleteSelection = useCallback(async () => {
    const items = sel.selectedIds.map((id) => itemById.get(id)).filter((i): i is AssetTreeItem => !!i);
    if (items.length === 0) return;

    const { manifest: base, idMap } = materializeTree(manifest, { items: treeItems, rootIds: treeRootIds });
    let nextManifest = base;
    let touchedManifest = false;
    for (const item of items) {
      if (item.kind !== 'folder') continue;
      const after = deleteFolder(nextManifest, idMap.get(item.id) ?? item.id);
      if (after !== nextManifest) { nextManifest = after; touchedManifest = true; }
    }

    // Cards go through deleteCards: the lists rendering them switch cards in the
    // same journaled batch (one ⌘Z). The Blog's basic BlogCard is never deleted.
    const isCard = (i: AssetTreeItem) => !!i.component && !!allCardAssignments().get(i.component.path)?.card;
    const fieldsOf = (c: string) => contentCollections.find((x) => x.name === c)?.inferredFields ?? [];
    const cardFiles = items.filter(isCard).map((i) => i.component!.path).filter((f) => f !== CARD_FILE);
    if (cardFiles.length) await deleteCards({ cardFiles, assignments: allCardAssignments(), fieldsOf, takeSnapshot, claimSnapshot });
    const comps = items.filter((i) => i.kind === 'component' && i.component && !isCard(i));
    const deleted: Array<{ name: string; componentPath: string; content: string }> = [];
    for (const item of comps) {
      const componentPath = item.component!.path;
      const content = await componentFiles.remove(componentPath);
      if (content !== null) deleted.push({ name: item.name, componentPath, content });
    }

    if (!touchedManifest && deleted.length === 0) { sel.clear(); return; }

    takeSnapshot({
      reverse: () => {
        // Back in its own folder under src/components, not the root (#11).
        for (const d of deleted) componentFiles.create(d.name, d.content, d.componentPath.replace(/^src\/components\//, '').replace(/\/?[^/]*$/, ''));
      },
      forward: () => {
        for (const d of deleted) componentFiles.remove(d.componentPath);
      },
    });
    const snapshot = claimSnapshot();
    const finish = () => { rekeyUiState(idMap); sel.clear(); };
    if (touchedManifest) saveManifest(nextManifest, snapshot, finish);
    else { snapshot?.commit(); finish(); }
  }, [sel, itemById, treeItems, treeRootIds, manifest, saveManifest, takeSnapshot, claimSnapshot, rekeyUiState, componentFiles, contentCollections]);

  const treeCtx = useMemo<TreeCtx>(() => ({
    canEditTree, unavailablePaths,
    itemById,
    expanded: expandedFolders,
    onToggle: handleToggle,
    onRowClick: handleRowClick,
    isMultiSelected: sel.isSelected,
    onArmContextMenu: handleArmContextMenu,
    selectionCount: sel.selectedIds.length,
    onNewFolderFromSelection: handleNewFolderFromSelection,
    onDeleteSelection: handleDeleteSelection,
    onSetDynamic: handleSetDynamic,
    forcedDynamicIds,
    dynamicIndex,
    onPromoteComponent: handlePromoteComponent,
    activeComponentPath,
    onSelectComponent,
    editingId,
    onStartEditing: handleStartEditing,
    onFinishEditing: handleFinishEditing,
    editorRootId,
    selectedKey,
  }), [
    canEditTree, unavailablePaths, itemById, expandedFolders, handleToggle, handleRowClick, sel.isSelected, sel.selectedIds.length,
    handleArmContextMenu, handleNewFolderFromSelection, handleDeleteSelection, handleSetDynamic,
    forcedDynamicIds, dynamicIndex, handlePromoteComponent,
    activeComponentPath, onSelectComponent,
    editingId, handleStartEditing, handleFinishEditing, editorRootId, selectedKey,
  ]);

  return (
    <SortableTreeProvider
      items={view.items}
      rootIds={view.rootIds}
      dragType={DRAG_TYPES.ASSETS_PANEL}
      foreignDrag={layersDrag}
      onMove={(...args) => { if (canEditTree) handleMove(...args); }}
    >
      <div ref={containerRef} className="flex flex-col h-full">
        {/* Variables Section */}
        <div className="flex flex-col shrink-0 overflow-hidden" style={{ height: varsHeight }}>
          <Row
            title="Variables"
            size="sm"
            className="pl-3 pr-1"
            right={
              <Button variant="ghost" size="sm" iconOnly title="Add collection" onClick={handleAddCollection}>
                <PlusIcon className="w-4 h-4" />
              </Button>
            }
          />
          <div className="flex-1 overflow-y-auto scrollbar-thin px-1">
            {collections.map(col => (
              <VariableCollectionRow
                key={col.id}
                id={col.id}
                name={col.name}
                isSelected={activeCollectionId === col.id}
                isEditing={editingCollectionId === col.id}
                canDelete={collections.length > 1}
                onSelect={() => handleSelectCollection(col.id)}
                onStartEditing={() => setEditingCollectionId(col.id)}
                onFinishEditing={(name) => { handleRenameCollection(col.id, name); setEditingCollectionId(null); }}
                onDelete={() => handleDeleteCollection(col.id)}
              />
            ))}
          </div>
        </div>

        {/* Draggable divider */}
        <div className="peer h-0 relative z-10">
          <div
            className="absolute -top-1 left-0 right-0 h-2 cursor-row-resize"
            onMouseDown={(e) => { e.preventDefault(); setIsDraggingDivider(true); }}
          />
        </div>
        <div className={`border-t transition-colors ${isDraggingDivider ? 'border-overlay-selection' : 'border-stroke peer-hover:border-overlay-selection'}`} />

        {/* Components + Layers Section */}
        <div className="flex-1 min-h-0 flex flex-col">
          <Row
            title="Static"
            size="sm"
            className="pl-3 pr-1"
            right={[
              { type: 'custom', unboxed: true, node: <Button variant="ghost" size="sm" iconOnly
                title="Add folder" aria-label="Add folder" disabled={!canEditTree} onClick={handleCreateFolder}
                icon={<FolderPlusIcon className="w-4 h-4" />} /> },
              { type: 'custom', unboxed: true, node: <Button variant="ghost" size="sm" iconOnly
                title="Add component" aria-label="Add component" disabled={!canCreate} onClick={handleCreateComponent}
                icon={<PlusIcon className="w-4 h-4" />} /> },
            ]}
          />

          <div className="flex-1 overflow-y-auto scrollbar-thin px-1 pb-1">
          {(error || isLoading) && <OperationNotice title={error ? 'Project components are unavailable.' : 'Loading project components…'}
            detail={error ? 'Retry to load current components. Existing project rows cannot be opened until the list is available.' : undefined}
            action={error ? { label: 'Retry', onClick: refresh } : undefined} />}
          {folderIssue && <OperationNotice
            title={folderIssue.outcome === 'not-applicable' ? 'Component folders are unavailable.'
              : folderIssue.outcome === 'no-write' ? 'Folder changes could not be saved.' : 'Folder changes have not been confirmed.'}
            detail={folderIssue.outcome === 'not-applicable' ? 'Retry to load the folder organization.'
              : folderIssue.outcome === 'no-write' ? 'The previous folder organization is unchanged. Try your change again.'
              : folderIssue.outcome === 'unknown' ? 'The request may have changed the project. Your folder draft is retained; another write cannot safely run yet.'
              : 'Your folder draft is retained and will be written when the preview catches up.'}
            action={folderIssue.recover === 'none' ? undefined : folderIssue.recover === 'read-again' ? { label: 'Retry', onClick: reloadFolders }
              : folderIssue.recover === 'retry-save' ? { label: 'Retry save', busy: foldersSaving, onClick: () => { void retryFolders().catch(() => {}); } }
              : { label: 'Help', onClick: () => { window.open('/help.html#recovery', '_blank', 'noopener,noreferrer'); } }}
          />}
          {!manifestLoaded && !folderIssue && <OperationNotice title="Loading component folders…" />}
          {manifestLoaded && !isLoading && !error && treeItems.length === 0 && <EmptyState title="No components yet" />}
          <SortableContext items={manifestLoaded ? staticIds : []} strategy={verticalListSortingStrategy}>
            {(manifestLoaded ? staticIds : []).map((id) => (
              <TreeNode key={id} id={id} depth={0} ctx={treeCtx} />
            ))}
          </SortableContext>

          {manifestLoaded && dynamicIds.length > 0 && (
            <>
              {/* Data-bound components (blog collections, database tables).
                  Hidden entirely when a project has none — an empty header is
                  chrome that says nothing. */}
              <Row title="Dynamic" size="sm" className="pl-2 pr-1 mt-2" hover={false} />
              <SortableContext items={dynamicIds} strategy={verticalListSortingStrategy}>
                {dynamicIds.map((id) => (
                  <TreeNode key={id} id={id} depth={0} ctx={treeCtx} />
                ))}
              </SortableContext>
            </>
          )}

          {/* Blog (owner 2026-10-09): every collection's folder (cards +
              related components, derived from their code) + the shared blog
              pieces. Never a page list — Assets holds components only. */}
          {blogIds.length > 0 && (
            <>
              <Row title="Blog" size="sm" className="pl-2 pr-1 mt-2" hover={false} />
              <SortableContext items={blogIds} strategy={verticalListSortingStrategy}>
                {blogIds.map((id) => (
                  <TreeNode key={id} id={id} depth={0} ctx={treeCtx} />
                ))}
              </SortableContext>
            </>
          )}

          {/* Layouts. A FLAT list off useLayoutLibrary — deliberately not part
              of the folder tree above, so a layout is neither draggable nor a
              drop target, and there is nothing to guard against. The header
              renders even with zero layouts because it hosts the + button. */}
          <Row title="Layouts" size="sm" className="pl-2 pr-1 mt-2" hover={false}
            right={[{
              type: 'custom', unboxed: true, node: (
                <Button
                  variant="ghost" size="sm" iconOnly
                  title="Add layout" aria-label="Add layout"
                  icon={<PlusIcon className="w-4 h-4" />}
                  disabled={!canCreate}
                  onClick={handleCreateLayout}
                />
              ),
            }]}
          />
          {(layoutsError || layoutsLoading) && <OperationNotice title={layoutsError ? 'Project layouts are unavailable.' : 'Loading project layouts…'}
            detail={layoutsError ? 'Retry to load current layouts. Existing layout rows cannot be opened until the list is available.' : undefined}
            action={layoutsError ? { label: 'Retry', onClick: refreshLayouts } : undefined} />}
          {displayLayouts.map((l) => {
            const scanned = layoutToScannedComponent(l);
            const isActiveLayout = activeComponentPath === scanned.path;
            return (
              <Fragment key={scanned.path}>
                <LayoutRow
                  layout={l}
                  disabled={!!layoutsError || layoutsLoading}
                  selected={docRowSelected(isActiveLayout, selectedKey, editorRootId)}
                  onSelect={() => onSelectComponent(scanned)}
                  onDelete={() => { void handleDeleteLayout(l); }}
                />
                {/* The opened layout's Layers tree — same nested mount the
                    folder-tree ComponentNode uses; without it the layout view
                    has NO Layers anywhere (owner report 2026-08-23). */}
                {isActiveLayout && (
                  <ElementsTree baseDepth={1} viewedComponentFile={scanned.path} dynamicIndex={dynamicIndex} />
                )}
              </Fragment>
            );
          })}
          </div>
        </div>

        {/* task-135/144: project media library — local folder files or the WC
            Dexie store; the section resolves its own source and renders
            nothing for runtimes without one. */}
        <MediaSection />

        {isDraggingDivider && (
          <div className="fixed inset-0 z-50 cursor-row-resize" />
        )}
      </div>
    </SortableTreeProvider>
  );
}
