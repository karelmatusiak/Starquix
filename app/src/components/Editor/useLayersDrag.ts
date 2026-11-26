// src/components/Editor/useLayersDrag.ts
/**
 * SINGLE source of truth for Layers-tree (LAYERS_PANEL) drag handling — used by
 * BOTH the main editor (Editor.tsx's DndContext) AND the master/component editor
 * (AssetsPanel's SortableTreeProvider, via its foreign-drag passthrough). Before
 * this, the logic lived inline in Editor only, so dragging element rows in the
 * AssetsPanel's nested ElementsTree was swallowed by its own DndContext
 * (SortableTree returns early on a non-asset drag type) and never reparented.
 *
 * Reuses the real path (planLayersDrop + REPARENT_ELEMENT + dropZoneStore) — no
 * parallel system. See docs/plans/task-078-position-aware-drop-ledger.md and
 * docs/plans/task-078-layers-drag-reparent-ledger.md.
 */
import { useCallback, useRef } from 'react';
import { t } from '@/i18n';
import type { DragStartEvent, DragMoveEvent, DragEndEvent } from '@dnd-kit/core';
import toast from 'react-hot-toast';
import { useYjsValue } from '@/store';
import { useEditorDoc } from '@/store/hooks';
import { selectCurrentPageId, selectProjectId } from '@/store/selectors';
import { isLocalProjectId } from '@/utils/localMode';
import {
  moveLocalElement,
  isSourceKeyedElementKey,
  layersZoneToStructuralPosition,
  LOCAL_GROUP_BLOCKED,
  LOCAL_MIXED_DRAG_BLOCKED,
} from '@/components/Editor/localStructuralOps';
import { useReorderElements } from '@/hooks';
import { useScannedElementsRef } from '@/context/SelectionContext';
import { useUndoContext } from '@/context/UndoContext';
import { planLayersDrop, zoneFromRelY, isContainerNode } from '@/store/planLayersDrop';
import { planGroupMove, executeGroupMove } from '@/store/multiSelectMove';
import { isWrapperKey } from '@/store/keyKind';
import { dispatchSetChildOrder, isValidChildOrderParentKey, sharedInstanceRoot } from '@/utils/dispatchSetChildOrder';
import { collectOrderCommands } from '@/utils/masterOrderWrite';
import { acceptEditorCommands } from '@/store/commandGesture';
import type { EditorCommand } from '@/store/types';
import type { MaterializationCommand } from '@/services/durableEdits/types';
import { setDropZone, clearDropZone } from '@/components/LayersPanel/dropZoneStore';
import { DRAG_TYPES } from '@/types/drag';
import type { TreeNode } from '@/utils/treeUtils';


/** Send the new element order to the iframe for immediate visual update. */
function sendReorderToIframe(elementKeys: string[]): void {
  window.postMessage({
    type: 'REORDER_ELEMENTS_IN_IFRAME',
    payload: { elementIds: elementKeys },
  }, '*');
}

export interface LayersDragHandlers {
  onDragStart: (event: DragStartEvent) => void;
  onDragMove: (event: DragMoveEvent) => void;
  onDragEnd: (event: DragEndEvent) => Promise<void>;
  onDragCancel: () => void;
}

/**
 * @param opts.onReorderPending optional side effect after a reparent/reorder
 *   (Editor uses it to hide gutter handles until the iframe rescans; AssetsPanel
 *   has no gutter, so it passes nothing).
 */

export function useLayersDrag(opts?: { onReorderPending?: () => void; viewedComponentFile?: string | null }): LayersDragHandlers {
  const doc = useEditorDoc();
  const currentPageId = useYjsValue(selectCurrentPageId);
  const { rootElements: gutterRootElements, reorderRootElementsByKeys, reorderChildElements } = useReorderElements();
  const { scannedElementsRef, scannedByKeyRef } = useScannedElementsRef();
  const { takeSnapshot, claimSnapshot, pushStructuralUndo } = useUndoContext();
  // STATIC row geometry captured at drag start (dnd-kit's live over.rect is
  // shifted mid-drag by verticalListSortingStrategy and is unreliable).
  const dragRowSnapshotRef = useRef<Map<string, { top: number; height: number }>>(new Map());
  const onReorderPending = opts?.onReorderPending;
  const viewedComponentFile = opts?.viewedComponentFile ?? null;

  const reparentElement = useCallback(
    async (elementKey: string, newParentKey: string | null, insertIndex: number, currentParentKey?: string | null, currentSiblingKeys?: string[], o?: { snapshot?: boolean; collect?: EditorCommand[] }) => {
      if (!currentPageId) return;
      const actions: EditorCommand[] = [];
      // Persist current child order before snapshot so undo can restore position
      // (REPARENT_ELEMENT reads childOrders; without this RENDER skips on undo).
      if (isValidChildOrderParentKey(currentParentKey) && currentSiblingKeys) {
        dispatchSetChildOrder(action => { actions.push(action); return true; }, scannedElementsRef.current, currentPageId, currentParentKey, currentSiblingKeys);
      }
      if (o?.snapshot !== false) takeSnapshot();
      actions.push({ type: 'REPARENT_ELEMENT', pageId: currentPageId, elementKey, newParentKey, insertIndex });
      if (o?.collect) { o.collect.push(...actions); return; }
      await acceptEditorCommands(doc, actions, claimSnapshot());
      window.postMessage({ type: 'REPARENT_ELEMENT_IN_IFRAME', payload: { key: elementKey, newParentKey, insertIndex } }, '*');
      onReorderPending?.();
    },
    [currentPageId, doc, takeSnapshot, claimSnapshot, onReorderPending, scannedElementsRef],
  );

  const onDragStart = useCallback((event: DragStartEvent) => {
    if (event.active.data.current?.type !== DRAG_TYPES.LAYERS_PANEL) return;
    const snap = new Map<string, { top: number; height: number }>();
    document.querySelectorAll('[data-testid="layers-panel"] [data-layer-key]').forEach((el) => {
      const key = el.getAttribute('data-layer-key');
      if (!key) return;
      const r = el.getBoundingClientRect();
      snap.set(key, { top: r.top, height: r.height });
    });
    dragRowSnapshotRef.current = snap;
  }, []);

  const onDragMove = useCallback((event: DragMoveEvent) => {
    if (event.active.data.current?.type !== DRAG_TYPES.LAYERS_PANEL) return;
    const over = event.over;
    if (!over) { clearDropZone(); return; }
    const ae = event.activatorEvent as PointerEvent | undefined;
    const pointerY = (ae?.clientY ?? 0) + (event.delta?.y ?? 0);
    const snap = dragRowSnapshotRef.current.get(String(over.id));
    const relY = snap && snap.height > 0 ? (pointerY - snap.top) / snap.height : 0.5;
    setDropZone(String(over.id), zoneFromRelY(relY));
  }, []);

  const onDragEnd = useCallback(
    async (event: DragEndEvent) => {
      try {
      clearDropZone();
      const { active, over } = event;
      if (active.data.current?.type !== DRAG_TYPES.LAYERS_PANEL) return;
      if (!over || active.id === over.id) return;

      // task-133 Task 6: local runtime (files-truth) — source-keyed rows have
      // NO doc nodes; a Layers drop maps 1:1 onto a structural writeMove
      // (before/after the over-row; inside → inside-end, leaf demotes to
      // after, same rule as planLayersDrop). No doc dispatch, no snapshot
      // (Task 8 wires undo via inverse writes). Cycle drops (into own
      // subtree) are refused server-side by the plugin guard → failure toast.
      if (isLocalProjectId(selectProjectId(doc) ?? '')) {
        const activeKey = String(active.id);
        const overKey = String(over.id);
        const localGroupKeys = active.data.current?.groupKeys as string[] | undefined;
        if (localGroupKeys && localGroupKeys.length > 1 && localGroupKeys.some(isSourceKeyedElementKey)) {
          // Sequencing rule: after the first write every other member's
          // file:line is stale — a group loop would move the WRONG lines.
          toast(LOCAL_GROUP_BLOCKED);
          return;
        }
        const activeSourceKeyed = isSourceKeyedElementKey(activeKey);
        const overSourceKeyed = isSourceKeyedElementKey(overKey);
        if (activeSourceKeyed !== overSourceKeyed) {
          // Mixed drag (drawn ↔ source row): neither the doc path nor the
          // file writer can express it — honest gate, not the misleading
          // "no source location" toast moveLocalElement would raise.
          toast(LOCAL_MIXED_DRAG_BLOCKED);
          return;
        }
        if (activeSourceKeyed && overSourceKeyed) {
          const ae = event.activatorEvent as PointerEvent | undefined;
          const pointerY = (ae?.clientY ?? 0) + (event.delta?.y ?? 0);
          const snap = dragRowSnapshotRef.current.get(overKey);
          const relY = snap && snap.height > 0 ? (pointerY - snap.top) / snap.height : 0.5;
          const overNode = over.data.current?.node as TreeNode | undefined;
          const position = layersZoneToStructuralPosition(zoneFromRelY(relY), overNode);
          void moveLocalElement({ key: activeKey, targetKey: overKey, position, pushUndo: pushStructuralUndo, scannedByKey: scannedByKeyRef.current }).then((ok) => {
            if (ok) onReorderPending?.();
          });
          return;
        }
        // Both rows doc-backed (drawn ghosts) → existing doc path below.
      }

      // Group move (task-076): drag a member row → move the WHOLE selection as a
      // contiguous block. planGroupMove decides reparents + final order.
      const groupKeys = active.data.current?.groupKeys as string[] | undefined;
      if (groupKeys && groupKeys.length > 1) {
        const overKey = String(over.id);
        const overNode = over.data.current?.node;
        const isContainerTarget = isContainerNode(overNode);
        let target: { parentKey: string | null; insertIndex: number };
        if (isContainerTarget && !groupKeys.includes(overKey)) {
          target = { parentKey: overKey, insertIndex: overNode.children?.length ?? 0 };
        } else {
          const scanned = scannedElementsRef.current;
          const targetParentKey = scanned.find((el) => el.key === overKey)?.parentKey ?? null;
          const idx = scanned.filter((el) => el.parentKey === targetParentKey).findIndex((el) => el.key === overKey);
          target = { parentKey: targetParentKey, insertIndex: Math.max(idx, 0) };
        }
        const plan = planGroupMove({ groupKeys, target, scannedElements: scannedElementsRef.current });
        const actions: EditorCommand[] = [];
        const sourceCommands: MaterializationCommand[] = [];
        await executeGroupMove(plan, {
          takeSnapshot,
          reparentOne: (key, p, i, cp, cs) => reparentElement(key, p, i, cp, cs, { snapshot: false, collect: actions }),
          applyFinalOrder: async (parentKey, orderedKeys) => {
            const host = sharedInstanceRoot(orderedKeys);
            const scannedOrder = scannedElementsRef.current
              .filter((el) => orderedKeys.includes(el.key))
              .map((el) => el.key);
            sourceCommands.push(...collectOrderCommands(doc, currentPageId, orderedKeys, scannedOrder, {
              rootLevel: parentKey === null || isWrapperKey(parentKey),
              viewedComponentFile,
            }));
            if (host) {
              await reorderChildElements(host, orderedKeys, { snapshot: false, collect: actions });
            } else if (parentKey === null || isWrapperKey(parentKey)) {
              await reorderRootElementsByKeys(orderedKeys, { snapshot: false, collect: actions });
            } else {
              await reorderChildElements(parentKey, orderedKeys, { snapshot: false, collect: actions });
            }
          },
          onSkipped: (n) => toast(`${n} element${n === 1 ? '' : 's'} can't move there — they belong to a component`),
        });
        await acceptEditorCommands(doc, actions, claimSnapshot(), sourceCommands);
        for (const r of plan.reparents) window.postMessage({ type: 'REPARENT_ELEMENT_IN_IFRAME', payload: { key: r.key, newParentKey: r.newParentKey, insertIndex: r.insertIndex } }, '*');
        if (plan.finalOrder) sendReorderToIframe(plan.finalOrder.orderedKeys);
        onReorderPending?.();
        return;
      }

      // Single-row drag.
      const activeKey = String(active.id);
      const overKey = String(over.id);
      const parentKey: string | null = active.data.current?.parentKey ?? null;
      const siblingKeys: string[] | undefined = active.data.current?.siblingKeys;
      const overParentKey: string | null = over.data.current?.parentKey ?? null;
      const overSiblingKeys: string[] | undefined = over.data.current?.siblingKeys;
      const activeNode = active.data.current?.node as TreeNode;
      const overNode = over.data.current?.node as TreeNode | undefined;

      // Drop ZONE from the pointer Y vs the over-row's STATIC rect (snapshot).
      const ae = event.activatorEvent as PointerEvent | undefined;
      const pointerY = (ae?.clientY ?? 0) + (event.delta?.y ?? 0);
      const snap = dragRowSnapshotRef.current.get(overKey);
      const relY = snap && snap.height > 0 ? (pointerY - snap.top) / snap.height : 0.5;
      const position = zoneFromRelY(relY);

      const plan = planLayersDrop({
        activeKey, overKey, activeNode, overNode,
        activeParentKey: parentKey, activeSiblingKeys: siblingKeys,
        overParentKey, overSiblingKeys,
        rootKeys: gutterRootElements.map((el) => el.key),
        position,
      });

      if (plan.kind === 'noop') {
        if (plan.reason === 'cycle') toast("Can't move an element into itself.");
        return;
      }
      if (plan.kind === 'reparent') {
        await reparentElement(activeKey, plan.newParentKey, plan.insertIndex, parentKey, siblingKeys);
        return;
      }
      // reorder (same parent) — the opened master's own children, the root
      // list, or a nested parent.
      const host = sharedInstanceRoot(plan.orderedKeys);
      const sourceCommands = collectOrderCommands(doc, currentPageId, plan.orderedKeys, siblingKeys, {
        rootLevel: plan.parentKey === null || isWrapperKey(plan.parentKey),
        viewedComponentFile,
      });
      if (host) {
        await reorderChildElements(host, plan.orderedKeys, { sourceCommands });
      } else if (plan.parentKey === null || isWrapperKey(plan.parentKey)) {
        await reorderRootElementsByKeys(plan.orderedKeys, { sourceCommands });
      } else {
        await reorderChildElements(plan.parentKey, plan.orderedKeys, { sourceCommands });
      }
      sendReorderToIframe(plan.orderedKeys);
      onReorderPending?.();
      } catch (error) { toast.error(t("Move was not saved: {0}", { 0: error instanceof Error ? error.message : String(error) })); }
    },
    [doc, gutterRootElements, reorderRootElementsByKeys, reorderChildElements, reparentElement, takeSnapshot, claimSnapshot, pushStructuralUndo, scannedElementsRef, scannedByKeyRef, onReorderPending, viewedComponentFile],
  );

  const onDragCancel = useCallback(() => clearDropZone(), []);

  return { onDragStart, onDragMove, onDragEnd, onDragCancel };
}
