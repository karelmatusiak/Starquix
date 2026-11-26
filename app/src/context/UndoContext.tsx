// src/context/UndoContext.tsx
/**
 * Snapshot-based Undo/Redo
 *
 * Model:
 * - past: snapshots of previous states (before each undoable action)
 * - future: snapshots for redo
 * - No "current" variable - we capture Yjs state on-demand
 *
 * takeSnapshot() - called BEFORE an undoable action, records pending intent
 * Durable dispatch captures staged pre-edit state and commits it after acceptance
 * General undo/redo stages the restoration, then publishes and transfers stacks
 * Existing-file structural replay accepts its complete command group first
 * Page/content structural replay still uses the legacy fallback below
 */
import { awaitClassEditsInFlight, hasClassEditsInFlight } from '@/services/inFlightClassEdits';
import { t } from '@/i18n';
import React, { useContext, useState, useCallback, type ReactNode } from 'react';
import * as Y from 'yjs';
import toast from 'react-hot-toast';
import { useEditorDoc } from '@/store/EditorContext';
import { acceptStructuralReplay } from '@/services/durableEdits/structuralReplayAcceptance';
import { invertIdentityMaps } from '@/services/durableEdits/sourceIdentity';
import {
  isStructuralUndoEntry,
  type PushStructuralUndo,
  type StructuralUndoRecord,
} from '@/store/structuralUndo';
import {
  acquireStructuralWrite,
  releaseStructuralWrite,
} from '@/store/structuralWriteGuard';
import type { PageData, ElementData, ClassData, LinkAttributes, ImageAttributes, SerializedOverrides } from '@/store/types';
import { emptyClassData, SLOT_FILL_FIELDS, ELEMENT_OPTIONAL_SNAPSHOT_FIELDS } from '@/store/types';
import type { VariableCollection } from '@/core/variables/types';
import { createOverrideAPI } from '@/store/overrides';
import { yChildOrdersToPlain } from '@/store/selectors';
import { yMapToLinkAttributes } from '@/store/createEditorDoc';
import { coerceSeoValueToYjs } from '@/store/seoCoercion';
import { yMapToCollection, collectionToYMap } from '@/store/variableCommands';
import { collectionToYMap as contentCollectionToYMap } from '@/store/collectionCommands';
import { ySlotToPlain } from '@/core/collections/schemas';
import { plainSlotToYMap } from '@/core/collections/yjsAccessors';
import { getOrphansMap, type OverrideOrphan } from '@/store/overrideOrphans';
import { stableContext } from '@/utils/stableContext';
import { acceptProjectEdit } from '@/services/durableEdits/acceptance';
import { classCommands, writesSourceClasses } from '@/services/durableEdits/classCommands';
import { flushDurableSourceWrites } from '@/services/durableEdits/sourceMaterialization';
import type { MaterializationCommand } from '@/services/durableEdits/types';
import { captureLocalWriteOrigin } from '@/utils/localWriteScope';
import { getSelectedKey, getSelectionEpoch, setLocalPendingRestore } from '@/utils/localPendingSelection';
import { parseSourceLocationFromKey } from '@/utils/sourceLocationKey';
import { SOURCE_OWNED_FIELD } from '@/store/sourceOverrideEntries';
import { SOURCE_CLASS_CARRIERS, prepareSourceClassReplay, type SourceClassCarrier } from '@/services/durableEdits/sourceClassIdentity';

export interface AssetSideEffect {
  reverse: () => void;
  forward: () => void;
}

export interface SourceClassEntry {
  classes: string;
  baseClasses?: string;
  sourceLocation?: import('@/bridge').SourceLocation;
  /** User-edited marker (UPDATE_SOURCE_CLASSES stamps it; persistence keys off it). */
  edited?: boolean;
  sourceOwned?: boolean;
}

/** File undo record for tracking file changes made during AI batch operations */
export interface FileUndoRecord {
  path: string;
  previousContent: string | null; // null = file didn't exist before (undo = delete)
}

export interface UndoSnapshot {
  sourceClasses: Record<string, SourceClassEntry>;
  sourceClassCarriers?: Record<string, string>;
  sourceText: Record<string, string>;  // Text content by source key
  sourceOwnedText?: string[];
  sourceTextLocations?: Record<string, import('@/bridge').SourceLocation>;
  sourceImageAttributes: Record<string, Record<string, string>>;  // Image attributes by source key
  sourceLinkAttributes: Record<string, Record<string, string>>;  // Link attributes by source key
  pageOrder: Record<string, string[]>;
  pages: Record<string, PageData>;
  rootPages: string[];
  elements: Record<string, ElementData>;  // All elements for undo of deletions
  unifiedOverrides: Record<string, SerializedOverrides>;  // Unified overrides per element (includes href)
  variableCollections: Record<string, VariableCollection>;
  contentCollections?: Record<string, import('@/core/collections/types').ContentCollection>;
  postPageBindings?: Record<string, { collectionId: string; bindings: Record<string, string> }>;
  /** Blog slot bindings (raw round-trip — task-037/038 undo support).
   *  settingsRev/settingsBaseRev: task-102 sparse-inheritance revs. */
  blogSlotBindings: Record<string, { collectionId: string; settings: Record<string, unknown>; bindings: Record<string, string>; settingsRev?: number; settingsBaseRev?: number }>;
  /** Orphaned-override records (task-118) — plain objects; keep/discard is undoable. */
  overrideOrphans: Record<string, OverrideOrphan>;
  assetSideEffect?: AssetSideEffect;
  /** File operations made during an AI batch - used for undo/redo of file changes */
  fileRecords?: FileUndoRecord[];
  /** Exact source inverse belonging to this same document gesture. */
  fileChanges?: import('@/services/durableEdits/types').DurableFileChange[];
  sourceReplay?: import('@/services/durableEdits/types').DurableReceiptReplay;
  /** task-120 (7.1): which sections were CAPTURED. undefined = full snapshot.
   *  applySnapshot fills uncaptured sections from the live doc at apply time
   *  (a no-op under diff-on-apply), so partial snapshots never resurrect or
   *  clobber state they didn't capture. */
  scope?: SnapshotScopeField[];
}

export type SnapshotScopeField =
  | 'sourceClasses' | 'sourceText' | 'sourceImageAttributes' | 'sourceLinkAttributes'
  | 'pageOrder' | 'pages' | 'rootPages' | 'elements' | 'unifiedOverrides'
  | 'variableCollections' | 'contentCollections' | 'postPageBindings' | 'blogSlotBindings'
  | 'overrideOrphans';

const ALL_SCOPE_FIELDS: SnapshotScopeField[] = [
  'sourceClasses', 'sourceText', 'sourceImageAttributes', 'sourceLinkAttributes',
  'pageOrder', 'pages', 'rootPages', 'elements', 'unifiedOverrides',
  'variableCollections', 'contentCollections', 'postPageBindings', 'blogSlotBindings',
  'overrideOrphans',
];

/**
 * task-120 (7.1): command type → the snapshot sections that command can
 * write. ANY command type not listed here gets a FULL snapshot — correctness
 * over speed. When adding an entry, enumerate every map the command's
 * applyCommand branch writes (commands.ts) and include unifiedOverrides/
 * pageOrder/rootPages companions where the section travels with another.
 */
const CLASS_EDIT_SCOPE: SnapshotScopeField[] = [
  // sourceClasses (source elements) + elements' classOverrides (instances);
  // unifiedOverrides is captured in the same elements walk; overrideOrphans
  // included conservatively — override writes can interact with orphan
  // keep/discard records (task-118).
  'sourceClasses', 'elements', 'unifiedOverrides', 'overrideOrphans',
];

export const COMMAND_SNAPSHOT_SCOPES: Record<string, SnapshotScopeField[]> = {
  // Keyed by the REAL dispatched command types — callers pass the command
  // type they are about to dispatch; the mapping lives here.
  UPDATE_SOURCE_CLASSES: CLASS_EDIT_SCOPE,
  UPDATE_THEME_INSTANCE_CLASS_OVERRIDE: CLASS_EDIT_SCOPE,
};

/** The scoped sections of a partial snapshot, as a spreadable object. */
function pickScoped(snapshot: UndoSnapshot): Partial<UndoSnapshot> {
  const out: Partial<UndoSnapshot> = {};
  for (const field of snapshot.scope ?? []) {
    (out as Record<string, unknown>)[field] = snapshot[field];
    if (field === 'sourceText') {
      out.sourceOwnedText = snapshot.sourceOwnedText;
      out.sourceTextLocations = snapshot.sourceTextLocations;
    }
  }
  return out;
}

/**
 * task-133 Task 8: the past/future stacks hold TWO entry kinds —
 * - UndoSnapshot: doc state, restored via applySnapshot (unchanged behavior);
 * - StructuralUndoRecord: local-mode file writes, replayed through
 *   viteStructuralWriter (inverse ops on undo, forward ops on redo). These
 *   never touch the doc — there is no doc state for them.
 */
export type UndoEntry = UndoSnapshot | StructuralUndoRecord;

interface UndoContextValue {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
  /** With defer=true, return a commit callback; rejected edits leave both stacks untouched. */
  takeSnapshot: (assetSideEffect?: AssetSideEffect, commandType?: string, defer?: boolean) => (() => void) | void;
  claimSnapshot: () => import('@/store/documentMutation').MutationSnapshot | undefined;
  createSnapshot: (scope?: SnapshotScopeField[]) => UndoSnapshot;
  isUndoingRef: React.MutableRefObject<boolean>;  // Flag for observers to check
  /** Attach file undo records to the most recent snapshot (for AI batch file operations) */
  attachFileRecords: (records: FileUndoRecord[]) => void;
  /** task-133 Task 8: push a local-mode structural file-write entry (mirrors takeSnapshot: clears redo). */
  pushStructuralUndo: PushStructuralUndo;
}

const UndoContext = stableContext<UndoContextValue | null>('UndoContext', null);

const MAX_UNDO_STEPS = 20;

/** Convert a Y.Map<unknown> to a plain Record<string, string>, or undefined if empty/null. */
function yMapToStringRecord(yMap: Y.Map<unknown> | undefined): Record<string, string> | undefined {
  if (!yMap || yMap.size === 0) return undefined;
  const result: Record<string, string> = {};
  yMap.forEach((v, k) => {
    if (typeof v === 'string') result[k] = v;
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Convert a Y.Map<V> to a plain Record<string, V>, or undefined if empty/null. */
function yMapToRecord<V>(yMap: Y.Map<V> | undefined): Record<string, V> | undefined {
  if (!yMap || yMap.size === 0) return undefined;
  const result: Record<string, V> = {};
  yMap.forEach((v, k) => { result[k] = v; });
  return result;
}

/** Convert a nested Y.Map<Y.Map<unknown>> to Record<string, Record<string, string>>, or undefined if empty. */
function yNestedMapToStringRecord(
  yMap: Y.Map<Y.Map<unknown>> | undefined,
): Record<string, Record<string, string>> | undefined {
  if (!yMap || yMap.size === 0) return undefined;
  const result: Record<string, Record<string, string>> = {};
  yMap.forEach((yInner, key) => {
    const inner = yMapToStringRecord(yInner as Y.Map<unknown>);
    if (inner) result[key] = inner;
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Restore or clear a flat Y.Map from snapshot data.
 * When data is present: get-or-create the map, clear, then populate.
 * When data is absent and deleteWhenEmpty is true: delete the map key entirely.
 * When data is absent and deleteWhenEmpty is false: clear existing entries.
 */
function restoreFlatMap<V extends string | number>(
  yElement: Y.Map<unknown>,
  mapName: string,
  data: Record<string, V> | undefined,
  deleteWhenEmpty = false,
): void {
  if (data) {
    let yMap = yElement.get(mapName) as Y.Map<V> | undefined;
    // Diff-on-apply: skip the clear+rewrite when already equal.
    if (yMap && JSON.stringify(yMap.toJSON()) === JSON.stringify(data)) return;
    if (!yMap) {
      yMap = new Y.Map();
      yElement.set(mapName, yMap);
    }
    yMap.forEach((_, key) => yMap!.delete(key));
    for (const [key, value] of Object.entries(data)) {
      yMap.set(key, value);
    }
  } else if (deleteWhenEmpty) {
    yElement.delete(mapName);
  } else {
    const existing = yElement.get(mapName) as Y.Map<V> | undefined;
    if (existing) {
      existing.forEach((_, key) => existing.delete(key));
    }
  }
}

/**
 * Restore or clear a nested Y.Map<Y.Map<string>> from snapshot data.
 * Each entry in the outer map is itself a Record<string, string>.
 * Used for linkOverrides, imageOverrides, etc.
 */
function restoreNestedStringMap(
  yElement: Y.Map<unknown>,
  mapName: string,
  data: Record<string, Record<string, string>> | undefined,
  deleteWhenEmpty = false,
): void {
  if (data) {
    let yOuter = yElement.get(mapName) as Y.Map<Y.Map<string>> | undefined;
    // Diff-on-apply: skip the clear+rewrite when already equal.
    if (yOuter && JSON.stringify(yOuter.toJSON()) === JSON.stringify(data)) return;
    if (!yOuter) {
      yOuter = new Y.Map();
      yElement.set(mapName, yOuter);
    }
    yOuter.forEach((_, key) => yOuter!.delete(key));
    for (const [selector, attrs] of Object.entries(data)) {
      const yInner = new Y.Map<string>();
      for (const [attr, value] of Object.entries(attrs)) {
        yInner.set(attr, value);
      }
      yOuter.set(selector, yInner);
    }
  } else if (deleteWhenEmpty) {
    yElement.delete(mapName);
  } else {
    const existing = yElement.get(mapName) as Y.Map<unknown> | undefined;
    if (existing) {
      existing.forEach((_, key) => existing.delete(key));
    }
  }
}

export function UndoProvider({ children }: { children: ReactNode }) {
  const doc = useEditorDoc();
  const [past, setPast] = useState<UndoEntry[]>([]);
  const [future, setFuture] = useState<UndoEntry[]>([]);
  const isUndoingRef = React.useRef(false);  // Flag for observers to check during undo/redo
  /** A checkpoint requested by takeSnapshot, consumed by the next gesture commit. */
  const pendingSnapshot = React.useRef<{ snapshot: UndoSnapshot; commit: (snapshot: UndoSnapshot) => void } | undefined>(undefined);

  React.useEffect(() => {
    const isClassReplay = (tr: Y.Transaction) => /^durable-edit:(class-)?(undo|redo):/.test(String(tr.origin));
    const before = (tr: Y.Transaction) => { if (isClassReplay(tr)) isUndoingRef.current = true; };
    const after = (tr: Y.Transaction) => { if (isClassReplay(tr)) isUndoingRef.current = false; };
    doc.on('beforeTransaction', before); doc.on('afterTransaction', after);
    return () => { doc.off('beforeTransaction', before); doc.off('afterTransaction', after); };
  }, [doc]);

  // DEV-only detector (design §3.5): a 'user'-origin transaction committing
  // without a preceding takeSnapshot() is the one way the checkpoint model
  // silently bites — the change folds into the PREVIOUS undo step and the
  // next undo reverts it unasked. Surface it as a console signal.
  React.useEffect(() => {
    if (!import.meta.env.DEV) return;
    const handler = (tr: Y.Transaction) => {
      if ((tr.origin !== 'user' && tr.origin !== 'ai') || tr.changed.size === 0) return;
      // 'ai' = AI-run dispatch (snapshotOnceAndDispatch): folding into the
      // run's single snapshot is INTENDED (one Cmd+Z reverts the whole run),
      // so no warning. Armed = a requested checkpoint this transaction is
      // about to consume (this listener runs before the commit listener below).
      if (!pendingSnapshot.current && tr.origin === 'user') {
        console.warn(
          '[undo] user mutation without takeSnapshot — this change will be folded into the previous undo step',
          tr.changed,
        );
      }
    };
    doc.on('afterTransaction', handler);
    return () => { doc.off('afterTransaction', handler); };
  }, [doc]);

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  const createSnapshot = useCallback((scope?: SnapshotScopeField[], targetDoc: Y.Doc = doc): UndoSnapshot => {
    const doc = targetDoc;
    // task-120 (7.1): scoped capture — walk only the sections in scope.
    // Uncaptured sections stay empty and are marked via snapshot.scope;
    // applySnapshot fills them from the live doc at apply time.
    const want = (f: SnapshotScopeField): boolean => !scope || scope.includes(f);
    const sourceClasses: Record<string, SourceClassEntry> = {};
    const sourceText: Record<string, string> = {};
    const sourceOwnedText: string[] = [];
    const sourceTextLocations: Record<string, import('@/bridge').SourceLocation> = {};
    const pageOrder: Record<string, string[]> = {};
    const pages: Record<string, PageData> = {};
    const elements: Record<string, ElementData> = {};
    const unifiedOverrides: Record<string, SerializedOverrides> = {};

    const ySourceClasses = doc.getMap('sourceClasses');
    if (want('sourceClasses')) ySourceClasses.forEach((value, key) => {
      const entry = value as Y.Map<unknown>;
      const classes = entry.get('classes') as string || '';
      const yLoc = entry.get('sourceLocation') as Y.Map<unknown> | undefined;

      sourceClasses[key] = {
        classes,
        baseClasses: entry.get('baseClasses') as string | undefined,
        sourceLocation: yLoc ? {
          file: yLoc.get('file') as string,
          line: yLoc.get('line') as number,
          column: yLoc.get('column') as number,
          ...(yLoc.has('sourceVersion') ? { sourceVersion: yLoc.get('sourceVersion') as string } : {}),
          ...(yLoc.has('sourceRevision') ? { sourceRevision: yLoc.get('sourceRevision') as number } : {}),
        } : undefined,
        edited: entry.get('edited') === true ? true : undefined,
        sourceOwned: entry.get(SOURCE_OWNED_FIELD) === '1' ? true : undefined,
      };
    });

    // Capture text content
    const ySourceText = doc.getMap('sourceText');
    if (want('sourceText')) ySourceText.forEach((value, key) => {
      const entry = value as Y.Map<unknown>;
      const textContent = entry.get('textContent') as string || '';
      sourceText[key] = textContent;
      if (entry.get(SOURCE_OWNED_FIELD) === '1') sourceOwnedText.push(key);
      const location = entry.get('sourceLocation') as Y.Map<unknown> | undefined;
      if (location) sourceTextLocations[key] = location.toJSON() as import('@/bridge').SourceLocation;
    });

    // Capture source image attributes
    const sourceImageAttributes: Record<string, Record<string, string>> = {};
    const ySourceImageAttrs = doc.getMap('sourceImageAttributes');
    if (want('sourceImageAttributes')) ySourceImageAttrs.forEach((value, key) => {
      const attrs = yMapToStringRecord(value as Y.Map<unknown>);
      if (attrs) sourceImageAttributes[key] = attrs;
    });

    // Capture source link attributes
    const sourceLinkAttributes: Record<string, Record<string, string>> = {};
    const ySourceLinkAttrs = doc.getMap('sourceLinkAttributes');
    if (want('sourceLinkAttributes')) ySourceLinkAttrs.forEach((value, key) => {
      const attrs = yMapToStringRecord(value as Y.Map<unknown>);
      if (attrs) sourceLinkAttributes[key] = attrs;
    });

    // Capture elements (for undo of deletions)
    const yElements = doc.getMap('elements');
    if (want('elements')) yElements.forEach((value, key) => {
      const yEl = value as Y.Map<unknown>;
      const yClasses = yEl.get('classes') as Y.Map<Y.Array<string>> | undefined;
      const yOverrides = yEl.get('overrides') as Y.Map<Y.Map<unknown>> | undefined;

      // Convert Y.Map classes to plain ClassData
      const classes: ClassData = emptyClassData();
      if (yClasses) {
        yClasses.forEach((arr, bp) => {
          (classes as unknown as Record<string, string[]>)[bp] = (arr as Y.Array<string>).toArray();
        });
      }

      // Convert Y.Map overrides to plain object
      let overrides: Record<string, Partial<ElementData>> | undefined;
      if (yOverrides && yOverrides.size > 0) {
        overrides = {};
        yOverrides.forEach((yOverride, childId) => {
          const override = yOverride as Y.Map<unknown>;
          overrides![childId] = Object.fromEntries(
            Array.from(override.entries())
          ) as Partial<ElementData>;
        });
      }

      // Convert Y.Map classOverrides to plain ClassData record
      let classOverrides: Record<string, ClassData> | undefined;
      const yClassOverrides = yEl.get('classOverrides') as Y.Map<Y.Map<Y.Array<string>>> | undefined;
      if (yClassOverrides && yClassOverrides.size > 0) {
        classOverrides = {};
        yClassOverrides.forEach((ySelectorOverride, selector) => {
          const selectorClassData: ClassData = emptyClassData();
          ySelectorOverride.forEach((arr, bp) => {
            (selectorClassData as unknown as Record<string, string[]>)[bp] = (arr as Y.Array<string>).toArray();
          });
          classOverrides![selector] = selectorClassData;
        });
      }

      // Convert Y.Map textOverrides to plain object
      const textOverrides = yMapToStringRecord(
        yEl.get('textOverrides') as Y.Map<unknown> | undefined,
      );

      const markupOverrides = yMapToStringRecord(
        yEl.get('markupOverrides') as Y.Map<unknown> | undefined,
      );

      // Convert Y.Map linkAttributes to plain object
      const yLinkAttrs = yEl.get('linkAttributes') as Y.Map<unknown> | undefined;
      const linkAttributes = yLinkAttrs && yLinkAttrs.size > 0
        ? yMapToLinkAttributes(yLinkAttrs)
        : undefined;

      // Convert Y.Map linkOverrides to plain object
      let linkOverrides: Record<string, LinkAttributes> | undefined;
      const yLinkOverrides = yEl.get('linkOverrides') as Y.Map<Y.Map<unknown>> | undefined;
      if (yLinkOverrides && yLinkOverrides.size > 0) {
        linkOverrides = {};
        yLinkOverrides.forEach((yAttrs, selector) => {
          linkOverrides![selector] = yMapToLinkAttributes(yAttrs);
        });
      }

      const linkCounters = yMapToRecord<number>(
        yEl.get('linkCounters') as Y.Map<number> | undefined,
      );

      const imageAttributes = yMapToStringRecord(
        yEl.get('imageAttributes') as Y.Map<unknown> | undefined,
      ) as ImageAttributes | undefined;

      const imageOverrides = yNestedMapToStringRecord(
        yEl.get('imageOverrides') as Y.Map<Y.Map<unknown>> | undefined,
      ) as Record<string, ImageAttributes> | undefined;

      // Capture unifiedOverrides (includes href set via Override API)
      const yUnifiedOverrides = yEl.get('unifiedOverrides') as Y.Map<unknown> | undefined;
      if (yUnifiedOverrides && yUnifiedOverrides.size > 0) {
        const api = createOverrideAPI(yUnifiedOverrides);
        unifiedOverrides[key] = api.getSnapshot();
      }

      elements[key] = {
        id: yEl.get('id') as string,
        pageId: yEl.get('pageId') as string,
        parentId: yEl.get('parentId') as string | null,
        index: yEl.get('index') as number,
        type: yEl.get('type') as ElementData['type'],
        componentType: yEl.get('componentType') as string | undefined,
        slotName: yEl.get('slotName') as string | undefined,
        classes,
        textContent: yEl.get('textContent') as string | undefined,
        text: yEl.get('text') as string | undefined,
        tag: yEl.get('tag') as ElementData['tag'],
        attributes: yEl.get('attributes') as Record<string, string> | undefined,
        staticMarkup: yEl.get('staticMarkup') as string | undefined,
        templateId: yEl.get('templateId') as string | undefined,
        overrides,
        isTemplateChild: yEl.get('isTemplateChild') as boolean | undefined,
        isDrawn: yEl.get('isDrawn') as boolean | undefined,
        slotType: yEl.get('slotType') as ElementData['slotType'],
        slotComponentId: yEl.get('slotComponentId') as string | undefined,
        slotComponentName: yEl.get('slotComponentName') as string | undefined,
        slotComponentMarkup: yEl.get('slotComponentMarkup') as string | undefined,
        slotComponentPath: yEl.get('slotComponentPath') as string | undefined,
        deletedSelectors: (yEl.get('deletedSelectors') as Y.Array<string>)?.toArray() || undefined,
        orderOverrides: (yEl.get('orderOverrides') as Y.Array<string>)?.toArray() || undefined,
        reparentOverrides: (yEl.get('reparentOverrides') as Y.Array<string>)?.toArray() || undefined,
        // Instance-specific fields
        instanceType: yEl.get('instanceType') as ElementData['instanceType'],
        themeId: yEl.get('themeId') as string | undefined,
        componentPath: yEl.get('componentPath') as string | undefined,
        classOverrides,
        textOverrides,
        markupOverrides,
        linkAttributes,
        linkOverrides,
        linkCounters,
        imageAttributes,
        imageOverrides,
        astroSource: yEl.get('astroSource') as string | undefined,
      };

      for (const f of ELEMENT_OPTIONAL_SNAPSHOT_FIELDS) {
        const v = yEl.get(f);
        if (v !== undefined) (elements[key] as unknown as Record<string, unknown>)[f] = v;
      }
    });

    const yPages = doc.getMap('pages');
    if (want('pages')) yPages.forEach((value, key) => {
      const page = value as Y.Map<unknown>;
      const rootIds = page.get('rootElementIds') as Y.Array<string>;
      const childIds = page.get('children') as Y.Array<string>;
      if (rootIds) {
        pageOrder[key] = rootIds.toArray();
      }

      const co = yChildOrdersToPlain(page.get('childOrders') as Y.Map<Y.Array<string>> | undefined);
      const ySeo = page.get('seo') as Y.Map<unknown> | undefined;
      pages[key] = {
        id: page.get('id') as string,
        name: page.get('name') as string,
        rootElementIds: rootIds?.toArray() || [],
        children: childIds?.toArray() || [],
        childOrders: co,
        seo: ySeo && ySeo.size > 0 ? (ySeo.toJSON() as Record<string, unknown>) : undefined,
        pageType: page.get('pageType') as PageData['pageType'],
        collectionId: page.get('collectionId') as string | undefined,
        routePrefix: page.get('routePrefix') as string | undefined,
        isHome: page.get('isHome') === true || undefined,
        layoutName: page.get('layoutName') as string | null | undefined,
        layoutProps: page.get('layoutProps') as Record<string, string> | undefined,
      };
    });

    const yRootPages = doc.getArray('rootPages');
    const rootPages = want('rootPages') ? (yRootPages.toArray() as string[]) : [];

    // Variable collections
    const variableCollections: Record<string, VariableCollection> = {};
    const yVariableCollections = doc.getMap('variableCollections');
    if (want('variableCollections')) yVariableCollections.forEach((yMap, id) => {
      variableCollections[id] = yMapToCollection(yMap as Y.Map<unknown>);
    });

    // Blog slot bindings — captured RAW via ySlotToPlain (no Zod) so even
    // drifted shapes round-trip.
    const blogSlotBindings: UndoSnapshot['blogSlotBindings'] = {};
    if (want('blogSlotBindings')) doc.getMap('blogSlotBindings').forEach((value, slotKey) => {
      const plain = ySlotToPlain(value) as {
        collectionId?: string;
        settings: Record<string, unknown>;
        bindings: Record<string, string>;
        settingsRev?: number;
        settingsBaseRev?: number;
      };
      blogSlotBindings[slotKey] = {
        collectionId: plain.collectionId ?? '',
        settings: plain.settings,
        bindings: plain.bindings,
        settingsRev: plain.settingsRev,
        settingsBaseRev: plain.settingsBaseRev,
      };
    });

    const contentCollections = want('contentCollections') ? doc.getMap('contentCollections').toJSON() : {};
    const postPageBindings = want('postPageBindings') ? doc.getMap('postPageBindings').toJSON() : {};

    // Orphaned-override records (task-118) — values are already plain JSON.
    // Scoped like every other section (task-120).
    const overrideOrphans: Record<string, OverrideOrphan> = {};
    if (want('overrideOrphans')) getOrphansMap(doc).forEach((value, key) => {
      overrideOrphans[key] = value as OverrideOrphan;
    });

    return { sourceClasses, sourceClassCarriers: want('sourceClasses') ? doc.getMap<string>(SOURCE_CLASS_CARRIERS).toJSON() : undefined,
      sourceText, sourceOwnedText, sourceTextLocations, sourceImageAttributes, sourceLinkAttributes, pageOrder, pages, rootPages, elements, unifiedOverrides, variableCollections, contentCollections, postPageBindings, blogSlotBindings, overrideOrphans, scope };
  }, [doc]);

  const applySnapshot = useCallback((input: UndoSnapshot, targetDoc: Y.Doc = doc) => {
    const doc = targetDoc;
    // task-120 (7.1): a partial snapshot only captured its scoped sections —
    // fill the rest from the LIVE doc so the diff-on-apply body below no-ops
    // on them (never resurrects or clears state the command couldn't touch).
    // Fill only the UN-scoped sections from the live doc (the scoped walk —
    // usually the expensive elements section — is skipped; diff-on-apply
    // no-ops on the live-filled sections).
    const snapshot: UndoSnapshot = input.scope
      ? {
          ...createSnapshot(ALL_SCOPE_FIELDS.filter((f) => !input.scope!.includes(f)), doc),
          ...pickScoped(input),
          assetSideEffect: input.assetSideEffect,
          fileRecords: input.fileRecords,
          scope: undefined,
        }
      : input;
    doc.transact(() => {
      // Diff-on-apply (design §3.4): every section below deletes missing keys,
      // skips equal values, and only writes real changes. Yjs treats every
      // `set` as delete+insert and notifies observers, so blanket
      // clear()+rebuild made the whole RENDER pipeline cascade after undo
      // even for untouched maps. Semantics are unchanged — post-apply state
      // is byte-identical to the snapshot.

      /** Delete keys of a top-level map that the snapshot doesn't have. */
      const deleteMissingKeys = (yMap: Y.Map<unknown>, data: Record<string, unknown>) => {
        const stale: string[] = [];
        yMap.forEach((_, key) => { if (!(key in data)) stale.push(key); });
        for (const key of stale) yMap.delete(key);
      };

      // Restore sourceClasses
      const ySourceClasses = doc.getMap('sourceClasses');
      deleteMissingKeys(ySourceClasses, snapshot.sourceClasses);
      for (const [key, entry] of Object.entries(snapshot.sourceClasses)) {
        const existing = ySourceClasses.get(key) as Y.Map<unknown> | undefined;
        if (existing) {
          const existingClasses = (existing.get('classes') as string) || '';
          const yLoc = existing.get('sourceLocation') as Y.Map<unknown> | undefined;
          const existingLoc = yLoc ? yLoc.toJSON() : undefined;
          if (existingClasses === entry.classes &&
              existing.get('baseClasses') === entry.baseClasses &&
              JSON.stringify(existingLoc) === JSON.stringify(entry.sourceLocation) &&
              (existing.get(SOURCE_OWNED_FIELD) === '1') === (entry.sourceOwned === true) &&
              (existing.get('edited') === true) === (entry.edited === true)) {
            continue;
          }
        }
        const yEntry = new Y.Map();
        yEntry.set('classes', entry.classes);
        if (entry.baseClasses !== undefined) yEntry.set('baseClasses', entry.baseClasses);
        if (entry.edited) yEntry.set('edited', true);
        if (entry.sourceOwned) yEntry.set(SOURCE_OWNED_FIELD, '1');
        if (entry.sourceLocation) {
          const yLoc = new Y.Map(Object.entries(entry.sourceLocation));
          yEntry.set('sourceLocation', yLoc);
        }
        ySourceClasses.set(key, yEntry);
      }

      // Restore sourceText
      const ySourceText = doc.getMap('sourceText');
      deleteMissingKeys(ySourceText, snapshot.sourceText);
      for (const [key, textContent] of Object.entries(snapshot.sourceText)) {
        const existing = ySourceText.get(key) as Y.Map<unknown> | undefined;
        const sourceOwned = snapshot.sourceOwnedText?.includes(key) ?? false;
        const sourceLocation = snapshot.sourceTextLocations?.[key];
        const existingLocation = existing?.get('sourceLocation') as Y.Map<unknown> | undefined;
        if (existing && existing.get('textContent') === textContent && (existing.get(SOURCE_OWNED_FIELD) === '1') === sourceOwned
          && JSON.stringify(existingLocation?.toJSON()) === JSON.stringify(sourceLocation)) continue;
        const yEntry = new Y.Map();
        yEntry.set('textContent', textContent);
        if (sourceOwned) yEntry.set(SOURCE_OWNED_FIELD, '1');
        if (sourceLocation) yEntry.set('sourceLocation', new Y.Map(Object.entries(sourceLocation)));
        ySourceText.set(key, yEntry);
      }

      /** Restore a top-level map of attr records, skipping equal entries. */
      const restoreTopLevelAttrMap = (
        yMap: Y.Map<unknown>,
        data: Record<string, Record<string, string>>,
      ) => {
        deleteMissingKeys(yMap, data);
        for (const [key, attrs] of Object.entries(data)) {
          const existing = yMap.get(key) as Y.Map<unknown> | undefined;
          if (existing && JSON.stringify(existing.toJSON()) === JSON.stringify(attrs)) continue;
          const yAttrs = new Y.Map();
          for (const [attrKey, value] of Object.entries(attrs)) {
            yAttrs.set(attrKey, value);
          }
          yMap.set(key, yAttrs);
        }
      };

      // Restore sourceImageAttributes
      restoreTopLevelAttrMap(doc.getMap('sourceImageAttributes'), snapshot.sourceImageAttributes);

      // Restore sourceLinkAttributes (guard for backward compat with pre-existing snapshots)
      restoreTopLevelAttrMap(doc.getMap('sourceLinkAttributes'), snapshot.sourceLinkAttributes || {});

      // Restore elements (for undo of deletions)
      const yElements = doc.getMap('elements');
      const currentElementIds = new Set<string>();
      yElements.forEach((_, key) => currentElementIds.add(key));
      const snapshotElementIds = new Set(Object.keys(snapshot.elements));

      // Delete elements that don't exist in snapshot
      for (const elementId of currentElementIds) {
        if (!snapshotElementIds.has(elementId)) {
          yElements.delete(elementId);
        }
      }

      // Add or update elements from snapshot
      for (const [elementId, elementData] of Object.entries(snapshot.elements)) {
        let yElement = yElements.get(elementId) as Y.Map<unknown> | undefined;

        if (!yElement) {
          yElement = new Y.Map();
          yElements.set(elementId, yElement);
        }

        // Set all element properties (skip equal-value writes — diff-on-apply)
        const setScalar = (field: string, value: unknown) => {
          if (yElement!.get(field) !== value) yElement!.set(field, value);
        };
        setScalar('id', elementData.id);
        setScalar('pageId', elementData.pageId);
        setScalar('parentId', elementData.parentId);
        setScalar('index', elementData.index);
        setScalar('type', elementData.type);
        if (elementData.componentType !== undefined) setScalar('componentType', elementData.componentType);
        if (elementData.slotName !== undefined) setScalar('slotName', elementData.slotName);
        if (elementData.textContent !== undefined) setScalar('textContent', elementData.textContent);
        if (elementData.text !== undefined) setScalar('text', elementData.text);
        if (elementData.tag !== undefined) setScalar('tag', elementData.tag);
        // attributes is a plain object — reference compare would always differ
        if (elementData.attributes !== undefined &&
            JSON.stringify(yElement.get('attributes')) !== JSON.stringify(elementData.attributes)) {
          yElement.set('attributes', elementData.attributes);
        }
        if (elementData.staticMarkup !== undefined) setScalar('staticMarkup', elementData.staticMarkup);
        if (elementData.templateId !== undefined) setScalar('templateId', elementData.templateId);
        if (elementData.isTemplateChild !== undefined) setScalar('isTemplateChild', elementData.isTemplateChild);
        if (elementData.isDrawn !== undefined) setScalar('isDrawn', elementData.isDrawn);
        if (elementData.slotType !== undefined) setScalar('slotType', elementData.slotType);
        // Slot-fill fields diverge from the set-only pattern above: undoing
        // a fill must clear them, so absence in the snapshot maps to delete.
        // Skip writes when the value is already what we'd set — Yjs treats
        // every `set` as delete+insert and notifies observers, so equal-value
        // writes thrash the auto-flush debounce for no reason.
        if (elementData.slotType) {
          for (const f of SLOT_FILL_FIELDS) {
            const next = elementData[f];
            if (next !== undefined) {
              if (yElement.get(f) !== next) yElement.set(f, next);
            } else if (yElement.has(f)) {
              yElement.delete(f);
            }
          }
        }
        if (elementData.deletedSelectors) {
          const existing = yElement.get('deletedSelectors') as Y.Array<string> | undefined;
          if (!existing || JSON.stringify(existing.toArray()) !== JSON.stringify(elementData.deletedSelectors)) {
            yElement.set('deletedSelectors', Y.Array.from(elementData.deletedSelectors));
          }
        } else if (yElement.has('deletedSelectors')) {
          yElement.delete('deletedSelectors');
        }
        if (elementData.orderOverrides) {
          const existing = yElement.get('orderOverrides') as Y.Array<string> | undefined;
          if (!existing || JSON.stringify(existing.toArray()) !== JSON.stringify(elementData.orderOverrides)) {
            yElement.set('orderOverrides', Y.Array.from(elementData.orderOverrides));
          }
        } else if (yElement.has('orderOverrides')) {
          yElement.delete('orderOverrides');
        }
        if (elementData.reparentOverrides) {
          const existing = yElement.get('reparentOverrides') as Y.Array<string> | undefined;
          if (!existing || JSON.stringify(existing.toArray()) !== JSON.stringify(elementData.reparentOverrides)) {
            yElement.set('reparentOverrides', Y.Array.from(elementData.reparentOverrides));
          }
        } else if (yElement.has('reparentOverrides')) {
          yElement.delete('reparentOverrides');
        }
        // Instance-specific fields
        if (elementData.instanceType !== undefined) setScalar('instanceType', elementData.instanceType);
        if (elementData.themeId !== undefined) setScalar('themeId', elementData.themeId);
        if (elementData.componentPath !== undefined) setScalar('componentPath', elementData.componentPath);
        if (elementData.astroSource !== undefined) setScalar('astroSource', elementData.astroSource);
        // Optional scalar fields with delete-when-absent semantics (same
        // pattern as the slot-fill loop above): undoing the action that SET
        // the field must REMOVE it. Skip equal-value writes.
        for (const f of ELEMENT_OPTIONAL_SNAPSHOT_FIELDS) {
          const next = elementData[f];
          if (next !== undefined) {
            if (yElement.get(f) !== next) yElement.set(f, next);
          } else if (yElement.has(f)) {
            yElement.delete(f);
          }
        }

        // Restore classes as Y.Map<Y.Array>
        let yClasses = yElement.get('classes') as Y.Map<Y.Array<string>> | undefined;
        if (!yClasses) {
          yClasses = new Y.Map();
          yElement.set('classes', yClasses);
        }
        yClasses.forEach((_, bp) => yClasses!.delete(bp));
        if (elementData.classes) {
          for (const [bp, tokens] of Object.entries(elementData.classes)) {
            yClasses.set(bp, Y.Array.from(tokens as string[]));
          }
        }

        // Restore overrides as Y.Map<Y.Map>
        if (elementData.overrides) {
          let yOverrides = yElement.get('overrides') as Y.Map<Y.Map<unknown>> | undefined;
          if (!yOverrides) {
            yOverrides = new Y.Map();
            yElement.set('overrides', yOverrides);
          }
          yOverrides.forEach((_, key) => yOverrides!.delete(key));
          for (const [childId, override] of Object.entries(elementData.overrides)) {
            const yOverride = new Y.Map();
            for (const [key, value] of Object.entries(override)) {
              yOverride.set(key, value);
            }
            yOverrides.set(childId, yOverride);
          }
        } else {
          const existingOverrides = yElement.get('overrides') as Y.Map<unknown> | undefined;
          if (existingOverrides) {
            existingOverrides.forEach((_, key) => existingOverrides.delete(key));
          }
        }

        // Restore classOverrides as Y.Map<Y.Map<Y.Array>>
        if (elementData.classOverrides) {
          let yClassOverrides = yElement.get('classOverrides') as Y.Map<Y.Map<Y.Array<string>>> | undefined;
          if (!yClassOverrides) {
            yClassOverrides = new Y.Map();
            yElement.set('classOverrides', yClassOverrides);
          }
          yClassOverrides.forEach((_, key) => yClassOverrides!.delete(key));
          for (const [selector, classData] of Object.entries(elementData.classOverrides)) {
            const ySelectorOverride = new Y.Map<Y.Array<string>>();
            for (const [bp, tokens] of Object.entries(classData)) {
              ySelectorOverride.set(bp, Y.Array.from(tokens as string[]));
            }
            yClassOverrides.set(selector, ySelectorOverride);
          }
        } else {
          const existingOverrides = yElement.get('classOverrides') as Y.Map<unknown> | undefined;
          if (existingOverrides) {
            existingOverrides.forEach((_, key) => existingOverrides.delete(key));
          }
        }

        // Restore simple string maps
        restoreFlatMap(yElement, 'textOverrides', elementData.textOverrides);
        restoreFlatMap(yElement, 'markupOverrides', elementData.markupOverrides);
        restoreFlatMap(yElement, 'linkAttributes', elementData.linkAttributes as Record<string, string> | undefined);
        restoreFlatMap(yElement, 'linkCounters', elementData.linkCounters);

        // Restore nested string maps (each entry is a Record<string, string>)
        restoreNestedStringMap(yElement, 'linkOverrides', elementData.linkOverrides as Record<string, Record<string, string>> | undefined);

        // Image maps use deleteWhenEmpty so selectImageAttributes/observers detect removal
        restoreFlatMap(yElement, 'imageAttributes', elementData.imageAttributes as Record<string, string> | undefined, true);
        restoreNestedStringMap(yElement, 'imageOverrides', elementData.imageOverrides as Record<string, Record<string, string>> | undefined, true);
      }

      // Restore unifiedOverrides (includes href set via Override API)
      for (const [elementId, overrideSnapshot] of Object.entries(snapshot.unifiedOverrides)) {
        const yElement = yElements.get(elementId) as Y.Map<unknown> | undefined;
        if (yElement) {
          let yUnifiedOverrides = yElement.get('unifiedOverrides') as Y.Map<unknown> | undefined;
          if (!yUnifiedOverrides) {
            yUnifiedOverrides = new Y.Map();
            yElement.set('unifiedOverrides', yUnifiedOverrides);
          }
          const api = createOverrideAPI(yUnifiedOverrides);
          api.restoreSnapshot(overrideSnapshot);
        }
      }

      // Clear unifiedOverrides from elements not in snapshot
      yElements.forEach((value, elementId) => {
        if (!snapshot.unifiedOverrides[elementId]) {
          const yElement = value as Y.Map<unknown>;
          const yUnifiedOverrides = yElement.get('unifiedOverrides') as Y.Map<unknown> | undefined;
          if (yUnifiedOverrides && yUnifiedOverrides.size > 0) {
            yUnifiedOverrides.forEach((_, key) => yUnifiedOverrides.delete(key));
          }
        }
      });

      // Restore pages
      const yPages = doc.getMap('pages');
      const currentPageIds = new Set<string>();
      yPages.forEach((_, key) => currentPageIds.add(key));
      const snapshotPageIds = new Set(Object.keys(snapshot.pages));

      // Delete pages that don't exist in snapshot
      for (const pageId of currentPageIds) {
        if (!snapshotPageIds.has(pageId)) {
          yPages.delete(pageId);
        }
      }

      // Add or update pages from snapshot
      for (const [pageId, pageData] of Object.entries(snapshot.pages)) {
        let yPage = yPages.get(pageId) as Y.Map<unknown> | undefined;

        if (!yPage) {
          yPage = new Y.Map();
          yPage.set('id', pageData.id);
          yPage.set('name', pageData.name);
          yPage.set('rootElementIds', Y.Array.from(pageData.rootElementIds));
          yPage.set('children', Y.Array.from(pageData.children));
          yPages.set(pageId, yPage);
        } else {
          if (yPage.get('name') !== pageData.name) yPage.set('name', pageData.name);

          const rootIds = yPage.get('rootElementIds') as Y.Array<string>;
          if (rootIds && JSON.stringify(rootIds.toArray()) !== JSON.stringify(pageData.rootElementIds)) {
            rootIds.delete(0, rootIds.length);
            rootIds.push(pageData.rootElementIds);
          }

          const children = yPage.get('children') as Y.Array<string>;
          if (children && JSON.stringify(children.toArray()) !== JSON.stringify(pageData.children)) {
            children.delete(0, children.length);
            children.push(pageData.children);
          }
        }

        // Restore childOrders on the page (skip when already equal)
        if (pageData.childOrders && Object.keys(pageData.childOrders).length > 0) {
          let yChildOrders = yPage.get('childOrders') as Y.Map<Y.Array<string>> | undefined;
          const existingPlain = yChildOrders ? yChildOrdersToPlain(yChildOrders) : undefined;
          if (JSON.stringify(existingPlain) !== JSON.stringify(pageData.childOrders)) {
            if (!yChildOrders) {
              yChildOrders = new Y.Map();
              yPage.set('childOrders', yChildOrders);
            }
            yChildOrders.forEach((_, key) => yChildOrders!.delete(key));
            for (const [parentKey, childKeys] of Object.entries(pageData.childOrders)) {
              yChildOrders.set(parentKey, Y.Array.from(childKeys));
            }
          }
        } else {
          const existing = yPage.get('childOrders') as Y.Map<unknown> | undefined;
          if (existing) {
            existing.forEach((_, key) => existing.delete(key));
          }
        }

        // Optional scalar page fields: set when present, DELETE when absent
        // (undoing "set layout" must remove layoutName). Skip equal writes.
        const PAGE_OPTIONAL_FIELDS = ['pageType', 'collectionId', 'routePrefix', 'layoutName', 'isHome'] as const;
        for (const f of PAGE_OPTIONAL_FIELDS) {
          const next = pageData[f];
          if (next !== undefined) {
            if (yPage.get(f) !== next) yPage.set(f, next);
          } else if (yPage.has(f)) {
            yPage.delete(f);
          }
        }

        // layoutProps: stored as a plain object (see SET_PAGE_LAYOUT in commands.ts).
        if (pageData.layoutProps !== undefined) {
          if (JSON.stringify(yPage.get('layoutProps')) !== JSON.stringify(pageData.layoutProps)) {
            yPage.set('layoutProps', pageData.layoutProps);
          }
        } else if (yPage.has('layoutProps')) {
          yPage.delete('layoutProps');
        }

        // seo: rebuild as Y structures via the SAME coercion the UPDATE_PAGE_SEO
        // command uses, so undo and reload hydration produce identical structures.
        if (pageData.seo && Object.keys(pageData.seo).length > 0) {
          const existingSeo = yPage.get('seo') as Y.Map<unknown> | undefined;
          if (!existingSeo || JSON.stringify(existingSeo.toJSON()) !== JSON.stringify(pageData.seo)) {
            const seoMap = new Y.Map<unknown>();
            for (const [field, value] of Object.entries(pageData.seo)) {
              if (value !== null && value !== undefined) seoMap.set(field, coerceSeoValueToYjs(value));
            }
            yPage.set('seo', seoMap);
          }
        } else if (yPage.has('seo')) {
          yPage.delete('seo');
        }
      }

      // Restore rootPages order (skip when already equal)
      const yRootPages = doc.getArray('rootPages');
      if (JSON.stringify(yRootPages.toArray()) !== JSON.stringify(snapshot.rootPages)) {
        yRootPages.delete(0, yRootPages.length);
        yRootPages.push(snapshot.rootPages);
      }

      // Whole-map restores with diff-on-apply (design §3.4): delete missing
      // keys, skip JSON-equal entries, write only real changes — so undoing an
      // unrelated action never churns these maps' observers. `|| {}` in the
      // callers guards snapshots captured before a field existed.
      const restorePlainMap = <T,>(
        mapName: string,
        data: Record<string, T>,
        toY: (v: T) => unknown = (v) => v,
      ) => {
        const yMap = doc.getMap(mapName);
        for (const k of Array.from(yMap.keys())) {
          if (!(k in data)) yMap.delete(k);
        }
        for (const [k, v] of Object.entries(data)) {
          const existing = yMap.get(k);
          const existingPlain = existing instanceof Y.Map ? existing.toJSON() : existing;
          if (JSON.stringify(existingPlain) === JSON.stringify(v)) continue;
          yMap.set(k, toY(v));
        }
      };

      // Variable collections; blog slot bindings (task-037/038 — carries the
      // task-102 revs).
      restorePlainMap('variableCollections', snapshot.variableCollections || {}, collectionToYMap);
      restorePlainMap('contentCollections', snapshot.contentCollections || {}, contentCollectionToYMap);
      restorePlainMap('postPageBindings', snapshot.postPageBindings || {}, binding => new Y.Map<unknown>([
        ['collectionId', binding.collectionId], ['bindings', new Y.Map(Object.entries(binding.bindings))],
      ]));
      restorePlainMap('blogSlotBindings', snapshot.blogSlotBindings || {}, plainSlotToYMap);
      restorePlainMap('overrideOrphans', snapshot.overrideOrphans || {});
    }, 'undo');
  }, [doc, createSnapshot]);

  /**
   * task-133 Task 10 sweep: bumped by every new gesture (takeSnapshot /
   * pushStructuralUndo). An in-flight structural replay captures the value at
   * launch; its async success resolution re-pushes the replayed entry ONLY if
   * the generation is unchanged — otherwise the gesture already cleared the
   * redo stack and re-adding would resurrect a stale redo (or, redo-side,
   * append the entry out of order above a newer snapshot).
   */
  const stackGenerationRef = React.useRef(0);

  const takeSnapshot = useCallback((assetSideEffect?: AssetSideEffect, commandType?: string, defer = false) => {
    // task-120 (7.1): known command types capture only the sections they can
    // touch; unknown/absent types capture everything (correctness fallback).
    const scope = commandType ? COMMAND_SNAPSHOT_SCOPES[commandType] : undefined;
    const snapshot = createSnapshot(scope);
    if (assetSideEffect) snapshot.assetSideEffect = assetSideEffect;
    const commit = (acceptedSnapshot = snapshot) => {
      stackGenerationRef.current++;
      setPast(prev => [...prev.slice(-(MAX_UNDO_STEPS - 1)), acceptedSnapshot]);
      setFuture([]);
    };
    if (defer) return () => commit();
    // Calling takeSnapshot is intent to begin a gesture, not evidence that
    // storage accepted it. Dispatch claims this intent before entering the queue.
    pendingSnapshot.current = { snapshot, commit };
  }, [createSnapshot]);

  const claimSnapshot = useCallback(() => {
    const pending = pendingSnapshot.current;
    pendingSnapshot.current = undefined;
    if (!pending) return undefined;
    let captured = pending.snapshot;
    let fileChanges: UndoSnapshot['fileChanges'];
    return {
      attachSourceReceipts: (sourceReplay: NonNullable<UndoSnapshot['sourceReplay']>) => { captured = { ...captured, sourceReplay: structuredClone(sourceReplay) }; },
      attachFiles: (files: NonNullable<UndoSnapshot['fileChanges']>) => {
        fileChanges = files.map(file => ({ ...file, beforeSource: file.afterSource, afterSource: file.beforeSource, identityMaps: invertIdentityMaps(file.identityMaps ?? []) }));
        captured = { ...captured, fileChanges };
      },
      stage: (staged: Y.Doc) => { captured = { ...createSnapshot(pending.snapshot.scope, staged), assetSideEffect: pending.snapshot.assetSideEffect, fileChanges }; },
      commit: () => pending.commit(captured),
    };
  }, [createSnapshot]);

  React.useEffect(() => {
    // Legacy direct owners are migrated independently; their explicit user
    // transactions still consume a requested checkpoint. Session sync never does.
    const after = (tr: Y.Transaction) => {
      if ((tr.origin !== 'user' && tr.origin !== 'ai') || tr.changed.size === 0) return;
      const pending = pendingSnapshot.current;
      pendingSnapshot.current = undefined;
      pending?.commit(pending.snapshot);
    };
    doc.on('afterTransaction', after);
    return () => { doc.off('afterTransaction', after); };
  }, [doc]);

  /** Attach file undo records to the most recent past snapshot */
  const attachFileRecords = useCallback((records: FileUndoRecord[]) => {
    if (records.length === 0) return;
    setPast(prev => {
      if (prev.length === 0) return prev;
      // task-133 Task 8: fileRecords belong to doc snapshots only.
      if (isStructuralUndoEntry(prev[prev.length - 1])) return prev;
      const last = { ...prev[prev.length - 1], fileRecords: records };
      return [...prev.slice(0, -1), last];
    });
  }, []);

  /**
   * task-133 Task 8: push a structural file-write entry onto the SAME past
   * stack (mirrors takeSnapshot semantics: caps depth, clears redo).
   */
  const pushStructuralUndo = useCallback<PushStructuralUndo>((record) => {
    stackGenerationRef.current++;
    // The page it was made on: its undo replays there from any page.
    const stamped = { ...record, origin: record.origin ?? captureLocalWriteOrigin(), selection: getSelectedKey() };
    setPast(prev => [...prev.slice(-(MAX_UNDO_STEPS - 1)), stamped]);
    setFuture([]);
  }, []);

  /**
   * Accept existing-file replay as one revision before transferring its stack
   * entry. Keep the shared structural guard through source materialization;
   * busy/rejected replay leaves the entry untouched. Page/content operations
   * still use legacy replay and only transfer after its successful outcome.
   */
  /** A refused replay keeps its step for a retry (87a0781c) — unless its file
   *  changed since (an outside edit: the AI, a terminal). That step can never
   *  replay: it leaves the stack, so the next press reaches the one before (#20). */
  const refuseReplay = useCallback((entry: UndoEntry, dir: 'undo' | 'redo', error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    const stale = /Source changed before acceptance/.test(detail);
    if (stale) (dir === 'undo' ? setPast : setFuture)(prev => prev.filter(item => item !== entry));
    toast.error(t("{0} was not saved: {1}{2}", { 0: dir === 'undo' ? 'Undo' : 'Redo', 1: detail, 2: stale ? ' — the step was removed' : '' }));
  }, []);

  const beginStructuralReplay = useCallback(async (entry: StructuralUndoRecord, dir: 'undo' | 'redo') => {
    // An intervening accepted edit must not have its cleared redo resurrected
    // by this replay's asynchronous stack transfer — measured from the press,
    // not from when its turn comes.
    const generationAtLaunch = stackGenerationRef.current;
    const selected = getSelectedKey(), selectionEpoch = getSelectionEpoch(); // at the press
    // Owner 2026-11-10: behind a write in flight it waits its turn — never "busy".
    await acquireStructuralWrite();
    const ops = dir === 'undo' ? entry.structuralOp.inverse : entry.structuralOp.forward;
    // task-148: the doc is only needed by the page-delete/page-restore ops
    // (they mirror the file result into Yjs); every other op ignores it.
    try {
      const accepted = await acceptStructuralReplay(doc, ops, entry.structuralOp.sourceFiles, dir === 'undo' ? 'before' : 'after', entry.structuralOp.sourceSteps, entry.structuralOp.masterWrite, entry.origin);
      if (dir === 'undo') setPast(prev => prev.filter(item => item !== entry));
      else setFuture(prev => prev.filter(item => item !== entry));
      // Keys are positions: select what the step started with, and let the reverse replay select what this press left.
      const moved = { ...entry, selection: selected };
      if (stackGenerationRef.current === generationAtLaunch) {
          if (dir === 'undo') setFuture(prev => [moved, ...prev]);
          else setPast(prev => [...prev, moved]);
      }
      if (accepted.files?.[0]) setLocalPendingRestore(accepted.files[0].file, entry.selection ?? null, selectionEpoch);
      {
        const projectId = doc.getMap('meta').get('projectId') as string;
        void import('@/services/durableEdits/sourceMaterialization').then(async ({ flushDurableSourceWritesThrough }) => {
          await flushDurableSourceWritesThrough(projectId, accepted.revision);
          const { announceLocalPage } = await import('@/store/localPages');
          const { routeForPageFile } = await import('@/utils/localMode');
          for (const op of ops) {
            if (op.kind === 'page-delete') announceLocalPage('deleted', op.route, op.file);
            if (op.kind === 'page-restore') announceLocalPage('created', op.route, op.file);
            if (op.kind === 'page-move') {
              announceLocalPage('deleted', routeForPageFile(op.from), op.from);
              announceLocalPage('created', routeForPageFile(op.to), op.to);
            }
            if (op.kind === 'content-body') window.dispatchEvent(new Event('sq:content-changed'));
          }
        }).catch(error => {
            console.error('Accepted structural replay is pending source materialization', error);
          });
      }
    } catch (error) {
      refuseReplay(entry, dir, error);
    } finally { releaseStructuralWrite(); }
  }, [doc, refuseReplay]);

  const replayClasses = useCallback(async (snapshot: UndoSnapshot, direction: 'undo' | 'redo') => {
    const projectId = doc.getMap('meta').get('projectId') as string | undefined;
    const generation = stackGenerationRef.current;
    const origin = captureLocalWriteOrigin();
    const commands: MaterializationCommand[] = [];
    let reverse: UndoSnapshot | undefined;
    let classCarriers = new Map<string, SourceClassCarrier>();
    let accepted: import('@/services/durableEdits/types').AcceptedEdit | undefined;
    try {
      if (!projectId) throw new Error('Project storage is not ready');
      if (snapshot.sourceReplay) commands.push({ kind: 'receipt-replay', payload: structuredClone(snapshot.sourceReplay) });
      if (snapshot.fileChanges?.length) {
        commands.push({ kind: 'file-batch', payload: { files: structuredClone(snapshot.fileChanges) } });
      }
      const holdKeys = new Set<string>();
      accepted = await acceptProjectEdit(doc, { projectId, operationId: `${direction}:${crypto.randomUUID()}`, commands, holdKeys,
        prepare: async precedingRevision => {
          classCarriers = await prepareSourceClassReplay(projectId, doc, snapshot.sourceClassCarriers, precedingRevision);
          if (snapshot.fileChanges?.length) {
            const { readProjectedSourceState, withProjectedSource } = await import('@/services/durableEdits/projectedSource');
            await withProjectedSource(projectId, precedingRevision, async () => {
              for (const file of snapshot.fileChanges!) if (await readProjectedSourceState(projectId, file.file, file.encoding) !== file.beforeSource) throw new Error(`Source changed before acceptance: ${file.file}`);
            });
          }
        },
        mutate: staged => {
          reverse = createSnapshot(snapshot.scope, staged);
          reverse.assetSideEffect = snapshot.assetSideEffect;
          reverse.fileChanges = snapshot.fileChanges?.map(file => ({ ...file, beforeSource: file.afterSource, afterSource: file.beforeSource, identityMaps: invertIdentityMaps(file.identityMaps ?? []) }));
          reverse.sourceReplay = snapshot.sourceReplay ? { ...snapshot.sourceReplay, direction: snapshot.sourceReplay.direction === 'before' ? 'after' : 'before' } : undefined;
          const before = reverse.sourceClasses;
          applySnapshot(snapshot, staged);
          for (const [id, carrier] of classCarriers) staged.getMap<string>(SOURCE_CLASS_CARRIERS).set(id, JSON.stringify(carrier));
          const after = createSnapshot(snapshot.scope, staged).sourceClasses;
          for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (before[key]?.classes === after[key]?.classes) continue;
            const loc = after[key]?.sourceLocation ?? before[key]?.sourceLocation ?? parseSourceLocationFromKey(key) ?? undefined;
            if (!loc) continue; // Instance classes remain a durable overlay.
            const baseline = before[key]?.classes ?? after[key]?.baseClasses ?? null;
            const restored = after[key]?.classes ?? before[key]?.baseClasses;
            // A compound edit may only register this class carrier. Its exact
            // file inverse already owns source restoration; do not invent an
            // original class value for that otherwise inert registration.
            // …nor for a doc-only overlay (e.g. a master placement override,
            // cross-file from the page), which never writes its file.
            if (restored === undefined) {
              if (snapshot.fileChanges?.some(file => file.file === loc.file) || !writesSourceClasses(loc, origin)) continue;
              throw new Error('Cannot restore source classes: the original file value is unknown');
            }
            const writes = classCommands(loc, restored, baseline, origin, 0);
            if (!snapshot.fileChanges?.some(file => file.file === loc.file)) { commands.push(...writes); if (writes.length) holdKeys.add(key); }
            if (writes.length) staged.getMap<string>('acceptedSourceClassTargets').set(key, restored);
          }
        },
      });
    } catch (error) {
      refuseReplay(snapshot, direction, error);
      return;
    }
    // Acceptance is final. Post-commit asset observers cannot turn it into a
    // storage rejection or prevent the accepted source commands from flushing.
    try {
      if (direction === 'undo') {
        setPast(entries => entries.filter(entry => entry !== snapshot));
        if (stackGenerationRef.current === generation) setFuture(entries => [reverse!, ...entries]);
      } else {
        setFuture(entries => entries.filter(entry => entry !== snapshot));
        if (stackGenerationRef.current === generation) setPast(entries => [...entries, reverse!]);
      }
      try {
        if (direction === 'undo') snapshot.assetSideEffect?.reverse();
        else snapshot.assetSideEffect?.forward();
      } catch (error) {
        console.error('[accepted undo asset observer]', error);
      }
    } finally {
      const { flushDurableSourceWritesThrough } = await import('@/services/durableEdits/sourceMaterialization');
      // A post / collection / field brought back (or deleted again) by ⌘Z: the Content panel and an open post re-list
      // once the files landed — like the structural 'content-body' replay (useContentCollections).
      const content = snapshot.fileChanges?.some(file => file.file.startsWith('src/content/'));
      void flushDurableSourceWritesThrough(projectId!, accepted!.revision)
        .then(() => { if (content) window.dispatchEvent(new Event('sq:content-changed')); }).catch(() => {});
    }
  }, [doc, createSnapshot, applySnapshot, refuseReplay]);

  // Owner 2026-11-10 ("no refusals … nothing lost"): ⌘Z / ⌘⇧Z pressed again
  // while the last one is still being saved is never refused ("busy") nor
  // dropped: presses queue and run one at a time, each on the stack the
  // previous one LEFT (read after that render — replaying the same in-flight
  // entry twice would apply its inverse twice). A press resolves when its own
  // replay finished. A replay that did not apply ends the rest of its burst.
  type Press = { dir: 'undo' | 'redo'; done: () => void };
  const pressesRef = React.useRef<Press[]>([]);
  const replayingRef = React.useRef(false);
  const lastPressRef = React.useRef<{ dir: 'undo' | 'redo'; entry: unknown } | null>(null);
  const stacksRef = React.useRef({ past, future });
  stacksRef.current = { past, future };
  const [pressTick, setPressTick] = useState(0);
  const runNextPress = useCallback(() => {
    if (replayingRef.current) return;
    const press = pressesRef.current.shift();
    if (!press) return;
    const { past: p, future: f } = stacksRef.current;
    const entry = press.dir === 'undo' ? p[p.length - 1] : f[0];
    if (!entry) { press.done(); for (const rest of pressesRef.current.splice(0)) rest.done(); return; }
    replayingRef.current = true;
    // task-133 Task 8: structural entries replay file writes — never applySnapshot.
    const run = isStructuralUndoEntry(entry) ? beginStructuralReplay(entry, press.dir) : replayClasses(entry, press.dir);
    void Promise.resolve(run).catch(() => {}).finally(() => {
      replayingRef.current = false;
      lastPressRef.current = { dir: press.dir, entry };
      press.done();
      setPressTick(t => t + 1);
    });
  }, [beginStructuralReplay, replayClasses]);
  React.useEffect(() => {
    const last = lastPressRef.current;
    lastPressRef.current = null;
    if (last) {
      const { past: p, future: f } = stacksRef.current;
      const stillThere = last.dir === 'undo' ? p[p.length - 1] === last.entry : f[0] === last.entry;
      if (stillThere) for (const rest of pressesRef.current.splice(0)) rest.done();
    }
    runNextPress();
  }, [pressTick, runNextPress]);
  const press = useCallback((dir: 'undo' | 'redo') => new Promise<void>((done) => {
    // A class edit still in flight is undone BY this press: wait for it (acceptance + its undo step), then queue.
    // Presses keep their order: the waits resolve in call order.
    const projectId = doc.getMap('meta').get('projectId') as string | undefined;
    if (!hasClassEditsInFlight(projectId)) { pressesRef.current.push({ dir, done }); runNextPress(); return; }
    // The edit's undo step went in through setPast and the stacks are read from a render-time snapshot: queue the press
    // and let the next render (which carries that step) start it, via the pressTick effect.
    void awaitClassEditsInFlight(projectId).then(() => { pressesRef.current.push({ dir, done }); setPressTick(t => t + 1); });
  }), [runNextPress, doc]);
  const undo = useCallback(() => press('undo'), [press]);
  const redo = useCallback(() => press('redo'), [press]);

  // Sync stack sizes with test helper for E2E tests
  React.useEffect(() => {
    if (typeof window !== 'undefined' && window.__STARQUIX_TEST__) {
      window.__STARQUIX_TEST__._setUndoStackSize?.(past.length);
      window.__STARQUIX_TEST__._setRedoStackSize?.(future.length);
    }
  }, [past.length, future.length]);

  return (
    <UndoContext.Provider value={{ canUndo, canRedo, undo, redo, takeSnapshot, claimSnapshot, createSnapshot, isUndoingRef, attachFileRecords, pushStructuralUndo }}>
      {children}
    </UndoContext.Provider>
  );
}

export function useUndoContext(): UndoContextValue {
  const context = useContext(UndoContext);
  if (!context) {
    throw new Error('useUndoContext must be used within UndoProvider');
  }
  return context;
}

/**
 * Undo IF a provider is present.
 *
 * For consumers whose undo integration is genuinely optional — the post-body
 * writes push a step when they can, and a missing provider means "no undo step",
 * not a crash. Anything that cannot function without undo must keep using
 * useUndoContext.
 */
export function useOptionalUndoContext(): UndoContextValue | null {
  return useContext(UndoContext);
}
