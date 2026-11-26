/**
 * Class Store Context
 *
 * Bridges DOM elements to EditorContext's sourceClasses map.
 * Handles element registration, class updates, and source file persistence.
 * All changes go through EditorContext dispatch for unified undo.
 */

import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import { t } from '@/i18n';
import * as Y from 'yjs';
import { useEditorDoc, useYjsValue } from '@/store/hooks';
import { applyCommand } from '@/store/commands';
import { baseMarkup, resolveOverrideClasses } from '@/store/masters';
import { sameTokenSet } from '@/core/classes/index';
import { useUndoContext } from './UndoContext';
import type { SourceLocation, Breakpoint } from '@/store/types';
import { parseKey } from '@/store/types';
import { parseSourceLocationFromKey, currentScannedSourceLocation } from '@/utils/sourceLocationKey';
import { getLocalScanVersion, subscribeLocalScan } from '@/utils/localPageSync';
import { getOriginalClassesFromMarkup } from '@/utils/markupQuery';
// Re-exported for existing importers/tests (helpers now live in utils/staticMarkup)
export { getOriginalAttributeFromMarkup, getOriginalAttributeOrWarn } from '@/utils/staticMarkup';
import { viteClassWriter } from '@/services/ViteClassWriter';
import { useSourceImageSync } from '@/hooks/useSourceImageSync';
import { selectProjectId } from '@/store/selectors';
import { useClassPersistenceQueue } from './hooks/useClassPersistenceQueue';
import { acceptProjectEdit } from '@/services/durableEdits/acceptance';
import { classCommands } from '@/services/durableEdits/classCommands';
import type { MaterializationCommand, DurableFileChange } from '@/services/durableEdits/types';
import { captureLocalWriteOrigin } from '@/utils/localWriteScope';
import toast from 'react-hot-toast';
import { setWriteDispatchedListener } from '@/services/BaseViteWriter';
import { stampFileValueForLine, SOURCE_OWNED_FIELD } from '@/store/sourceOverrideEntries';
import { capturePropOverride, preparePropOverrides, stampMasterFileValue } from '@/services/durableEdits/propOverrideCommands';
import { captureSourceClassTarget, currentSourceClassValue, prepareSourceClassTarget, applySourceClassTarget, stampAcceptedSourceClass,
  type PreparedClassTarget } from '@/services/durableEdits/sourceClassIdentity';
import {
  getClassWriteBaseline,
  noteClassWriteBaseline,
  resetClassWriteBaselines,
  setFileWrittenListener,
} from '@/services/classWriteBaseline';
import { requestClassRestore } from '@/components/Canvas/restoreOverrides';
import { useInstanceOverrideSync } from './hooks/useInstanceOverrideSync';
import { containsBlobUrl, stripBlobUrlTokens } from '@/utils/classSanitize';
import { stableContext } from '@/utils/stableContext';
import { commitMutationSnapshot, type MutationSnapshot } from '@/store/documentMutation';
import { pm, probeClassWrites } from '@/utils/probeMark';
import { clearIntentProject, dropClassIntent, intentOfOrigin, noteClassIntent, notePaintedKey, registerIntentOp, reserveIntentSeq,
  type IntentEntry } from '@/services/classIntents';
import type { ClassIntentTag } from '@/bridge/types';
import { trackClassEdit } from '@/services/inFlightClassEdits';
import { stashClear, stashPut } from '@/services/gestureStash';
import { useGestureStashReplay } from './hooks/useGestureStashReplay';

type ElementKey = string;

// blob: URLs are session-scoped resolution products — never persist them
// (ledger: docs/plans/2026-07-02-bg-image-blob-poisoning-fix-ledger.md)
const warnedBlobKeys = new Set<string>();
function warnBlobOnce(key: string, action: string): void {
  if (warnedBlobKeys.has(key)) return;
  warnedBlobKeys.add(key);
  console.warn(`[ClassStore] blob: URL in classes for ${key} — ${action} (session-scoped, never persisted)`);
}

/** Call-time paint: the canvas shows `classes` now, held under `seq` until the row that writes it lands. */
function paintDraft(projectId: string, key: string, classes: string, sourceLocation: SourceLocation | undefined,
  seq: { epoch: string; seq: number }, preview?: boolean): void {
  noteClassIntent(projectId, { key, epoch: seq.epoch, seq: seq.seq, classes, sourceLocation, rev: Infinity }, true);
  window.postMessage({ type: 'SYNC_CLASSES_TO_IFRAME', payload: { key, classes, sourceLocation, draft: true, ...(preview ? { preview: true } : {}),
    intent: { epoch: seq.epoch, seq: seq.seq, hold: true } } }, '*');
}

/** The intent a durable transaction's message carries for `key` (whether its file carries it = hold); registers the key's
 *  entry until its row lands. */
function tagIntent(projectId: string | null | undefined, tag: NonNullable<ReturnType<typeof intentOfOrigin>>, key: string,
  entry: Pick<IntentEntry, 'classes' | 'sourceLocation'>): ClassIntentTag {
  const hold = !!tag.holdKeys?.has(key);
  if (projectId && tag.rev !== null) noteClassIntent(projectId, { key, epoch: tag.epoch, seq: tag.seq, ...entry, rev: tag.rev }, hold);
  return { epoch: tag.epoch, seq: tag.seq, hold };
}

interface ClassEntry {
  /** Full class string */
  classes: string;
  /** Source location for persisting to file */
  sourceLocation?: SourceLocation;
}

type ClassStoreState = Record<ElementKey, ClassEntry>;

interface ClassStoreContextValue {
  /** Current state snapshot */
  state: ClassStoreState;
  /** Keys with unsaved changes */
  dirtyKeys: Set<ElementKey>;
  /** Whether there are any unsaved changes */
  hasUnsavedChanges: boolean;
  /** Counter that increments when instance classOverrides change (for re-render triggers) */
  instanceUpdateCounter: number;
  /** Save all pending changes immediately */
  saveAll: () => Promise<void>;
  /** Register an element and its initial classes */
  registerElement: (
    key: ElementKey,
    classes: string,
    sourceLocation?: SourceLocation
  ) => void;
  /** Update classes for an element (a batch of one — setClassesMany). */
  setClasses: (key: ElementKey, classes: string) => Promise<boolean>;
  /** A value gesture in flight (a stepper tick): paint + panel echo only. No journal row, no undo step, no file write;
   *  the gesture ends in setClasses (commit) or abortClassesPreview (abort). */
  previewClasses: (key: ElementKey, classes: string) => void;
  abortClassesPreview: (key: ElementKey) => void;
  /** Update several elements as ONE edit: one durable acceptance, one undo step,
   *  all-or-nothing (multi-select group edits — design ledger E1–E6,
   *  docs/plans/2026-11-16-multi-select-edit-design.md). */
  setClassesMany: (edits: readonly { key: ElementKey; classes: string }[]) => Promise<boolean>;
  /** Store truth for event-time reads: draft ?? entry, null when the store has never seen the key
   *  (callers fall back to the scan, like DesignBar's fullClasses). Instance children always resolve. */
  getStoredClasses: (key: ElementKey) => string | null;
  storageIssue: { key: string; operationId: string; message: string } | null;
  /** Get current classes for an element (from React state) */
  getClasses: (key: ElementKey) => string;
  /** Get current classes directly from YJS (avoids React state lag) */
  getClassesFromYjs: (key: ElementKey) => string;
  /** Get source location for an element */
  getSourceLocation: (key: ElementKey) => SourceLocation | undefined;
}

const ClassStoreContext = stableContext<ClassStoreContextValue | null>('ClassStoreContext', null);

interface ClassStoreProviderProps {
  children: React.ReactNode;
}

export const ClassStoreProvider: React.FC<ClassStoreProviderProps> = ({
  children
}) => {
  const doc = useEditorDoc();
  const projectId = useYjsValue(selectProjectId);
  const scanVersion = useSyncExternalStore(subscribeLocalScan, getLocalScanVersion, getLocalScanVersion);

  // A landed file write is the ↻ gate's "now" half, stated by the only source
  // that cannot be wrong: the write itself. Stamp it on every override entry
  // for that source line so the badge is correct the instant the user returns —
  // deriving it from a later DOM scan made it depend on which of the (measured:
  // five) bridge reloads after one master write a scan happened to land between.
  useEffect(() => {
    setFileWrittenListener((key, classes) => {
      stampFileValueForLine(doc, 'sourceClasses', key, classes);
    });
    return () => setFileWrittenListener(null);
  }, [doc]);

  // …and the same stamp at DISPATCH, because the ack above is routinely lost:
  // the file write makes the dev server HMR-reload the frame that owed us the
  // reply, so `wrote` never arrives and the badge never learned the master had
  // moved (measured 2026-08-05 — "Sent class write" with no result, five frame
  // reloads, and the user visiting Assets repeatedly before the badge showed).
  // Every write-scope check has already passed by dispatch, so the file is
  // about to hold this value; if it somehow does not, the scan's own observation
  // corrects it.
  useEffect(() => {
    setWriteDispatchedListener((messageType, payload) => {
      if (messageType !== 'SQ_WRITE_CLASSES') return;
      const loc = payload.sourceLocation as { file?: string; line?: number; column?: number } | undefined;
      const classes = payload.newClasses ?? payload.classes;
      if (!loc?.file || typeof loc.line !== 'number' || typeof loc.column !== 'number') return;
      if (typeof classes !== 'string') return;
      stampFileValueForLine(doc, 'sourceClasses', `${loc.file}:${loc.line}:${loc.column}`, classes);
    });
    return () => setWriteDispatchedListener(null);
  }, [doc]);
  const { takeSnapshot, claimSnapshot, isUndoingRef } = useUndoContext();

  // Local state for quick access
  const [state, setState] = useState<ClassStoreState>({});
  const drafts = useRef(new Map<string, { operationId: string; classes: string }>());
  const readCommittedClass = useRef<(key: string) => string>(() => '');
  const [storageIssue, setStorageIssue] = useState<ClassStoreContextValue['storageIssue']>(null);

  // Refs for tracking
  const stateRef = useRef(state);
  // Current selection registrations are not historical undo addresses.
  const currentSourceLocations = useRef(new Map<ElementKey, SourceLocation>());
  useEffect(() => () => { currentSourceLocations.current.clear(); }, [doc, projectId]);

  stateRef.current = state;

  // Deferred class persistence (dirty keys, idle-save timer, unmount flush)
  // lives in the extracted queue hook; the getter reads through stateRef so
  // flushes always see the latest entries.
  const { dirtyKeys, hasUnsavedChanges, saveAll } = useClassPersistenceQueue(projectId);

  // Are we inside an undo/redo right now?
  //
  // task-150: this used to be derived from `doc.on('update')`'s transaction
  // origin, and it was WRONG on the only ⌘Z that matters. Yjs emits type
  // observers BEFORE the update event — measured against the repo's own yjs
  // with a 4-line probe: `observer | update:sync | observer | update:undo`. So
  // during the sourceClasses observer run for an undo, the ref still held the
  // PREVIOUS transaction's origin ('user' after any edit), and every branch
  // gated on it — the removal restore, the immediate undo write — was skipped
  // on the first ⌘Z after any user or sync transaction.
  //
  // UndoContext.isUndoingRef is the authoritative signal (set around
  // applySnapshot, which runs the transactions synchronously) and is what
  // ViewportFrame's sourceText observer has always read. One signal, no lag.
  //
  // Read through a ref-of-the-ref so this callback keeps a STABLE identity: it
  // is a dependency of the sourceClasses observer effect and of
  // useSourceImageSync's, so a new identity per render tears down and re-adds
  // both observers on every render — an unbounded loop with any provider (or
  // test double) that does not hand back the same ref object every time.
  const undoFlagRef = useRef(isUndoingRef);
  undoFlagRef.current = isUndoingRef;
  const isUndoingOrRedoing = useCallback(() => undoFlagRef.current?.current === true, []);

  useSourceImageSync(doc, isUndoingOrRedoing, useYjsValue(selectProjectId));

  // Sync state from EditorContext.sourceClasses
  const prevStateRef = useRef<ClassStoreState>({});

  // Tracks the classes each key had when it was FIRST registered.
  // Used to revert the iframe when a key is removed during undo (e.g. AI-registered elements).
  const initialClassesRef = useRef<Record<ElementKey, string>>({});

  // The class-write baseline registry is a module singleton (it has to be —
  // `persistClassToFile` and store/localMasterOverrides both read it and
  // neither is a component). Element keys are project-RELATIVE paths, so two
  // local projects can produce the same key for different files; drop the lot
  // on teardown. Cleanup only, never on mount: the observer below seeds the
  // registry from the doc in its first run, and a mount-time clear would race
  // it depending on effect order.
  useEffect(() => resetClassWriteBaselines, []);

  useEffect(() => {
    const sourceClasses = doc.getMap('sourceClasses');

    const syncState = (_events?: unknown, transaction?: Y.Transaction) => {
      pm('v2:write', () => probeClassWrites(_events as Parameters<typeof probeClassWrites>[0], transaction)); // runtime probe: every class write on the live doc, with its origin
      const next: ClassStoreState = {};

      sourceClasses.forEach((yEntry, key) => {
        const entry = yEntry as Y.Map<unknown>;
        const classes = entry.get('classes') as string || '';
        const ySourceLoc = entry.get('sourceLocation') as Y.Map<unknown> | undefined;

        let sourceLocation: SourceLocation | undefined;
        if (ySourceLoc) {
          sourceLocation = {
            file: ySourceLoc.get('file') as string,
            line: ySourceLoc.get('line') as number,
            column: ySourceLoc.get('column') as number,
            ...(ySourceLoc.has('sourceVersion') ? { sourceVersion: ySourceLoc.get('sourceVersion') as string } : {}),
            ...(ySourceLoc.has('sourceRevision') ? { sourceRevision: ySourceLoc.get('sourceRevision') as number } : {}),
          };
        }
        // Fallback: sourceKey encodes file:line:column — derive location if Y.Map has none
        if (!sourceLocation) {
          sourceLocation = parseSourceLocationFromKey(key) ?? undefined;
        }

        next[key] = { classes, sourceLocation };
      });

      // Detect changes
      const prev = prevStateRef.current;
      const isUndoing = isUndoingOrRedoing();
      const editedKeys: ElementKey[] = [];

      Object.keys(next).forEach(key => {
        if (!prev[key]) {
          // New key: record its registration-time classes so we can revert on undo.
          // A setClasses-created key (Layers-panel selection — no registerElement)
          // lands here carrying the EDITED value; the scan-seeded baseline holds
          // what the FILE rendered before the edit, which is the only honest
          // undo-restore target (layout-element paradigm 2026-08-24 — the layout
          // <body> is Layers-only, so its first-edit ⌘Z always took this path and
          // "restored" the edit itself: a byte-identical no-op write).
          if (!(key in initialClassesRef.current)) {
            initialClassesRef.current[key] = getClassWriteBaseline(key) ?? next[key].classes;
          }
          // Seed the legacy/direct-writer cache only if absent. Durable class
          // commands carry their accepted baseline separately; an overlay is
          // not proof that the file has already materialized that value.
          noteClassWriteBaseline(key, next[key].classes);
          // …and if setClasses created it, it is an EDIT, not a baseline.
          // Never widen this to all new keys: registerElement (every canvas
          // click) and restoreSourceClasses (every persisted overlay entry at
          // boot) also land here, but do not authorize an edit repaint. Source
          // writes are owned separately by their accepted journal commands.
          //
          // An undo/redo is the third way a key can appear, and for repaint
          // purposes it is just a value change from the source value to the
          // override value — so it takes the same path (task-151). This is the
          // branch that made ⌘Z after "Reset to master" restore the doc and
          // repaint NOTHING: the removal case had a branch, the restore case
          // had none. isUndoing cannot leak into the two cases above — they are
          // 'sync'/'user' transactions.
          if (isUndoing || String(transaction?.origin).startsWith('durable-edit:class-edit:')) {
            editedKeys.push(key);
          }
        } else if (prev[key].classes !== next[key].classes) {
          editedKeys.push(key);
        }
      });

      // Detect keys that were removed from Yjs (undo of a FIRST edit, redo of a
      // "Reset to master", undo of an AI-registered element). "Removed" means
      // "go back to what the SOURCE renders", which is a different value from
      // anything in the doc — so this asks the iframe for the baseline it
      // captured before it applied the first override, rather than posting a
      // value (task-151). `initialClassesRef` rides along as the fallback for
      // the case where this bridge never applied an override for the key, which
      // is byte-identical to what this branch used to post on its own.
      //
      // Undo's accepted commands, not this repaint observer, own source writes.
      if (isUndoing) {
        Object.keys(prev).forEach(key => {
          if (!next[key]) {
            const originalClasses = initialClassesRef.current[key] ?? '';
            const sourceLocation = prev[key].sourceLocation;
            const tag = intentOfOrigin(projectId, transaction?.origin);
            requestClassRestore({ key, fallbackClasses: originalClasses, sourceLocation,
              ...(tag ? { intent: tagIntent(projectId, tag, key, { classes: null }) } : {}) });
          }
        });
      }

      prevStateRef.current = next;

      // Update React state
      const visible = { ...next };
      for (const [key, draft] of drafts.current) visible[key] = { ...visible[key], classes: draft.classes };
      stateRef.current = visible;
      setState(visible);

      // Sync edited keys to iframe
      editedKeys.forEach(key => {
        const entry = next[key];
        if (entry) {
          const target = projectId ? captureSourceClassTarget(projectId, key) : undefined;
          const current = sourceClasses.get(key) as Y.Map<unknown> | undefined;
          const value = currentSourceClassValue(current, target, doc) ?? entry.classes;
          pm('v2:sync', () => ({ key: key.slice(-14), op: String(transaction?.origin).slice(-6), v: value.slice(-60), e: entry.classes.slice(-60), s: target?.classes?.slice(-60) ?? null,
            sv: target?.sourceLocation.sourceVersion?.slice(0, 10) ?? null, ov: entry.sourceLocation?.sourceVersion?.slice(0, 10) ?? null }));
          // The call-order number of the durable edit this value came from, and whether its file carries it:
          // the canvas applies only the newest seq per key and holds a written value until its row lands.
          const tag = intentOfOrigin(projectId, transaction?.origin);
          // painted: the writer already put this value on the canvas at call time; a canvas that understands intents
          // skips this message (only the revision binding below remained), an older bridge applies it as before.
          const painted = !!tag?.painted.has(key);
          const sourceLocation = target?.sourceLocation ?? entry.sourceLocation;
          const intent = tag && tagIntent(projectId, tag, key, { classes: value, sourceLocation });
          window.postMessage({
            type: 'SYNC_CLASSES_TO_IFRAME',
            payload: {
              key,
              classes: value,
              sourceLocation,
              ...(intent ? { intent } : {}),
              ...(painted ? { painted: true } : {}),
            }
          }, '*');
        }

        // Source commands were accepted atomically with this publication.
      });
    };

    // Initial sync
    syncState();

    // Subscribe to changes
    sourceClasses.observeDeep(syncState);

    return () => {
      sourceClasses.unobserveDeep(syncState);
    };
  }, [doc, projectId, isUndoingOrRedoing]);

  // Nothing of project A's unlanded class intents may outlive it and hold onto B's same-keyed element.
  useEffect(() => () => { if (projectId) clearIntentProject(projectId); }, [projectId]);

  // Counter to force re-renders when instance classOverrides change
  const [instanceUpdateCounter, setInstanceUpdateCounter] = useState(0);
  const bumpInstanceCounter = useCallback(() => setInstanceUpdateCounter(c => c + 1), []);

  // THE single unified observeDeep on `elements` (classes + text + images,
  // path-scoped, undo-restore refs) lives in useInstanceOverrideSync —
  // task-014a decision: exactly ONE observer, never split.
  useInstanceOverrideSync(doc, bumpInstanceCounter);

  const registerElement = useCallback(
    (key: ElementKey, classes: string, sourceLocation?: SourceLocation) => {
      if (!key || typeof key !== 'string') {
        console.warn('[ClassStore] Invalid key:', key);
        return;
      }

      const safeClasses = typeof classes === 'string' ? classes : '';
      const existing = stateRef.current[key];
      if (sourceLocation) currentSourceLocations.current.set(key, { ...sourceLocation });

      if (existing) {
        // The ref owns the live selection address. The doc location still
        // identifies these classes and their historical baseline until the
        // next accepted edit proves whether this is the same source element.
        // Element exists - skip if a file write is pending for this key
        const loc = sourceLocation ?? existing.sourceLocation ?? parseSourceLocationFromKey(key);
        const sourceKey = loc ? `${loc.file}:${loc.line}:${loc.column}` : key;
        if (dirtyKeys.has(sourceKey) || drafts.current.has(key)) {
          return;
        }

        if (containsBlobUrl(safeClasses)) {
          warnBlobOnce(key, 'ignoring external overwrite');
          return;
        }

        if (existing.classes !== safeClasses) {
          // External change - update without undo tracking
          pm('v2:reg', () => ({ b: 'external', key: key.slice(-14), old: existing.classes.slice(-60), now: safeClasses.slice(-60) }));
          const sourceClasses = doc.getMap('sourceClasses');
          doc.transact(() => {
            const yEntry = sourceClasses.get(key) as Y.Map<unknown>;
            if (yEntry) {
              yEntry.set('classes', safeClasses);
            }
          }, 'sync'); // 'sync' origin - not tracked by UndoManager
        }
        return;
      }

      // New element - register it (sync origin: not tracked by undo)
      const registeredClasses = containsBlobUrl(safeClasses)
        ? (warnBlobOnce(key, 'stripping before register'), stripBlobUrlTokens(safeClasses))
        : safeClasses;
      pm('v2:reg', () => ({ b: 'new', key: key.slice(-14), now: registeredClasses.slice(-60) }));
      doc.transact(() => {
        applyCommand(doc, {
          type: 'REGISTER_SOURCE_ELEMENT',
          sourceKey: key,
          classes: registeredClasses,
          sourceLocation
        });
      }, 'sync');
    },
    [doc, dirtyKeys]
  );

  /** Put the canvas back to the ACCEPTED value of `key` after a rejected paint or an aborted preview — unless a NEWER paint of
   *  the key exists (it is the canvas's truth now). The accepted value is read from the Y entry ALONE: after a paint the latest
   *  scan holds the REJECTED draft. A fresh seq beats the rejected paint; an earlier accepted-but-unlanded write holds again. */
  const restoreCanvas = useCallback((key: ElementKey, paintSeq: number, sourceLocation: SourceLocation | undefined) => {
    if (!projectId) return;
    const rolled = dropClassIntent(projectId, key, paintSeq);
    if (!rolled.current) return;
    const accepted = doc.getMap<Y.Map<unknown>>('sourceClasses').get(key)?.get('classes') as string | undefined;
    const fresh = reserveIntentSeq();
    if (rolled.previous) noteClassIntent(projectId, { ...rolled.previous, epoch: fresh.epoch, seq: fresh.seq }, true);
    if (accepted !== undefined) {
      window.postMessage({ type: 'SYNC_CLASSES_TO_IFRAME', payload: { key, classes: accepted, sourceLocation, draft: true,
        intent: { epoch: fresh.epoch, seq: fresh.seq, hold: !!rolled.previous } } }, '*');
    } else requestClassRestore({ key, fallbackClasses: '', sourceLocation, intent: { epoch: fresh.epoch, seq: fresh.seq, hold: false } });
  }, [doc, projectId]);

  const previewSeqs = useRef(new Map<string, number>());
  const previewClasses = useCallback((key: ElementKey, classes: string): void => {
    if (!key || typeof key !== 'string' || !projectId || parseKey(key)?.type === 'instance-child') return;
    const safeClasses = stripBlobUrlTokens(typeof classes === 'string' ? classes : '');
    const sourceLocation = currentScannedSourceLocation(projectId, key) ?? currentSourceLocations.current.get(key)
      ?? stateRef.current[key]?.sourceLocation ?? parseSourceLocationFromKey(key) ?? undefined;
    const seq = reserveIntentSeq();
    previewSeqs.current.set(key, seq.seq);
    // The draft makes every reader (panel echo, the next tick's base, registerElement) see the previewed value.
    drafts.current.set(key, { operationId: `preview:${seq.seq}`, classes: safeClasses });
    stateRef.current = { ...stateRef.current, [key]: { classes: safeClasses, sourceLocation } };
    setState(stateRef.current);
    paintDraft(projectId, key, safeClasses, sourceLocation, seq, true);
  }, [projectId]);

  const abortClassesPreview = useCallback((key: ElementKey): void => {
    const seq = previewSeqs.current.get(key);
    previewSeqs.current.delete(key);
    const draft = drafts.current.get(key);
    if (!draft || !draft.operationId.startsWith('preview:')) return;   // committed or replaced meanwhile: nothing to put back
    drafts.current.delete(key);
    const sourceLocation = stateRef.current[key]?.sourceLocation;
    stateRef.current = { ...stateRef.current, [key]: { classes: readCommittedClass.current(key), sourceLocation } };
    setState(stateRef.current);
    if (seq !== undefined) restoreCanvas(key, seq, sourceLocation);
  }, [restoreCanvas]);

  // ONE writer for every class edit: a single edit is a batch of one. A group
  // (multi-select) is ONE acceptance, ONE undo snapshot and N per-kind commands;
  // any member's refusal rejects the whole group (ledger E1–E3).
  const setClassesManyNow = useCallback(async (edits: readonly { key: ElementKey; classes: string }[]): Promise<boolean> => {
    const valid = edits.filter(e => e.key && typeof e.key === 'string');
    if (valid.length === 0) return false;
    const operationId = `class-edit:${crypto.randomUUID()}`;
    const origin = captureLocalWriteOrigin();
    const members = valid.map(({ key, classes }) => {
      const safeClasses = stripBlobUrlTokens(typeof classes === 'string' ? classes : '');
      const sourceLocation = currentScannedSourceLocation(projectId, key) ?? currentSourceLocations.current.get(key)
        ?? stateRef.current[key]?.sourceLocation ?? parseSourceLocationFromKey(key) ?? undefined;
      return {
        key, safeClasses, sourceLocation,
        target: projectId ? captureSourceClassTarget(projectId, key, sourceLocation) : undefined,
        // An instance edit on a page lives in files as props (utils/propOverrides.ts).
        propTarget: capturePropOverride(key, sourceLocation, origin),
        preparedTarget: undefined as PreparedClassTarget | undefined,
      };
    });
    for (const m of members) pm('cls:set', () => ({ key: m.key.slice(-14), cls: m.safeClasses.slice(-40), op: operationId.slice(-6) }));
    // A group refusal names the element it came from (E3); a single edit keeps today's text.
    const named = (member: (typeof members)[number], error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (members.length === 1) return error;
      const loc = member.sourceLocation;
      return new Error(`${message} — ${loc ? `${loc.file}:${loc.line}` : member.key}`);
    };
    let acceptedRevision = 0;
    // The safety net first, synchronously: until the lane accepts this edit it exists only on screen (stash = localStorage).
    if (projectId) for (const m of members) stashPut({ projectId, key: m.key, classes: m.safeClasses, baseline: readCommittedClass.current(m.key), origin, opId: operationId });
    for (const m of members) drafts.current.set(m.key, { operationId, classes: m.safeClasses });
    stateRef.current = { ...stateRef.current,
      ...Object.fromEntries(members.map(m => [m.key, { classes: m.safeClasses, sourceLocation: m.sourceLocation }])) };
    setState(stateRef.current); setStorageIssue(null);
    // Call-time paint (instant-edit P1): the canvas shows the value NOW, not when the acceptance lane gets to it.
    // The call-order number is reserved here — ONE per operation, the bridge gates per key — so the paint, the lane op and the
    // doc observer share it and the bridge drops anything older. A document that did not announce intents ignores the draft
    // (ViewportFrame) and gets the observer's value at acceptance, as before. Instance-child keys keep per-event commits.
    const seq = reserveIntentSeq();
    if (projectId) {
      registerIntentOp(projectId, operationId, seq);
      for (const m of members) {
        if (parseKey(m.key)?.type === 'instance-child') continue;
        notePaintedKey(projectId, operationId, m.key);
        paintDraft(projectId, m.key, m.safeClasses, m.sourceLocation, seq);
      }
    }
    const commands: MaterializationCommand[] = [];
    // The keys whose value is carried by a source file once their row materializes: the canvas holds them until then.
    const holdKeys = new Set<string>();
    let sourceSnapshot: MutationSnapshot | undefined;
    let commitSnapshot: () => void = () => {};
    try {
      if (!projectId) throw new Error('Project storage is not ready');
      await acceptProjectEdit(doc, { projectId, operationId, commands, holdKeys, intentSeq: seq,
        // Only a single edit supersedes an older un-started one of the same key and origin: a group covers several keys, so an
        // older slot is never fully replaced by it.
        supersedeKey: members.length === 1 ? `${members[0].key}\u0000${JSON.stringify(origin)}` : undefined,
        prepare: async revision => {
          acceptedRevision = revision + 1;
          for (const m of members) {
            try {
              m.preparedTarget = await prepareSourceClassTarget(projectId,
                doc.getMap<Y.Map<unknown>>('sourceClasses').get(m.key), m.target, revision, doc);
            } catch (error) { throw named(m, error); }
          }
          const props = members.flatMap(m => m.propTarget ? [{ target: m.propTarget, value: m.safeClasses, key: m.key }] : []);
          if (props.length) {
            const files = await preparePropOverrides(projectId, revision, props);
            if (files) { commands.push(files); for (const p of props) holdKeys.add(p.key); }
          }
        },
        mutate: staged => {
          // ONE undo snapshot for the group, taken before any member changes (E5).
          // Both class commands share one snapshot scope (UndoContext CLASS_EDIT_SCOPE).
          const isInstanceChild = (key: string) => parseKey(key)?.type === 'instance-child';
          if (members.every(m => isInstanceChild(m.key))) {
            commitSnapshot = takeSnapshot(undefined, 'UPDATE_THEME_INSTANCE_CLASS_OVERRIDE', true) || (() => {});
          } else if (claimSnapshot) {
            takeSnapshot(undefined, 'UPDATE_SOURCE_CLASSES');
            sourceSnapshot = claimSnapshot();
            sourceSnapshot?.stage(staged);
            commitSnapshot = () => commitMutationSnapshot(sourceSnapshot);
          } else commitSnapshot = takeSnapshot(undefined, 'UPDATE_SOURCE_CLASSES', true) || (() => {});
          for (const m of members) {
            const { key, safeClasses, sourceLocation, propTarget, preparedTarget } = m;
            try {
              const parsed = parseKey(key);
              if (parsed?.type === 'instance-child') {
                const { instanceId, selector } = parsed;
                const tokens = safeClasses.split(/\s+/).filter(Boolean);
                const instance = staged.getMap('elements').get(instanceId) as Y.Map<unknown> | undefined;
                const markup = instance ? baseMarkup(staged, instance) : '';
                const original = markup ? getOriginalClassesFromMarkup(markup, selector) || '' : '';
                applyCommand(staged, { type: 'UPDATE_THEME_INSTANCE_CLASS_OVERRIDE', instanceId, selector,
                  breakpoint: 'base', classes: instance && sameTokenSet(tokens, original) ? null : tokens });
              } else {
                applySourceClassTarget(staged, key, preparedTarget);
                const entry = staged.getMap<Y.Map<unknown>>('sourceClasses').get(key);
                // Acceptance is serialized: this is the prior ACCEPTED class value,
                // never a preceding speculative draft which might have been rejected.
                const baseline = entry?.get('classes') as string | undefined
                  ?? staged.getMap<string>('acceptedSourceClassTargets').get(key) ?? getClassWriteBaseline(key) ?? null;
                const writes = classCommands(sourceLocation, safeClasses, baseline, origin);
                commands.push(...writes);
                // This accepted target survives first-edit undo deleting the overlay.
                // It is checkpointed with the command, never inferred from a file cache.
                if (writes.length) { staged.getMap<string>('acceptedSourceClassTargets').set(key, safeClasses); holdKeys.add(key); }
                applyCommand(staged, { type: 'UPDATE_SOURCE_CLASSES', sourceKey: key, classes: safeClasses, originalClasses: baseline ?? undefined, sourceLocation });
                if (propTarget) stampMasterFileValue(staged, key);
                if (writes.length) staged.getMap<Y.Map<unknown>>('sourceClasses').get(key)?.set(SOURCE_OWNED_FIELD, '1');
                if (writes.length) stampAcceptedSourceClass(staged, sourceLocation, safeClasses, baseline, acceptedRevision, preparedTarget);
              }
            } catch (error) { throw named(m, error); }
          }
        } });
      for (const m of members) pm('cls:accepted', () => ({ key: m.key.slice(-14), typed: m.safeClasses.slice(-60), doc: String(doc.getMap<Y.Map<unknown>>('sourceClasses').get(m.key)?.get('classes')).slice(-60) }));
      // Several members in one file are consecutive steps (S0→S1→…→Sn); undo checks ONE baseline
      // per file, so attach one change per file: first before, last after, identity maps in order
      // (the same accumulation prepareClassIdentity.ts uses). A single edit has one step per file.
      const files = new Map<string, DurableFileChange>();
      for (const change of commands.flatMap(command => command.kind === 'class-write' ? command.payload.preparedFiles ?? []
        : command.kind === 'file-batch' ? command.payload.files : [])) {
        const prior = files.get(change.file);
        files.set(change.file, prior ? { ...change, beforeSource: prior.beforeSource,
          identityMaps: [...prior.identityMaps ?? [], ...change.identityMaps ?? []] } : change);
      }
      try {
        if (files.size) sourceSnapshot?.attachFiles?.([...files.values()]);
      } catch (error) { console.error('Source inverse observer failed after durable acceptance', error); }
      commitSnapshot();
      if (projectId) for (const m of members) stashClear(projectId, m.key, operationId);
      for (const m of members) if (drafts.current.get(m.key)?.operationId === operationId) drafts.current.delete(m.key);
      setState(current => ({ ...current }));
      return true;
    } catch (error) {
      // All-or-nothing (E2/E3): every member whose draft is still ours reverts together.
      const ours = members.filter(m => drafts.current.get(m.key)?.operationId === operationId);
      if (ours.length) {
        for (const m of ours) drafts.current.delete(m.key);
        stateRef.current = { ...stateRef.current,
          ...Object.fromEntries(ours.map(m => [m.key, { classes: readCommittedClass.current(m.key), sourceLocation: m.sourceLocation }])) };
        setState(stateRef.current);
        const message = error instanceof Error ? error.message : String(error);
        setStorageIssue({ key: members[0].key, operationId, message });
        toast.error(t("Style not saved: {0}", { 0: message }));
      }
      for (const m of members) {
        if (projectId) stashClear(projectId, m.key, operationId);
        restoreCanvas(m.key, seq.seq, m.sourceLocation);
      }
      return false;
    }
  }, [doc, projectId, takeSnapshot, claimSnapshot, restoreCanvas]);

  // Tracked so an undo pressed while an edit is still in flight waits for it (services/inFlightClassEdits.ts).
  const setClassesMany = useCallback((edits: readonly { key: ElementKey; classes: string }[]): Promise<boolean> =>
    trackClassEdit(projectId, setClassesManyNow(edits)), [projectId, setClassesManyNow]);

  const setClasses = useCallback((key: ElementKey, classes: string): Promise<boolean> =>
    (key && typeof key === 'string') ? setClassesMany([{ key, classes }]) : Promise.resolve(false), [setClassesMany]);

  const getClasses = useCallback(
    (key: ElementKey): string => {
      if (drafts.current.has(key)) return drafts.current.get(key)!.classes;
      return currentSourceClassValue(doc.getMap<Y.Map<unknown>>('sourceClasses').get(key),
        projectId ? captureSourceClassTarget(projectId, key) : undefined, doc) ?? stateRef.current[key]?.classes ?? '';
    },
    [doc, projectId]
  );

  const getClassesFromYjs = useCallback(
    (key: ElementKey, breakpoint: Breakpoint = 'base'): string => {
      const draft = drafts.current.get(key);
      if (draft) return draft.classes;
      // Check if this is an instance child key (format: instanceId:selector)
      const parsed = parseKey(key);

      if (parsed?.type === 'instance-child') {
        // This is an instance child - get merged classes from staticMarkup + classOverrides
        const { instanceId, selector } = parsed;
        const elements = doc.getMap('elements');
        const instance = elements.get(instanceId) as Y.Map<unknown> | undefined;

        if (!instance) return '';

        // Resolve the base via the masters overlay (overlay wins), NOT the raw
        // staticMarkup. The editor element's staticMarkup is re-scanned from the
        // WC source `.astro` (which dev never rewrites), so a removed master
        // class reappears here on reopen even though the baked overlay dropped
        // it. baseMarkup is what every other read path uses (canvas, bake) —
        // this was the lone hold-out (task-082).
        const resolvedBase = baseMarkup(doc, instance);
        const classOverrides = instance.get('classOverrides') as Y.Map<unknown> | undefined;

        // Get original classes from the resolved base markup
        const originalClasses = resolvedBase
          ? getOriginalClassesFromMarkup(resolvedBase, selector)
          : '';

        // Get override classes for this selector with breakpoint cascade.
        // overrideTokens stays null when there is NO override entry (→ base);
        // an existing entry yields its tokens (possibly [] = cleared all).
        let overrideTokens: string[] | null = null;
        if (classOverrides) {
          const selectorOverride = classOverrides.get(selector) as Y.Map<Y.Array<string>> | undefined;
          if (selectorOverride) {
            // Cascade through breakpoints (base -> sm -> md -> lg -> xl -> 2xl)
            // to get the effective override at the requested breakpoint
            const breakpointOrder: Breakpoint[] = ['base', 'sm', 'md', 'lg', 'xl', '2xl'];
            const targetIndex = breakpointOrder.indexOf(breakpoint);

            // Collect overrides from base up to the requested breakpoint
            let effectiveOverrides: string[] = [];
            for (let i = 0; i <= targetIndex; i++) {
              const overrideArray = selectorOverride.get(breakpointOrder[i]) as Y.Array<string> | undefined;
              if (overrideArray && overrideArray.length > 0) {
                effectiveOverrides = overrideArray.toArray();
              }
            }
            overrideTokens = effectiveOverrides;
          }
        }

        // The override is authoritative (replace, not union); empty = cleared
        // all; absent = base. Single rule shared with the live sync (task-082).
        return resolveOverrideClasses(originalClasses, overrideTokens);
      }

      // Regular source element
      const sourceClasses = doc.getMap('sourceClasses');
      const yEntry = sourceClasses.get(key) as Y.Map<unknown> | undefined;
      return currentSourceClassValue(yEntry, projectId ? captureSourceClassTarget(projectId, key) : undefined, doc) ?? '';
    },
    [doc, projectId]
  );

  const getStoredClasses = useCallback((key: ElementKey): string | null => {
    if (parseKey(key)?.type === 'instance-child') return getClassesFromYjs(key);
    return drafts.current.has(key) || stateRef.current[key] ? getClassesFromYjs(key) : null;
  }, [getClassesFromYjs]);

  const getSourceLocation = useCallback(
    (key: ElementKey): SourceLocation | undefined => {
      return currentScannedSourceLocation(projectId, key) ?? currentSourceLocations.current.get(key) ?? stateRef.current[key]?.sourceLocation;
    },
    [projectId]
  );

  // The draft is removed before rollback calls this reader, so both source
  // and instance controls restore the canonical accepted value.
  readCommittedClass.current = getClassesFromYjs;

  // A reload, crash or kill inside a typed number's settle window or a stepper burst left an intent only the stash knows.
  useGestureStashReplay(projectId, getClassesFromYjs, setClasses);


  const value = useMemo<ClassStoreContextValue>(
    () => ({
      state: Object.fromEntries(Object.entries(state).map(([key, entry]) => [key, { ...entry, classes: getClasses(key) }])),
      dirtyKeys,
      hasUnsavedChanges: hasUnsavedChanges || drafts.current.size > 0,
      instanceUpdateCounter,
      saveAll,
      registerElement,
      setClasses,
      previewClasses,
      abortClassesPreview,
      setClassesMany,
      storageIssue,
      getClasses,
      getClassesFromYjs,
      getStoredClasses,
      getSourceLocation
    }),
    [
      state,
      scanVersion,
      dirtyKeys,
      hasUnsavedChanges,
      instanceUpdateCounter,
      saveAll,
      registerElement,
      setClasses,
      previewClasses,
      abortClassesPreview,
      setClassesMany,
      storageIssue,
      getClasses,
      getClassesFromYjs,
      getStoredClasses,
      getSourceLocation
    ]
  );

  return (
    <ClassStoreContext.Provider value={value}>
      {children}
    </ClassStoreContext.Provider>
  );
};

export const useClassStore = (): ClassStoreContextValue => {
  const context = useContext(ClassStoreContext);
  if (!context) {
    throw new Error('useClassStore must be used within a ClassStoreProvider');
  }
  return context;
};

/**
 * The element's classes as the `sourceClasses` tier knows them, or `null` when
 * the tier has NO entry for the key.
 *
 * ABSENCE AND EMPTINESS ARE DIFFERENT ANSWERS (task-149 review fix). Returning
 * '' for both let DesignBar's `||` fallback chain treat "the user just deleted
 * every class" as "we don't know this element", fall through to the scan / click
 * payload, and RESURRECT the deleted classes on the next colour click. Callers
 * must gate on presence (`??`), never on truthiness.
 *
 * An instance-child always resolves through the doc, which IS the truth for it,
 * so it is always "present" — including when it legitimately has no classes.
 */
export const useElementClasses = (key: ElementKey | null): string | null => {
  const { state, getClassesFromYjs, instanceUpdateCounter } = useClassStore();
  if (!key) return null;

  // For instance keys, ALWAYS compute from Yjs (staticMarkup + classOverrides)
  // Don't use sourceClasses state which becomes stale after edits
  const parsed = parseKey(key);
  if (parsed?.type === 'instance-child') {
    // Reference counter to ensure hook re-runs when instance overrides change
    void instanceUpdateCounter;
    return getClassesFromYjs(key);
  }

  // Regular source elements use state from sourceClasses. Presence of the
  // entry is the answer — an entry holding '' means "this element has no
  // classes", not "unknown".
  return state[key] ? getClassesFromYjs(key) : null;
};
