/**
 * Card gestures,
 * each ONE journaled write, one ⌘Z:
 * - assignCardToCollection — Fields → Set up: the card can now show that
 *   collection's posts (its fields block gains a row). No page changes.
 * - deleteCards — Assets → Delete: its lists switch cards in the same batch.
 * - pickListingCard — Blog Settings → Card: THIS listing renders the card
 *   (assigning it first when needed — utils/cardAssignment.planCardMove).
 */
import toast from 'react-hot-toast';
import { t } from '@/i18n';
import { planCardDelete, planCardMove, type CardAssignment } from '@/utils/cardAssignment';
import { assignCard, readSetup } from '@/utils/cardSetup';
import { projectSourcesSnapshot } from '@/utils/cardTitleLock';
import { presentFiles, rewriteLocalFile, rewriteLocalFiles, type FileWriteSnapshot } from '@/utils/localElementSource';

type Fields = ReadonlyArray<{ name: string; type: string }>;
interface Undo { takeSnapshot: () => void; claimSnapshot: () => FileWriteSnapshot | undefined }

const nameOf = (file: string) => file.replace(/^.*\//, '').replace(/\.astro$/, '');
const errorOf = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

export async function assignCardToCollection({ cardFile, collection, fields, current, takeSnapshot, claimSnapshot }: Undo & {
  cardFile: string; collection: string; fields: Fields; current: string | null;
}): Promise<boolean> {
  takeSnapshot();
  let shown = 0, hidden = 0, changed = false;
  try {
    await rewriteLocalFile(cardFile, (src) => {
      const before = src ?? '';
      const out = assignCard(before, collection, fields, current);
      changed = out !== before;
      const setup = readSetup(out);
      shown = 0; hidden = 0;
      for (const v of (setup instanceof Map ? setup.get(collection)?.values() : undefined) ?? []) if (v && v[0] !== '!') shown++; else hidden++;
      return out;
    }, claimSnapshot());
  } catch (err) {
    toast.error(t("Could not assign {0} to {1} — {2}", { 0: nameOf(cardFile), 1: collection, 2: errorOf(err, 'nothing was changed') }));
    return false;
  }
  if (changed) toast(`${nameOf(cardFile)} can now show ${collection} posts — pick it in a Blog's Card setting${shown + hidden ? ` (${shown} fields shown, ${hidden} hidden)` : ''}`);
  return true;
}

export async function pickListingCard({ pageFile, cardFile, collection, fields, current, takeSnapshot, claimSnapshot, slot }: Undo & {
  pageFile: string; cardFile: string; collection: string; fields: Fields; current: string | null;
  /** The BlogSlot of the page (task-244 L19); absent = every listing of the page. */
  slot?: number;
}): Promise<boolean> {
  const opts = { onlyFile: pageFile, current, slot };
  const touched = Object.keys(planCardMove({ ...projectSourcesSnapshot() }, cardFile, collection, fields, opts).writes);
  if (!touched.length) return true;
  takeSnapshot();
  try {
    await rewriteLocalFiles(touched, (before) => {
      return planCardMove({ ...projectSourcesSnapshot(), ...presentFiles(before) }, cardFile, collection, fields, opts).writes;
    }, claimSnapshot());
    return true;
  } catch (err) {
    toast.error(t("Could not change the card — {0}", { 0: errorOf(err, 'nothing was changed') }));
    return false;
  }
}

/**
 * Assets → Delete on cards (owner 2026-10-10): every Blog list rendering one
 * switches to another card for its collection, else the basic BlogCard; the
 * deletions and the rewiring are ONE journaled batch, one ⌘Z.
 */
export async function deleteCards({ cardFiles, assignments, fieldsOf, takeSnapshot, claimSnapshot }: Undo & {
  cardFiles: string[]; assignments: ReadonlyMap<string, CardAssignment>; fieldsOf: (collection: string) => Fields;
}): Promise<boolean> {
  const plan = (files: Record<string, string>) => planCardDelete(files, cardFiles, assignments, fieldsOf);
  const touched = Object.keys(plan({ ...projectSourcesSnapshot() }));
  takeSnapshot();
  try {
    await rewriteLocalFiles(touched, (before) => {
      return plan({ ...projectSourcesSnapshot(), ...presentFiles(before) });
    }, claimSnapshot());
    return true;
  } catch (err) {
    toast.error(t("Could not delete {0} — {1}", { 0: cardFiles.map(nameOf).join(', '), 1: errorOf(err, 'nothing was changed') }));
    return false;
  }
}

