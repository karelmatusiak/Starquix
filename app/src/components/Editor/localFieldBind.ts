/**
 * BlogCard master field write (task-240 Phase 2): read the component file →
 * pure rewrite (utils/fieldBinding.applyFieldBinding) → ONE whole-file
 * restore-region write with a whole-file undo (commitWholeLocalFile — the same
 * primitive the page binding uses). Same guards as every structural write.
 */
import toast from 'react-hot-toast';
import { t } from '@/i18n';
import { acquireStructuralWrite, releaseStructuralWrite } from '@/store/structuralWriteGuard';
import { readLocalFile, writeLocalFile } from '@/utils/localElementSource';
import { currentSourceLocation, settleAcceptedWrites } from '@/utils/acceptedSource';
import { captureLocalElementOrigin } from '@/utils/localWriteScope';
import { applyFieldBinding, readFieldBinding } from '@/utils/fieldBinding';
import type { PushStructuralUndo } from '@/store/structuralUndo';
import type { SourceLocation } from '@/store/types';
import { commitWholeLocalFile, CARD_FILE, type BindResult } from './localBlogBind';

/** The library card's untouched placeholder box — our bytes, never the user's markup. */
const PRISTINE_BOX_RE = /^[ \t]*<div class="aspect-video[^"]*">\s*<span[^>]*>\{post\.data\.thumbnail\}<\/span>\s*<\/div>/m;
/** The card's image box (the library `aspect-video` div; it never nests another div). */
const BOX_RE = /^[ \t]*<div class="aspect-video[^"]*">[\s\S]*?<\/div>/m;

export interface BindLocalFieldArgs {
  loc: SourceLocation;
  tagName: string;
  /** null = back to static text (text elements only). */
  field: string | null;
  fieldType: string;
  /** A date field: its format (utils/fieldBinding DATE_FORMATS), '' = as stored. */
  dateFormat?: string;
  pushUndo?: PushStructuralUndo;
}

export async function bindLocalField({ loc, tagName, field, fieldType, dateFormat, pushUndo }: BindLocalFieldArgs): Promise<BindResult> {
  // In its write turn, on the page it was made on: the element is followed through
  // any edit accepted meanwhile and disk catches up before the read.
  const origin = captureLocalElementOrigin();
  await acquireStructuralWrite();
  try {
    const at = await currentSourceLocation(loc);
    if (!at) return { ok: false, reason: 'the element is gone — nothing was bound' };
    let before: string;
    await settleAcceptedWrites();
    try { before = await readLocalFile(at.file); }
    catch { toast.error(t("Could not read the component file")); return { ok: false, reason: 'could not read the component file' }; }
    let after: string;
    try { after = await applyFieldBinding(before, at, tagName, field, fieldType, dateFormat); }
    catch (err) {
      const detail = err instanceof Error ? err.message : 'could not bind the field';
      toast.error(t("Could not bind the field — {0}", { 0: detail }));
      return { ok: false, reason: detail };
    }
    if (after === before) return { ok: true };
    return commitWholeLocalFile({ file: at.file, before, after, pushUndo, failure: 'Could not bind the field', origin });
  } finally {
    releaseStructuralWrite();
  }
}

/** 1-based line/column of the `<div` that starts the matched box. */
function boxLocation(before: string, m: RegExpMatchArray): { line: number; column: number } {
  const at = (m.index ?? 0) + m[0].indexOf('<div');
  return { line: before.slice(0, at).split('\n').length, column: at - before.lastIndexOf('\n', at - 1) };
}

/**
 * Bind the card's image box (the one `re` matches) to `field` with the plain
 * journaled whole-file write (writeLocalFile) — the structural writer refuses
 * any file but the page being edited (log-proven 2026-09-12: "refused
 * SQ_WRITE_RESTORE_REGION: src/components/BlogCard.astro is not the page being
 * edited"); like the scaffold's files, not undone by ⌘Z. No box, or already
 * bound to `field` → nothing written; other markup in the box → refused.
 */
async function rebindCardBox(re: RegExp, field: string): Promise<BindResult> {
  let before: string;
  try { before = await readLocalFile(CARD_FILE); }
  catch { return { ok: false, reason: 'could not read the component file' }; }
  const m = before.match(re);
  if (!m || readFieldBinding(m[0].trim(), 'div') === field) return { ok: true };
  try {
    const after = await applyFieldBinding(before, { file: CARD_FILE, ...boxLocation(before, m) }, 'div', field, 'image');
    if (after !== before) await writeLocalFile(CARD_FILE, after);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'could not write the component file' };
  }
}

/**
 * Owner report 2026-09-12 ("these cards have uploaded photos but they do not
 * display"): a card materialized by an older build still holds the library
 * placeholder box, so a post's image never reaches it. The PRISTINE box (ours,
 * untouched) upgrades itself to the bound <img> for the collection's image
 * field — `thumbnail` when the schema has it as an image (the placeholder
 * already names it), else `image`, else the first image field. A box the user
 * edited or already bound, a text `thumbnail` field, or no image field →
 * nothing written. Automatic: no gesture, no toasts.
 */
export async function upgradeLocalCardImage({ fields }: {
  fields: ReadonlyArray<{ name: string; type: string }>;
}): Promise<BindResult> {
  const images = fields.filter((f) => f.type === 'image');
  const field = images.find((f) => f.name === 'thumbnail') ?? images.find((f) => f.name === 'image') ?? images[0];
  if (!field || fields.some((f) => f.name === 'thumbnail' && f.type !== 'image')) return { ok: true };
  return rebindCardBox(PRISTINE_BOX_RE, field.name);
}

/** The image field the project's card box is bound to; null = no card, unbound, or not ours to read. */
export async function readLocalCardImageField(): Promise<string | null> {
  try {
    const m = (await readLocalFile(CARD_FILE)).match(BOX_RE);
    return m ? readFieldBinding(m[0].trim(), 'div') : null;
  } catch { return null; }
}

/**
 * Owner rule 2026-09-12 ("the photo uploaded into attributes is the one on the
 * card cover"): the attribute the user uploads into IS the card's image field —
 * a placeholder, a bound <img> of any field or a static <img> in the box all
 * become the bound <img> for `field`.
 */
export const bindLocalCardImageField = (field: string): Promise<BindResult> => rebindCardBox(BOX_RE, field);
