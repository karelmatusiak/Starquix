/**
 * A refused write is never a silent wall (audit 2026-10-18). Edits land on
 * disk in order, so one edit the file no longer fits — an outside write
 * touched the same lines — holds back every later save. Edits the materializer
 * can re-apply never get here. This is the one message for the rest, and its
 * action is the only way past: discard that edit (the file keeps what is on
 * disk) and the later edits save. A write that only waits on the instance
 * (kind 'unknown') retries by itself and says nothing.
 */
import { useEffect } from 'react';
import { t } from '@/i18n';
import toast from 'react-hot-toast';

import { Button } from '@/components/ui';
import { PREVIEW_RELOAD_EVENT } from '@/components/Canvas/reloadPreview';
import {
  discardBlockedEdit, getMaterializationStatus, MaterializationFailure, subscribeMaterializationStatus,
} from '@/services/durableEdits/materializer';
import { setSaveConflictToastUp } from '@/utils/sourceActionFeedback';

export const SAVE_CONFLICT_TOAST_ID = 'sq-save-conflict';

function message(error: unknown): string {
  const file = error instanceof MaterializationFailure ? error.file?.split('/').pop() : undefined;
  return file ? t("Couldn't save a change: {0} changed outside Starquix.", { 0: file }) : t("Couldn't save a change: it no longer fits the file.");
}

export function useSaveConflictToast(projectId: string): void {
  useEffect(() => {
    let shown: { operationId: string; revision: number } | null = null;
    const sync = () => {
      const { issue, materializedRevision } = getMaterializationStatus(projectId);
      // A flush clears the issue while it retries: stay up until the edit lands or is discarded.
      if (shown && materializedRevision >= shown.revision) { shown = null; setSaveConflictToastUp(false); toast.dismiss(SAVE_CONFLICT_TOAST_ID); }
      if (issue?.kind !== 'deterministic' || shown?.operationId === issue.operationId) return;
      shown = { operationId: issue.operationId, revision: issue.revision };
      setSaveConflictToastUp(true);
      toast((t) => (
        <span className="flex items-center gap-2">
          {message(issue.error)}
          <Button variant="secondary" size="sm" label="Discard change" onClick={() => {
            setSaveConflictToastUp(false);
            toast.dismiss(t.id);
            // The canvas still paints the discarded edit: re-render it from the file.
            void discardBlockedEdit(projectId).then(() => window.dispatchEvent(new Event(PREVIEW_RELOAD_EVENT)), (error) => {
              console.error('[save conflict] discard failed', error);
              shown = null; sync();
            });
          }} />
        </span>
      ), { id: SAVE_CONFLICT_TOAST_ID, duration: Infinity });
    };
    sync();
    const unsubscribe = subscribeMaterializationStatus(sync);
    return () => { unsubscribe(); setSaveConflictToastUp(false); toast.dismiss(SAVE_CONFLICT_TOAST_ID); };
  }, [projectId]);
}
