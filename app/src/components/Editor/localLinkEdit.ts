/**
 * The Design Bar's link writes, the same gesture as a field bind
 * (localFieldBind): guards → read → pure rewrite (utils/linkSource) → ONE
 * whole-file write with a whole-file ⌘Z. Files are truth: nothing goes in the doc.
 */
import toast from 'react-hot-toast';
import { t } from '@/i18n';
import { markLocalScanStaleAfterWrite } from '@/utils/localPageSync';
import { captureLocalElementOrigin, isCrossFileAtOrigin, notifyLocalCrossFileWrite } from '@/utils/localWriteScope';
import { acquireStructuralWrite, releaseStructuralWrite } from '@/store/structuralWriteGuard';
import { readLocalFile } from '@/utils/localElementSource';
import { currentSourceLocation, settleAcceptedWrites } from '@/utils/acceptedSource';
import { movedKey, noteLinkKeyMove, removeLinkSource, setLinkAttribute, wrapLinkSource } from '@/utils/linkSource';
import type { ScannedElement } from '@/context/SelectionContext';
import type { PushStructuralUndo } from '@/store/structuralUndo';
import type { SourceLocation } from '@/store/types';
import { commitWholeLocalFile } from './localBlogBind';

/**
 * A link edit in its write turn (owner 2026-11-10: no refusals, nothing lost). Its
 * positions came from the scan the user saw, so they are moved through every edit
 * accepted since and disk catches up before the read (never an older copy).
 * `inside`: the selected element inside the link, if any (same file).
 */
async function rewriteLinkFile(
  link: SourceLocation, inside: SourceLocation | null, failure: string, pushUndo: PushStructuralUndo,
  edit: (source: string, at: SourceLocation, inside: SourceLocation | null) => string | Promise<string>,
): Promise<boolean> {
  const file = link.file;
  const origin = captureLocalElementOrigin();
  if (isCrossFileAtOrigin(origin, file)) { notifyLocalCrossFileWrite(file); return false; }
  await acquireStructuralWrite();
  try {
    const [at, insideNow] = await Promise.all([currentSourceLocation(link), inside && currentSourceLocation(inside)]);
    if (!at || (inside && !insideNow)) return false; // the element is gone: nothing to link
    let before: string;
    let after: string;
    try {
      await settleAcceptedWrites();
      before = await readLocalFile(file);
      after = await edit(before, at, insideNow);
    } catch (err) {
      toast.error(t("{0} — {1}", { 0: failure, 1: err instanceof Error ? err.message : 'the file was not changed' }));
      return false;
    }
    if (after === before) return true;
    const r = await commitWholeLocalFile({ file, before, after, pushUndo, failure, origin });
    if (r.ok) markLocalScanStaleAfterWrite();
    return r.ok;
  } finally {
    releaseStructuralWrite();
  }
}

type LinkTarget = Pick<ScannedElement, 'key' | 'tagName' | 'sourceLocation'>;

/** Keep the selected element selected: its key moves with its position. */
function follow(selected: LinkTarget, landed: { line: number; column: number } | null) {
  if (landed) noteLinkKeyMove(selected.key, movedKey(selected.key, landed), selected.tagName);
}

/** The selected element, if it sits in the link's file: only then does the edit move it. */
const insideOf = (selected: LinkTarget | undefined, link: SourceLocation) =>
  selected?.sourceLocation?.file === link.file && !sameStart(selected.sourceLocation, link) ? selected.sourceLocation : null;
const sameStart = (a: SourceLocation, b: SourceLocation) => a.line === b.line && a.column === b.column;

/** Make the selected element a link, at once, to the default target. */
export function addElementLink(element: LinkTarget & { sourceLocation: SourceLocation; parentDisplay?: string | null }, pushUndo: PushStructuralUndo): Promise<boolean> {
  return rewriteLinkFile(element.sourceLocation, null, 'Could not add the link', pushUndo, (source, loc) => {
    const wrapped = wrapLinkSource(source, loc, element.tagName, /flex|grid/.test(element.parentDisplay ?? ''));
    follow(element, wrapped.element);
    return wrapped.source;
  });
}

export function removeElementLink(link: SourceLocation, selected: LinkTarget | undefined, pushUndo: PushStructuralUndo): Promise<boolean> {
  return rewriteLinkFile(link, insideOf(selected, link), 'Could not remove the link', pushUndo, async (source, at, inside) => {
    const removed = await removeLinkSource(source, link.file, at, inside);
    if (selected) follow(selected, removed.element);
    return removed.source;
  });
}

/** `value` empty = drop the attribute. */
export function setElementLinkAttribute(link: SourceLocation, attribute: string, value: string, selected: LinkTarget | undefined, pushUndo: PushStructuralUndo): Promise<boolean> {
  return rewriteLinkFile(link, insideOf(selected, link), 'Could not update the link', pushUndo, async (source, at, inside) => {
    const edited = await setLinkAttribute(source, link.file, at, attribute, value, inside);
    if (selected) follow(selected, edited.element);
    return edited.source;
  });
}
