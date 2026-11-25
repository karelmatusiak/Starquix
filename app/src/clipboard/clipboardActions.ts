// Thin orchestration the keyboard hook calls: copy / cut / paste / duplicate.
// All deps injected — testable without React. Runtime routing:
//   local (files-truth) → pasteEnvelopeIntoLocal (real file writes)
//   everything else     → pasteEnvelopeIntoDoc (ONE PASTE_ELEMENTS dispatch)
import * as Y from 'yjs';
import type { ScannedElement } from '@/context/SelectionContext';
import type { EditorCommand } from '@/store/types';
import { pruneDescendants } from '@/store/multiSelect';
import type { MultiSelectionEntry } from '@/context/SelectionContext';
import { deleteEntries } from '@/hooks/keyboardShortcutsHelpers';
import { isSourceKeyedElementKey } from '@/components/Editor/localStructuralOps';
import type { PushStructuralUndo } from '@/store/structuralUndo';
import { isLocalProjectId } from '@/utils/localMode';
import { captureSelection } from './capture';
import { decodeEnvelopeHtml, encodeEnvelopeHtml, type ClipboardEnvelope } from './envelope';
import { writeClipboardHtml, readClipboardHtml } from './systemClipboard';
import { pasteEnvelopeIntoDoc } from './pasteDoc';
import { pasteEnvelopeIntoLocal } from './pasteLocal';
import { getSelectionEpoch } from '@/utils/localPendingSelection';
import { t } from '@/i18n';

export interface ClipboardActionDeps {
  doc: Y.Doc;
  entries: MultiSelectionEntry[];
  scannedByKey: Map<string, ScannedElement>;
  scannedElements: ScannedElement[];
  pageId: string;
  projectId: string;
  selectedElementId: string | null;
  selectedKey: string | null;
  pageFile: string | null;
  dispatch: import('@/store/durableDispatch').EditorDispatch;
  takeSnapshot: () => void;
  claimSnapshot?: () => import('@/store/documentMutation').MutationSnapshot | undefined;
  clearSelection: () => void;
  pushStructuralUndo: PushStructuralUndo;
  /** Local-runtime group delete (deleteLocalElementGroup bound by the hook —
   *  injected to avoid a hook↔service import cycle). */
  deleteLocalGroup: (members: MultiSelectionEntry[]) => Promise<void>;
  toast?: (msg: string) => void;
}

const isLocalRuntime = (projectId: string): boolean =>
  isLocalProjectId(projectId);

const prune = (deps: ClipboardActionDeps): MultiSelectionEntry[] =>
  pruneDescendants(deps.entries, (k) => deps.scannedByKey.get(k)?.parentKey);

async function routePaste(env: ClipboardEnvelope, deps: ClipboardActionDeps, duplicate: boolean, selectionEpoch: number): Promise<void> {
  if (isLocalRuntime(deps.projectId)) {
    if (!deps.pageFile) {
      deps.toast?.('This page has no source file yet — structural edits need a real page file');
      return;
    }
    await pasteEnvelopeIntoLocal(env, {
      scannedElements: deps.scannedElements,
      scannedByKey: deps.scannedByKey,
      selectedKey: deps.selectedKey,
      pageFile: deps.pageFile,
      pushUndo: deps.pushStructuralUndo,
      toast: deps.toast,
      duplicateOf: duplicate ? deps.selectedKey : null,
      selectionEpoch,
    });
    return;
  }
  await pasteEnvelopeIntoDoc(env, {
    doc: deps.doc,
    pageId: deps.pageId,
    targetProjectId: deps.projectId,
    selectedElementId: deps.selectedElementId,
    dispatch: deps.dispatch,
    takeSnapshot: deps.takeSnapshot,
    toast: deps.toast,
  });
}

export async function copySelection(deps: ClipboardActionDeps): Promise<boolean> {
  const env = await captureSelection(prune(deps), {
    doc: deps.doc,
    scannedByKey: deps.scannedByKey,
    toast: deps.toast,
  });
  if (!env) return false;
  const label = t('Starquix: {0}', { 0: env.roots.map((r) => r.label).join(', ') });
  const ok = await writeClipboardHtml(encodeEnvelopeHtml(env), label);
  if (ok) {
    const n = env.roots.length;
    deps.toast?.(n === 1 ? t('Copied 1 element') : t('Copied {0} elements', { 0: n }));
  }
  return ok;
}

export async function cutSelection(deps: ClipboardActionDeps): Promise<void> {
  const ok = await copySelection(deps);
  if (!ok) return;
  const survivors = prune(deps);
  if (isLocalRuntime(deps.projectId) && survivors.some((s) => isSourceKeyedElementKey(s.key))) {
    await deps.deleteLocalGroup(survivors);
    return;
  }
  deps.takeSnapshot();
  await deleteEntries(survivors, deps);
  deps.clearSelection();
}

export async function pasteClipboard(deps: ClipboardActionDeps): Promise<void> {
  const selectionEpoch = getSelectionEpoch(); // the keypress: reading the clipboard is async
  const html = await readClipboardHtml();
  if (html === null) {
    deps.toast?.(t('Nothing to paste'));
    return;
  }
  if (!html.includes('data-sq-clipboard')) return; // foreign clipboard content — not ours, stay silent
  const env = decodeEnvelopeHtml(html);
  if (!env) {
    deps.toast?.(t("Can't paste — copied with an older Starquix version"));
    return;
  }
  await routePaste(env, deps, false, selectionEpoch);
}

export async function duplicateSelection(deps: ClipboardActionDeps): Promise<void> {
  const selectionEpoch = getSelectionEpoch(); // the keypress: reading the copy takes a bridge round trip
  const env = await captureSelection(prune(deps), {
    doc: deps.doc,
    scannedByKey: deps.scannedByKey,
    toast: deps.toast,
  });
  if (!env) return;
  await routePaste(env, deps, true, selectionEpoch);
}
