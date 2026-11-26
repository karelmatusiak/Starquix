/**
 * Files-truth blog binding writer (task-240). Same gesture order as
 * localLayoutApply: in-sync guard → structural write guard → read the page →
 * pure rewrite (utils/blogBinding.emitBlogBinding) → ONE whole-file
 * restore-region write → whole-file inverse for ⌘Z. Files are truth; nothing
 * else is written anywhere.
 */
import toast from 'react-hot-toast';
import { t } from '@/i18n';
import { viteStructuralWriter } from '@/services/ViteStructuralWriter';
import { fetchLocalPageRoutes, fetchLocalPageSource, isLocalPageInSync, moveLocalPageFile } from '@/utils/localPageSync';
import { acquireStructuralWrite, tryAcquireStructuralWrite, releaseStructuralWrite } from '@/store/structuralWriteGuard';
import { captureLocalElementOrigin, type LocalWriteOrigin } from '@/utils/localWriteScope';
import { importSpecifierFor } from '@/utils/localStructural';
import { readLocalFile, rewriteLocalFile } from '@/utils/localElementSource';
import { settleAcceptedWrites } from '@/utils/acceptedSource';
import { CARD_FILE, cardCopy, cardFileFor, DEFAULT_CARD, ownCardFile } from '@/utils/cardFields';
import { cardTagsOf, detectPostRoute, emitBlogBinding, importStatementRe, parseBlogBindings, rebaseRelativeImports, resolveImportPath, slotSpans, type BlogBinding } from '@/utils/blogBinding';
import { allCardAssignments, cardSourceOf } from '@/utils/cardTitleLock';
import { cardEmitOptions } from '@/utils/cardAssignment';
import type { PushStructuralUndo, StructuralOp } from '@/store/structuralUndo';
import type { ScannedComponent } from '@/hooks/useComponentLibrary';
import { fileLineSpan } from './localLayoutApply';
import { ensurePostRoute } from './localBlogScaffold';
import { materializeLibraryComponent } from './localComponentInsert';
import { LOCAL_PAGE_SWITCHING_REASON } from './localStructuralOps';

export interface BindLocalBlogSlotArgs {
  pageFile: string;
  localProjectPath: string;
  binding: BlogBinding;
  /** UndoContext's pushStructuralUndo — pushed ONLY on a successful write. */
  pushUndo?: PushStructuralUndo;
  /** The library pagination chrome the page will import (numbered / load-more):
   *  materialized into src/components/ when the project lacks it (reuse
   *  otherwise). null/absent = the page must already have it. */
  chromeComponent?: ScannedComponent | null;
  /** An automatic shape upgrade (no user gesture): no busy/switching toasts,
   *  a neutral success message. */
  quiet?: boolean;
  /** Which `<BlogSlot>` of the page (0-based, template order; task-244 L18). Default the first. */
  slot?: number;
}
export type BindResult = { ok: true } | { ok: false; reason: string };

export { CARD_FILE };

/** `src/pages/blog.astro` → `../components/BlogCard.astro` (the shared import-specifier rule). */
export function cardImportFor(pageFile: string, cardFile: string = CARD_FILE): string {
  return importSpecifierFor(pageFile, cardFile);
}

const PAGED_RE = /\/\[\.\.\.page\]\.astro$/;
/** Numbered pagination is Astro's `[...page].astro`: `blog.astro` / `blog/index.astro` → `blog/[...page].astro`. */
export function paginatedPathFor(pageFile: string): string {
  if (PAGED_RE.test(pageFile)) return pageFile;
  const base = pageFile.replace(/\/index\.astro$/, '').replace(/\.astro$/, '');
  return `${base}/[...page].astro`;
}
/** …and back: `blog/[...page].astro` → `blog.astro`; `src/pages/[...page].astro` → `src/pages/index.astro`. */
export function plainPathFor(pageFile: string): string {
  const base = pageFile.replace(PAGED_RE, '');
  return base === 'src/pages' ? 'src/pages/index.astro' : `${base}.astro`;
}

/**
 * The card a Blog bound to `collection` renders (owner 2026-10-09: "we need to
 * assign a card to a post" — the binding carries its card): the card the page
 * already renders for its posts when it belongs to that collection, else the
 * card in that collection's Assets folder (typed first; utils/cardAssignment),
 * else null (the caller creates the collection's own `WorksCard`, D1).
 */
export function assignedCardFor(collection: string, pageFile: string, pageSource: string, slot?: number): string | null {
  const all = allCardAssignments();
  const assigned = [...all].filter(([, a]) => a.card && a.collections.includes(collection));
  // Already bound to this collection: the card it renders IS its card, whatever
  // its type line says (an imported site's cards may be typed for another
  // collection — live 2026-10-10 the quiet re-emit swapped them for a new WorksCard).
  const bound = parseBlogBindings(pageSource)[slot ?? 0]?.collection === collection;
  return renderedFiles(pageFile, pageSource, slot).find((f) => assigned.some(([a]) => a === f) || (bound && all.get(f)?.card))
    ?? (assigned.find(([, a]) => a.typed === collection) ?? assigned[0])?.[0] ?? null;
}

/** The card THAT slot renders (L21; the whole page without a slot), else null — what a quiet re-emit keeps. */
export function renderedCardOf(pageFile: string, pageSource: string, slot?: number): string | null {
  return renderedFiles(pageFile, pageSource, slot).find((f) => allCardAssignments().get(f)?.card) ?? null;
}

/** Files of the `<X … y={post} />` card tags in the slot's fragment (relative imports only). */
function renderedFiles(pageFile: string, pageSource: string, slot?: number): string[] {
  const span = slot === undefined ? undefined : slotSpans(pageSource)[slot];
  const scope = span ? pageSource.slice(span.start, span.end) : pageSource;
  return cardTagsOf(scope).flatMap((name) => {
    const spec = pageSource.match(importStatementRe(name))?.[1];
    return spec?.startsWith('.') ? [resolveImportPath(pageFile, spec)] : [];
  });
}

export async function bindLocalBlogSlot({ pageFile, localProjectPath, binding, pushUndo, chromeComponent, quiet, slot = 0 }: BindLocalBlogSlotArgs): Promise<BindResult> {
  // Owner 2026-11-10 (no refusals, nothing lost): it waits its write turn and
  // stays on the page it was made on; disk catches up first, so a write just
  // ahead of it in the queue is never put back.
  const origin = captureLocalElementOrigin();
  await acquireStructuralWrite();
  try {
    await settleAcceptedWrites();
    const before = await fetchLocalPageSource(localProjectPath, pageFile);
    if (before === null) {
      if (!quiet) toast.error(t("Could not read the page file"));
      return { ok: false, reason: 'could not read the page file' };
    }
    // Numbered pagination lives in `[...page].astro`; everything else in the
    // plain listing file. The page moves when the kind crosses that line.
    const target = binding.pagination.kind === 'numbered' ? paginatedPathFor(pageFile) : PAGED_RE.test(pageFile) ? plainPathFor(pageFile) : pageFile;
    const rebased = target === pageFile ? before : rebaseRelativeImports(before, pageFile, target);
    // The card link follows the project's CURRENT detail route on every write
    // (`href` is a parse output, never a caller's input); the page's own value
    // stands in when the routes cannot be listed.
    // A collection with no post route gets one first — otherwise its posts
    // are neither child pages nor linkable (owner report 2026-09-28).
    const routeCreated = binding.collection
      ? await ensurePostRoute({ collection: binding.collection, projectPath: localProjectPath, pageFile, pageSource: before }).catch(() => false)
      : false;
    const routes = binding.collection ? await fetchLocalPageRoutes(localProjectPath).catch(() => null) : null;
    const href = routeCreated ? `/${binding.collection}/` : binding.collection && routes ? detectPostRoute(binding.collection, routes) : binding.href;
    // The collection's card (assignedCardFor), else D1: its own `WorksCard`.
    const assignedCard = binding.collection ? assignedCardFor(binding.collection, pageFile, before, slot) : null;
    const cardFile = assignedCard ?? (binding.collection
      ? ownCardFile(binding.collection, { [cardFileFor(binding.collection)]: await readLocalFile(cardFileFor(binding.collection)).catch(() => null) })
      : CARD_FILE);
    const cardSrc = assignedCard ? await cardSource(assignedCard) : null;
    const after = emitBlogBinding(rebased, { ...binding, href }, cardEmitOptions(target, cardFile, cardSrc), slot);
    if (after === null) { toast('This blog is wired by hand — edit it in Source'); return { ok: false, reason: 'custom' }; }
    if (after === before && target === pageFile) return { ok: true };

    // The chrome the page now imports must exist in the project (reused when it does).
    if (chromeComponent && binding.pagination.kind !== 'none') {
      const m = await materializeLibraryComponent(chromeComponent, localProjectPath);
      if (!m.ok) { toast.error(t("Could not add {0} to your project — {1}", { 0: chromeComponent.name, 1: m.reason })); return { ok: false, reason: m.reason }; }
    }
    // The card is a NEW file the page now imports — created first (not part of
    // the page's undo: an unused card is harmless, a page importing a missing
    // card is not). Copied from the project's BlogCard, else the library card.
    if (binding.collection && !assignedCard) {
      try {
        const blogCard = await readLocalFile(CARD_FILE).catch(() => null);
        await rewriteLocalFile(cardFile, (existing) => existing ?? cardCopy(blogCard ?? DEFAULT_CARD, cardFile));
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'the card was not written';
        toast.error(t("Could not add the {0} card — {1}", { 0: binding.collection, 1: detail }));
        return { ok: false, reason: detail };
      }
    }
    // Write FIRST (through the bridge, while the iframe is stable), THEN move
    // over HTTP: a route move makes astro dev full-reload the iframe, and a
    // bridge write issued in that window is never delivered (live-measured
    // 2026-09-12: "the file was not changed"). The bytes are already re-based
    // for the target depth, so the file is momentarily wrong at the old path —
    // the move lands right behind it and the reload renders the new route.
    const moved = target !== pageFile ? { folder: localProjectPath, from: pageFile, to: target } : undefined;
    const res = await commitWholeLocalFile({ file: pageFile, before, after, pushUndo, failure: 'Could not update the blog', moved, origin });
    if (res.ok) toast.success(quiet ? 'Blog page updated' : binding.collection ? `Blog bound to ${binding.collection}` : 'Blog unbound');
    if (!res.ok || !moved) return res;
    try {
      await moveLocalPageFile(localProjectPath, pageFile, target);
    } catch (err) {
      // Undo the write so the page is never left paginated at a non-paginated path.
      try { await viteStructuralWriter.writeRestoreRegion({ file: pageFile, line: 1, column: 1 }, fileLineSpan(after), before); } catch { /* reported below */ }
      const detail = err instanceof Error ? err.message : 'the page could not be moved';
      toast.error(t("Could not move the page — {0}", { 0: detail }));
      return { ok: false, reason: detail };
    }
    return res;
  } finally {
    releaseStructuralWrite();
  }
}

/**
 * The quiet shape upgrade over EVERY slot of a page (L20): each bound,
 * non-custom slot re-emits with the card it renders (a no-op when already
 * current); a custom slot is skipped, never reverting the others.
 */
export async function reemitLocalBlogSlots({ pageFile, localProjectPath, pushUndo }: Pick<BindLocalBlogSlotArgs, 'pageFile' | 'localProjectPath' | 'pushUndo'>): Promise<BindResult> {
  if (!isLocalPageInSync()) return { ok: false, reason: LOCAL_PAGE_SWITCHING_REASON };
  if (!tryAcquireStructuralWrite()) return { ok: false, reason: 'another structural write is in flight' };
  try {
    const before = await fetchLocalPageSource(localProjectPath, pageFile);
    if (before === null) return { ok: false, reason: 'could not read the page file' };
    const routes = await fetchLocalPageRoutes(localProjectPath).catch(() => null);
    // ONE pure fold over the slots (emit never moves another slot's index) →
    // one write, one reload, one ⌘Z. Same card + pagination: nothing to create.
    let after = before;
    for (const b of parseBlogBindings(before)) {
      const cardFile = b.collection && !b.custom ? renderedCardOf(pageFile, after, b.slot) : null;
      if (!cardFile) continue; // unbound / custom / no card yet (a real bind creates one)
      const href = routes ? detectPostRoute(b.collection!, routes) : b.href;
      after = emitBlogBinding(after, { ...b, href }, cardEmitOptions(pageFile, cardFile, await cardSource(cardFile)), b.slot) ?? after;
    }
    if (after === before) return { ok: true };
    return await commitWholeLocalFile({ file: pageFile, before, after, pushUndo, failure: 'Could not update the blog' });
  } finally {
    releaseStructuralWrite();
  }
}

const cardSource = async (file: string) => cardSourceOf(file) ?? readLocalFile(file).catch(() => null);

/**
 * ONE whole-file restore-region write of `file` (before → after) plus a
 * whole-file inverse for ⌘Z — the files-truth "rewrite this file" primitive
 * shared by the blog binding (page) and the field binding (component) writers.
 * Caller holds the structural write guard.
 */
export async function commitWholeLocalFile({ file, before, after, pushUndo, failure, moved, origin }: {
  file: string; before: string; after: string; pushUndo?: PushStructuralUndo; failure: string;
  /** The page the gesture was made on: the write lands there even if the user
   *  moved on while it waited, and its ⌘Z replays there from any page. */
  origin?: LocalWriteOrigin;
  /** The page-file move that FOLLOWS this write (pagination): the undo record
   *  wraps it — redo = write then move, undo = move back then restore. */
  moved?: { folder: string; from: string; to: string };
}): Promise<BindResult> {
  const loc = { file, line: 1, column: 1 };
  let res: Awaited<ReturnType<typeof viteStructuralWriter.writeRestoreRegion>>;
  try {
    res = await viteStructuralWriter.writeRestoreRegion(loc, fileLineSpan(before), after, origin);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'the file was not changed';
    toast.error(t("{0} — {1}", { 0: failure, 1: detail }));
    return { ok: false, reason: detail };
  }
  if (!res || !res.success) { toast.error(t("{0} — the file was not changed", { 0: failure })); return { ok: false, reason: 'the file was not changed' }; }
  // Redo = the rewrite again, then the move; undo = restore the original
  // bytes AT THE MOVED PATH (where the file is by then), then move back.
  // Both directions write-then-move: a bridge write issued after a route
  // move is never delivered (the iframe is reloading) — live-measured on ⌘Z.
  const forward: StructuralOp[] = [{ kind: 'restore-region', loc, lineCount: fileLineSpan(before), segment: after }];
  const inverseLoc = moved ? { file: moved.to, line: 1, column: 1 } : loc;
  const inverse: StructuralOp[] = [{ kind: 'restore-region', loc: inverseLoc, lineCount: fileLineSpan(after), segment: before }];
  if (moved) {
    forward.push({ kind: 'page-move', folder: moved.folder, from: moved.from, to: moved.to });
    inverse.push({ kind: 'page-move', folder: moved.folder, from: moved.to, to: moved.from });
  }
  pushUndo?.({ structuralOp: { forward, inverse }, origin });
  return { ok: true };
}
