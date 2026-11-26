/**
 * Wheel forwarding (zoom/pan) and element drag-drop: slot drop, reparent,
 * grid placement, and flow reorder. Moved verbatim from ViewportFrame.tsx.
 */
import { slotNameForDropTarget, draggedElementId } from '@/utils/slotDrop';
import { t } from '@/i18n';
import { dispatchSetChildOrder, isValidChildOrderParentKey } from '@/utils/dispatchSetChildOrder';
import { clampCellToSpan, writeGridPlacement, gridOfChild } from '@/utils/gridGeometry';
import { planDisplaced } from '@/utils/gridSwap';
import { sameTokenSet } from '@/core/classes/index';
import { selectRootElementIds, selectProjectId } from '@/store/selectors';
import { collectOrderCommands } from '@/utils/masterOrderWrite';
import { acceptEditorCommands } from '@/store/commandGesture';
import type { EditorCommand } from '@/store/types';
import toast from 'react-hot-toast';
import { isLocalProjectId } from '@/utils/localMode';
import {
  isSourceKeyedElementKey,
  moveLocalElement,
  planGutterLocalMove,
  planLocalReparentInsert,
} from '@/components/Editor/localStructuralOps';
import { clearSelectedCellGeometry } from '@/store/gridGeometryStore';
import type { WheelPayload, DragElementExitIframePayload, DragElementDropPayload } from '@/bridge';
import type { ViewportMessageContext } from './context';
import { isRootLevelElement, deduplicateKeysToIds } from './elementIds';

/** Build grid placement tokens (e.g., "md:col-start-2 md:col-span-3"). */
export function buildGridPlacementTokens(
  bpPrefix: string,
  col: number,
  row: number,
  colSpan: number,
  rowSpan: number,
): { gridColumn: string; gridRow: string } {
  const colTokens = [`${bpPrefix}col-start-${col + 1}`];
  if (colSpan > 1) colTokens.push(`${bpPrefix}col-span-${colSpan}`);
  const rowTokens = [`${bpPrefix}row-start-${row + 1}`];
  if (rowSpan > 1) rowTokens.push(`${bpPrefix}row-span-${rowSpan}`);
  return { gridColumn: colTokens.join(' '), gridRow: rowTokens.join(' ') };
}

export function handleWheel(ctx: ViewportMessageContext, payload: unknown): void {
  const p = payload as WheelPayload;

  // Convert iframe coordinates to screen coordinates
  // clientX/clientY from iframe are relative to iframe's viewport
  // We need to add iframe's position to get screen coordinates
  const iframe = ctx.refs.iframe.current;
  if (!iframe) return;

  if (p.ctrlKey || p.metaKey) {
    // Zoom needs the anchor point — read the rect only on this (rare) path.
    // task-120 (5.3): the pan path used to force a layout read per wheel
    // message; pan only needs deltas.
    const iframeRect = iframe.getBoundingClientRect();
    const screenX = iframeRect.left + p.clientX * ctx.refs.scaleProps.current;
    const screenY = iframeRect.top + p.clientY * ctx.refs.scaleProps.current;
    ctx.refs.onZoom.current?.(screenX, screenY, p.deltaY);
  } else {
    // Pan - call Canvas.tsx pan handler directly
    ctx.refs.onPan.current?.(p.deltaX, p.deltaY);
  }
}

export function handleDragElementExitIframe(ctx: ViewportMessageContext, payload: unknown): void {
  const exitPayload = payload as DragElementExitIframePayload;
  ctx.actions.setReparentDragKey(exitPayload.key);
}

/**
 * Bridge announced the drag mode: a grid child left/re-entered its parent
 * ('reparent' / 'grid'), or its grid is one column and reorders like a stack
 * ('flow'). The grid overlay and the grid drop path must follow the bridge's
 * ACTUAL mode, not the host's guess from stale geometry.
 */
export function handleDragModeChanged(ctx: ViewportMessageContext, payload: unknown): void {
  const mode = (payload as { mode?: 'grid' | 'reparent' | 'flow' })?.mode ?? null;
  ctx.refs.dragMode.current = mode;
  ctx.actions.setIsGridOverlayVisible(mode === 'grid');
}

/** task-148: canvas drag of a source-keyed element in the LOCAL runtime — the
 *  element has no doc node, so the doc reorder/reparent below can't touch it.
 *  Both gestures now route to the SAME structural writeMove the Layers panel
 *  and gutter handles use (moveLocalElement): the drop slot is expressed as
 *  before/after the nearest anchorable neighbor (planGutterLocalMove /
 *  planLocalReparentInsert) and the real file is written; the HMR reload then
 *  re-renders and rescans. Grid drops stay on the class path — class writers
 *  already work in local mode.
 *
 *  Undo: ctx.actions.pushStructuralUndo rides into moveLocalElement, so
 *  canvas-drag local moves record their inverse and are ⌘Z-able, same as the
 *  Layers/gutter paths. */
function isLocalSourceKeyedDrop(ctx: ViewportMessageContext, key: string): boolean {
  return isLocalProjectId(selectProjectId(ctx.env.doc) ?? '') && isSourceKeyedElementKey(key);
}

/** Scan tree map for moveLocalElement's task-148 usage re-target. */
function scannedByKeyMap(ctx: ViewportMessageContext) {
  return new Map(ctx.refs.scannedElements.current.map((el) => [el.key, el]));
}

export async function handleDragElementDrop(ctx: ViewportMessageContext, payload: unknown): Promise<void> {
  try {
  const p = payload as DragElementDropPayload;

  // Clear reparent drag state on any drop
  ctx.actions.setReparentDragKey(null);
  ctx.actions.setIsGridOverlayVisible(false);

  if (p.cancelled) return;

  // --- Slot drop: dropping a content root onto a layout slot re-homes it
  // via SET_ELEMENT_SLOT_NAME (flat storage), NOT a reparent. The Yjs
  // change re-splices content into the new slot on the next RENDER. ---
  // (Precedes the task-133 local gate below, but is unreachable in local mode:
  // no layout masters there → layoutRootKey is null → slotNameForDropTarget
  // returns null and the drop falls through to the gated reparent branch.)
  if (p.reparented && ctx.refs.currentPageId.current) {
    const slotName = slotNameForDropTarget(
      p.newParentKey, ctx.refs.scannedElements.current, ctx.refs.layoutRootKey.current,
    );
    if (slotName !== null) {
      ctx.actions.takeSnapshot();
      await acceptEditorCommands(ctx.env.doc, [{ type: 'SET_ELEMENT_SLOT_NAME', elementId: draggedElementId(p.key), slotName }], ctx.actions.claimSnapshot?.());
      return;
    }
  }

  // --- Reparent drop: dispatch REPARENT_ELEMENT and sync DOM ---
  if (p.reparented && ctx.refs.currentPageId.current) {
    if (isLocalSourceKeyedDrop(ctx, p.key)) {
      // task-148: same structural writeMove the Layers drop uses. The bridge
      // has NOT moved the DOM yet in reparent mode (the WC path syncs it via
      // REPARENT_ELEMENT_DOM below), so a refusal/failure needs no snap-back;
      // on success the HMR reload renders the new position.
      const newParentKey = p.newParentKey ?? null;
      const childKeys = ctx.refs.scannedElements.current
        .filter((el) => el.parentKey === newParentKey)
        .map((el) => el.key);
      const plan = planLocalReparentInsert(newParentKey, childKeys, p.insertIndex, p.key);
      if (plan) {
        void moveLocalElement({
          key: p.key,
          targetKey: plan.targetKey,
          position: plan.position,
          pushUndo: ctx.actions.pushStructuralUndo,
          scannedByKey: scannedByKeyMap(ctx),
        });
      }
      return;
    }
    // Persist current child order before snapshot so undo can restore original position.
    // Without this, REPARENT_ELEMENT can't find the element in childOrders (never set),
    // and the renderState key won't change — causing RENDER to skip on undo.
    const actions: EditorCommand[] = [];
    const reparentedEl = ctx.refs.scannedElements.current.find(el => el.key === p.key);
    if (reparentedEl && isValidChildOrderParentKey(reparentedEl.parentKey)) {
      const siblings = ctx.refs.scannedElements.current.filter(el => el.parentKey === reparentedEl.parentKey);
      dispatchSetChildOrder(
        action => { actions.push(action); return true; }, ctx.refs.scannedElements.current, ctx.refs.currentPageId.current,
        reparentedEl.parentKey, siblings.map(el => el.key),
      );
    }


    ctx.actions.takeSnapshot();
    actions.push({
      type: 'REPARENT_ELEMENT',
      pageId: ctx.refs.currentPageId.current,
      elementKey: p.key,
      newParentKey: p.newParentKey,
      insertIndex: p.insertIndex,
    });
    await acceptEditorCommands(ctx.env.doc, actions, ctx.actions.claimSnapshot?.());

    // Sync DOM in iframe
    ctx.refs.iframe.current?.contentWindow?.postMessage({
      type: 'REPARENT_ELEMENT_DOM',
      payload: {
        key: p.key,
        newParentKey: p.newParentKey,
        insertIndex: p.insertIndex,
      }
    }, '*');

    // Request updated rect for selection overlay
    setTimeout(() => {
      ctx.refs.iframe.current?.contentWindow?.postMessage({
        type: 'REQUEST_ELEMENT_RECT',
        payload: { key: p.key }
      }, '*');
    }, 50);

    // Clear grid state (selected-cell store in lockstep — task-090 review)
    ctx.actions.setGridGeometry(null);
    clearSelectedCellGeometry();
    ctx.actions.setHighlightedGridCell(null);
    return;
  }

  const draggedEl = ctx.refs.scannedElements.current.find(el => el.key === p.key);
  if (!draggedEl) return;

  const siblings = ctx.refs.scannedElements.current.filter(el => el.parentKey === draggedEl.parentKey);
  const oldIndex = siblings.findIndex(el => el.key === p.key);
  if (oldIndex === -1) return;

  const isRootLevel = isRootLevelElement(draggedEl);

  // Grid detection must precede the order-persist below. Grid geometry
  // persists from element selection and can be stale for drags of elements
  // outside the grid — only treat this as a grid drop when the dragged
  // element is actually IN the current grid — and the bridge kept it in grid
  // mode (a one-column grid is a stack, mode 'flow': its drop is a reorder).
  const currentGridGeo = gridOfChild(ctx.refs.gridGeometry.current, p.key);
  const dragMode = ctx.refs.dragMode.current;
  const isGridDrop = !!currentGridGeo && dragMode !== 'reparent' && dragMode !== 'flow';

  // task-148: local + source-keyed FLOW reorder → the SAME structural
  // writeMove the gutter handles use (planGutterLocalMove expresses the
  // landing slot as before/after the nearest anchorable sibling). Must sit
  // after grid detection (grid drops are class-based and stay on the class
  // path) and before the snapshot/dispatch below (no doc node to dispatch
  // to). The bridge already moved the element in the DOM during the drag —
  // when there is no move to write (same slot / no anchor / refused / failed
  // write), snap the DOM back to the ORIGINAL sibling order so the canvas
  // doesn't lie about the file until the next reload. On success the write's
  // HMR reload re-renders the file's real order.
  if (!isGridDrop && isLocalSourceKeyedDrop(ctx, p.key)) {
    const siblingKeys = siblings.map(el => el.key);
    const snapBack = () => window.postMessage({
      type: 'REORDER_ELEMENTS_IN_IFRAME',
      payload: { elementIds: siblingKeys },
    }, '*');
    const plan = planGutterLocalMove(
      siblingKeys, oldIndex, Math.min(p.insertIndex, siblingKeys.length - 1),
    );
    if (!plan) {
      snapBack();
      return;
    }
    void moveLocalElement({
      key: p.key,
      targetKey: plan.targetKey,
      position: plan.position,
      pushUndo: ctx.actions.pushStructuralUndo,
      scannedByKey: scannedByKeyMap(ctx),
    }).then((ok) => { if (!ok) snapBack(); });
    return;
  }

  // takeSnapshot BEFORE any Yjs mutation (undo's iron rule). The flow-reorder
  // path used to pre-persist CURRENT child order here, before the snapshot, to
  // "let undo restore it" — but that fired a SET_CHILD_ORDER user transaction
  // without an armed snapshot (tripping the [undo] mutation-without-takeSnapshot
  // detector and folding the move into the PREVIOUS undo step). It was also
  // redundant: createSnapshot captures page.childOrders directly, and
  // applySnapshot's delete-when-absent semantics restore the original order on
  // undo (first reorder → childOrders deleted → natural order; later reorder →
  // prior childOrders captured and restored). The single reorder dispatch below
  // is the only child-order mutation, and it follows this snapshot.
  // NOTE: the REPARENT path above keeps its own pre-snapshot persist — there it
  // is functionally required (REPARENT_ELEMENT reads childOrders to splice).
  ctx.actions.takeSnapshot();

  // --- Grid drop: place element at target cell, then exit ---
  const currentGridCell = ctx.refs.highlightedGridCell.current;
  if (currentGridGeo && isGridDrop) {
    if (currentGridCell) {
      const draggedCell = currentGridGeo.cells.find(c => c.key === p.key);
      const bpPrefix = ctx.refs.breakpoint.current === 'base' ? '' : `${ctx.refs.breakpoint.current}:`;

      const colSpan = draggedCell?.colSpan ?? 1;
      const rowSpan = draggedCell?.rowSpan ?? 1;
      const clamped = clampCellToSpan(currentGridGeo, currentGridCell, colSpan, rowSpan);
      const tokens = buildGridPlacementTokens(bpPrefix, clamped.col, clamped.row, colSpan, rowSpan);
      const actions: Extract<EditorCommand, { type: 'GRID_PLACE_ELEMENT' }>[] = [{ type: 'GRID_PLACE_ELEMENT', key: p.key, ...tokens }];

      // Whoever the drop lands on moves out (utils/gridSwap.planDisplaced):
      // one clean swap into the freed cell, the rest back to auto-flow — a
      // span-only placement drops the pin and the grid re-places the child.
      for (const { cell, to } of planDisplaced(currentGridGeo.cells, p.key, { ...clamped, colSpan, rowSpan })) {
        if (to) {
          actions.push({ type: 'GRID_PLACE_ELEMENT', key: cell.key, ...buildGridPlacementTokens(bpPrefix, to.col, to.row, cell.colSpan, cell.rowSpan) });
          continue;
        }
        const auto = { gridColumn: `${bpPrefix}col-span-${cell.colSpan}`, gridRow: `${bpPrefix}row-span-${cell.rowSpan}` };
        const classes = ctx.actions.getClassesFromYjs(cell.key);
        const unpinned = writeGridPlacement(classes, auto.gridColumn, auto.gridRow, false);
        if (!sameTokenSet(classes.split(/\s+/).filter(Boolean), unpinned)) actions.push({ type: 'GRID_PLACE_ELEMENT', key: cell.key, ...auto });
      }

      await acceptEditorCommands(ctx.env.doc, actions, ctx.actions.claimSnapshot?.());
      for (const action of actions) ctx.actions.syncClassToIframe(action.key);

      ctx.actions.refreshGridState(p.key);
    }

    ctx.actions.setHighlightedGridCell(null);
    return;
  }

  // --- Flow reorder: splice dragged element into new position ---
  const reordered = siblings.map(el => el.key);
  reordered.splice(oldIndex, 1);
  reordered.splice(Math.min(p.insertIndex, reordered.length), 0, p.key);

  // Persist new order in Yjs
  if (ctx.refs.currentPageId.current) {
    const actions: EditorCommand[] = [];
    if (isRootLevel) {
      const dedupedIds = deduplicateKeysToIds(reordered);
      // Merge with existing rootElementIds to avoid losing non-visible elements.
      // The drag only sees local siblings — other elements (in different containers
      // or not yet scanned) must be preserved.
      const currentRootIds = selectRootElementIds(ctx.env.doc, ctx.refs.currentPageId.current!);
      const dedupedSet = new Set(dedupedIds);
      let mergedIds: string[];

      if (dedupedIds.length >= currentRootIds.length) {
        // All root elements are visible — use the reordered list directly
        mergedIds = dedupedIds;
      } else {
        // Only a subset is visible — merge reordered subset into existing list.
        // Replace each visible ID's slot with the next reordered ID in sequence.
        const reorderedQueue = [...dedupedIds];
        mergedIds = [];
        for (const id of currentRootIds) {
          if (dedupedSet.has(id)) {
            if (reorderedQueue.length > 0) {
              mergedIds.push(reorderedQueue.shift()!);
            }
          } else {
            mergedIds.push(id);
          }
        }
        // Append any remaining (e.g. newly reparented element)
        mergedIds.push(...reorderedQueue);
      }

      actions.push({
        type: 'REORDER_PAGE_ELEMENTS',
        pageId: ctx.refs.currentPageId.current,
        elementIds: mergedIds,
      });
      // Canvas reorders must persist like Layers reorders: the master's file
      // order (deferred queue) — the doc-only dispatch above reset on reopen
      // (owner's canvas drags, proven live 2026-08-27).
    } else if (draggedEl.parentKey) {
      dispatchSetChildOrder(
        action => { actions.push(action); return true; }, ctx.refs.scannedElements.current, ctx.refs.currentPageId.current,
        draggedEl.parentKey, reordered,
      );
      // Page layout-chrome children reorder here (chrome root is their parent).
    }
    await acceptEditorCommands(ctx.env.doc, actions, ctx.actions.claimSnapshot?.(), collectOrderCommands(
      ctx.env.doc, ctx.refs.currentPageId.current, reordered, siblings.map(el => el.key), { rootLevel: isRootLevel }));
  }

  window.postMessage({ type: 'REORDER_ELEMENTS_IN_IFRAME', payload: { elementIds: reordered } }, '*');

  // Request updated rect for selection overlay after DOM settles
  setTimeout(() => {
    ctx.refs.iframe.current?.contentWindow?.postMessage({
      type: 'REQUEST_ELEMENT_RECT',
      payload: { key: p.key }
    }, '*');
  }, 50);

  ctx.actions.setGridGeometry(null);
  clearSelectedCellGeometry(); // lockstep with the geometry clear (task-090 review)
  ctx.actions.setHighlightedGridCell(null);
  } catch (error) { toast.error(t("Move was not saved: {0}", { 0: error instanceof Error ? error.message : String(error) })); }
}
