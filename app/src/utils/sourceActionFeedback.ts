import toast from 'react-hot-toast';
import { t } from '@/i18n';

/** One toast per failed source action, carrying the REAL cause when there is
 * one. (8b4afaff hid every cause behind "was not confirmed. Check saving
 * before trying again" — copy the user could not act on; reverted 2026-09-16.) */
const copy = {
  'create-page': "Couldn't create the page",
  'delete-page': "Couldn't delete the page",
  'rename-page': "Couldn't rename the page",
  'delete-element': "Couldn't delete the element",
  'move-element': "Couldn't move the element",
  'wrap-elements': "Couldn't create the container",
  'unwrap-element': "Couldn't remove the container",
  draw: "Couldn't add the shape",
  insert: "Couldn't add the component",
  'prepare-insert': "Couldn't prepare the component for insertion",
  'keyboard-edit': 'Edit was not saved',
} as const;
export type SourceAction = keyof typeof copy;
export function sourceActionFailure(action: SourceAction, cause?: unknown): string {
  const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  return detail ? `${copy[action]}: ${detail}` : copy[action];
}

let saveConflictToastUp = false;
/** useSaveConflictToast reports when its toast is on screen. */
export function setSaveConflictToastUp(up: boolean): void { saveConflictToastUp = up; }

/** The one message for a component that did not open (Assets, AI): never an
 *  internal reason — callers log that — and nothing while the save-conflict
 *  toast already explains it (HN report 2026-11-09: one cause, one message). */
export function toastComponentOpenFailure(name: string): void {
  if (!saveConflictToastUp) toast.error(t("Couldn't open {0}. Try again.", { 0: name }));
}

/** Refusals that mean "the canvas shows bytes the file no longer has" — a
 * missed HMR reload, a deleted element still on screen. The file is fine;
 * the view is stale. Recovery = reload the preview, no message (owner
 * 2026-09-24: recover automatically rather than showing messages). */
const STALE_VIEW = /Source element has been deleted|does not match the projected source baseline|is not owned by this project|differs from its accepted projection|Source changed before acceptance/;

export function recoverStaleCanvas(cause: unknown): boolean {
  const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  if (!STALE_VIEW.test(detail)) return false;
  console.warn('[source] stale canvas — reloading the preview:', detail);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('sq:reload-preview'));
  return true;
}
