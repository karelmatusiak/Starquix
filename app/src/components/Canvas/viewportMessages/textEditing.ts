/**
 * Text-editing messages: edit-mode exit persistence, text-selection state for
 * the LinkBlock, markup (innerHTML) persistence, and keyboard forwarding from
 * the iframe to the parent document.
 */
import * as Y from 'yjs';
import { t } from '@/i18n';
import toast from 'react-hot-toast';
import { parseKey, type EditorCommand } from '@/store/types';
import { acceptEditorCommands } from '@/store/commandGesture';
import { parseSourceKey } from '@/utils/parseSourceKey';
import { getInstanceOverrideAPI } from '@/store/overrides';
import { cleanOrphanedLinkOverrides } from '@/store/commands';
import { LINK_MARKUP_FIELD, clearLinkMarkupOverride } from '@/store/sourceOverrideEntries';
import { isLocalProjectId } from '@/utils/localMode';
import { getLocalScanVersion, getLocalSurfaceGeneration } from '@/utils/localPageSync';
import { getActiveSaveProjectGeneration } from '@/services/pendingProjectMutations';
import { viteTextWriter } from '@/services/ViteTextWriter';
import { SourcePreparationRefused } from '@/services/durableEdits/commandReceipts';
import { clearTextDraft } from './textDrafts';
import type {
  EditModeExitedPayload,
  TextSelectionChangedPayload,
  MarkupChangedPayload,
  KeyboardEventPayload,
} from '@/bridge';
import type { ViewportMessageContext } from './context';

// Text and markup are one preview gesture stream. Acceptance remains durable
// and ordered independently; only optional UI continuations lose permission
// when a newer gesture or a different preview owner has taken over.
const previewTextGestures = new WeakMap<ViewportMessageContext['refs']['iframe'], Map<string, symbol>>();
function beginPreviewTextGesture(ctx: ViewportMessageContext, key: string) {
  const iframeRef = ctx.refs.iframe;
  let gestures = previewTextGestures.get(iframeRef);
  if (!gestures) { gestures = new Map(); previewTextGestures.set(iframeRef, gestures); }
  const token = Symbol(); gestures.set(key, token);
  const { doc, projectId } = ctx.env;
  const iframe = iframeRef.current, window = iframe?.contentWindow;
  const page = ctx.refs.currentPageId.current;
  const projectGeneration = getActiveSaveProjectGeneration();
  const surfaceGeneration = getLocalSurfaceGeneration(), scanVersion = getLocalScanVersion();
  return {
    isCurrent: () => gestures.get(key) === token && ctx.env.doc === doc && ctx.env.projectId === projectId
      && iframeRef.current === iframe && iframeRef.current?.contentWindow === window
      && ctx.refs.currentPageId.current === page && getActiveSaveProjectGeneration() === projectGeneration
      && getLocalSurfaceGeneration() === surfaceGeneration && getLocalScanVersion() === scanVersion,
    // Never roll back to an older token, including after rejection.
    finish: () => { if (gestures.get(key) === token) gestures.delete(key); },
  };
}

function localSourceActions(ctx: ViewportMessageContext, key: string,
  action: Extract<EditorCommand, { type: 'UPDATE_SOURCE_TEXT' | 'UPDATE_SOURCE_MARKUP' }>): EditorCommand[] {
  const element = ctx.refs.scannedElements.current.find(el => el.key === key);
  return [...(!ctx.env.doc.getMap('sourceClasses').has(key) && element?.sourceLocation ? [{
    type: 'REGISTER_SOURCE_ELEMENT' as const, sourceKey: key, classes: element.classes ?? '', sourceLocation: element.sourceLocation,
  }] : []), { ...action, sourceLocation: element?.sourceLocation }];
}

export function handleEditModeExited(ctx: ViewportMessageContext, payload: unknown): void | Promise<void> {
  const p = payload as EditModeExitedPayload;
  ctx.actions.exitEditMode();
  ctx.actions.clearTextSelection();
  const local = isLocalProjectId(ctx.env.projectId ?? '');
  // Nothing to commit → the draft has nothing to protect (Escape commits, D8).
  // A markup commit sent just before reports "unchanged" and owns its clear.
  if (local && p.textContent === p.originalText && !markupCommits.has(p.key)) void clearTextDraft(p.key);

  // Only save if text actually changed.
  // Snapshot is taken at edit-mode ENTRY (sendEnterEditMode), not here —
  // taking it here would capture the already-edited state and break undo.
  if (p.textContent !== p.originalText) {
    const parsed = parseSourceKey(p.key);

    // Files are truth: every local text edit is accepted (or refused) by the one gesture acceptance —
    // an untracked element's text used to take the doc-only path below and vanish on reload.
    if (local) {
      const previewGesture = beginPreviewTextGesture(ctx, p.key);
      return acceptEditorCommands(ctx.env.doc, localSourceActions(ctx, p.key, {
        type: 'UPDATE_SOURCE_TEXT', sourceKey: p.key, textContent: p.textContent, originalText: p.originalText,
      }), ctx.actions.claimSnapshot?.()).then(accepted => {
        void clearTextDraft(p.key); // accepted = durable; the draft is no longer needed
        // The carrier may have moved to a projected key while this preview
        // still uses its old address. Use this accepted action's result.
        const retainedMarkup = accepted.sourceTextResults.some(result => result.sourceKey === p.key && result.retainedMarkup);
        if (!retainedMarkup && previewGesture.isCurrent()) ctx.refs.iframe.current?.contentWindow?.postMessage({
          type: 'UPDATE_TEXT', payload: { key: p.key, textContent: p.textContent },
        }, '*');
      }).catch(err => {
        if (previewGesture.isCurrent()) onTextWriteFailed(ctx, p, err);
        else console.error('[ViewportFrame] Superseded text acceptance failed:', err);
      }).finally(previewGesture.finish);
    }

    if (parsed.type === 'instance') {
      ctx.actions.dispatch({
        type: 'UPDATE_INSTANCE_OVERRIDE',
        instanceId: parsed.instanceId,
        childId: parsed.childId,
        updates: { text: p.textContent }
      });

      // Also persist to source file if element has source location
      // Note: Instance elements from themes/templates may not have sourceLocation
      // because their HTML comes from an API, not local Astro files.
      // For those, text is saved to backend via useProjectSync instead.
      const element = ctx.refs.scannedElements.current.find(el => el.key === p.key);
      if (element?.sourceLocation) {
        viteTextWriter.writeTextUpdate(element.sourceLocation, p.textContent)
          .catch(err => onTextWriteFailed(ctx, p, err));
      }
    } else if (p.key.startsWith('drawn-')) {
      // Drawn element: persist text to sourceText map (NOT elements map,
      // which would trigger selectPageComponents → SET_PAGE_COMPONENTS → wipe drawn DOM)
      ctx.actions.dispatch({
        type: 'UPDATE_SOURCE_TEXT',
        sourceKey: p.key,
        textContent: p.textContent,
        originalText: p.originalText,
      });
    } else {
      // Source-tracked and drawn elements both use UPDATE_SOURCE_TEXT for Yjs persistence.
      // Drawn elements use the sourceText map (not elements map) to avoid triggering RENDER.
      const linkEntryBefore = ctx.env.doc.getMap('sourceLinkAttributes')
        .get(p.key) as Y.Map<unknown> | undefined;
      const hadMarkup = typeof linkEntryBefore?.get(LINK_MARKUP_FIELD) === 'string';
      ctx.actions.dispatch({
        type: 'UPDATE_SOURCE_TEXT',
        sourceKey: p.key,
        textContent: p.textContent,
        originalText: p.originalText,
      });
      // When the text edit DROPPED a stored link-markup override (the change
      // was ambiguous — spliceLinkMarkupText couldn't keep the wrap), the DOM
      // still shows the <a> while the doc now holds plain text: reload would
      // silently unwrap the link days later. Flatten the DOM NOW so what the
      // user sees is what reload will show — no divergence window. (A spliced
      // or kept markup leaves the field in place → no flatten.)
      if (hadMarkup) {
        const entryAfter = ctx.env.doc.getMap('sourceLinkAttributes')
          .get(p.key) as Y.Map<unknown> | undefined;
        if (typeof entryAfter?.get(LINK_MARKUP_FIELD) !== 'string') {
          ctx.refs.iframe.current?.contentWindow?.postMessage(
            { type: 'UPDATE_TEXT', payload: { key: p.key, textContent: p.textContent } }, '*',
          );
        }
      }
    }

    // Persist to source file when the writer is armed (server/local runtimes —
    // in WC the writer is never available and persistence is the Yjs sourceText tier).
    // Drawn elements and theme/template instances have no sourceLocation;
    // for those, text is saved to backend via useProjectSync instead.
    const element = ctx.refs.scannedElements.current.find(el => el.key === p.key);
    if (element?.sourceLocation) {
      viteTextWriter.writeTextUpdate(element.sourceLocation, p.textContent)
        .catch(err => onTextWriteFailed(ctx, p, err));
    }
  }
}

/** A refusal the user can act on: a dynamic expression, or an edit no file can carry. */
// The gate's refusals and the source writer's ("… — edit it in the Source tab": dynamic text, foreign markup).
const isRefusal = (err: unknown) =>
  err instanceof SourcePreparationRefused || /dynamic expression|edit it in the Source tab/.test(String((err as Error)?.message ?? err));

/**
 * A REJECTED text write is a divergence: the canvas shows the edit, the file
 * does not. The refusals the user can act on: a dynamic expression —
 * `<p>{work.data.description}</p>` renders a value (in the component view a
 * stub) that must never be written over the binding (sq-source-plugin
 * updateTextContent, measured 2026-09-10) — and an edit no file can carry
 * (SourcePreparationRefused: Not editable, a loop copy, prop text). Say where
 * to edit it, and put the rendered value back in the doc AND the frame so what
 * the user sees is what the file renders; the draft goes too, or the next scan
 * re-enters edit mode with it. Everything else stays a console error as before.
 */
function onTextWriteFailed(ctx: ViewportMessageContext, p: EditModeExitedPayload, err: unknown): void {
  console.error('[ViewportFrame] Text save failed:', err);
  const message = String((err as Error)?.message ?? err);
  if (!isRefusal(err)) return;
  toast.error(message);
  void clearTextDraft(p.key);
  if (parseSourceKey(p.key).type !== 'instance') {
    ctx.actions.dispatch({ type: 'CLEAR_SOURCE_TEXT', sourceKey: p.key });
  }
  ctx.refs.iframe.current?.contentWindow?.postMessage(
    { type: 'RESTORE_ORIGINAL_TEXT', payload: { key: p.key } }, '*',
  );
}

export function handleTextSelectionChanged(ctx: ViewportMessageContext, payload: unknown): void {
  const p = payload as TextSelectionChangedPayload;

  if (p.hasSelection || p.isInsideLink) {
    // Keep text selection state if there's a selection OR cursor is inside a link
    ctx.actions.setTextSelection({
      hasTextSelection: p.hasSelection,
      selectedText: p.selectedText,
      isInsideLink: p.isInsideLink,
      existingHref: p.existingHref,
      existingTarget: p.existingTarget,
      linkKey: p.linkKey,
    });
  } else {
    // Don't clear text selection if user is interacting with LinkBlock
    // The ref provides synchronous access (React state updates are async)
    if (!ctx.refs.isLinkInteracting.current) {
      ctx.actions.clearTextSelection();
    }
  }
}

/** Keys whose markup commit is in flight: they own their draft's clear. */
const markupCommits = new Set<string>();

export function handleMarkupChanged(ctx: ViewportMessageContext, payload: unknown): void | Promise<void> {
  const p = payload as MarkupChangedPayload;

  // Parse the key to get instanceId and selector
  const parsed = parseKey(p.key);

  if (parsed?.type === 'source' && isLocalProjectId(ctx.env.projectId ?? '')) {
    const previewGesture = beginPreviewTextGesture(ctx, p.key);
    ctx.actions.takeSnapshot();
    markupCommits.add(p.key);
    return acceptEditorCommands(ctx.env.doc, localSourceActions(ctx, p.key, {
      type: 'UPDATE_SOURCE_MARKUP', sourceKey: p.key, markup: p.innerHTML,
    }), ctx.actions.claimSnapshot?.()).then(() => { void clearTextDraft(p.key); }).catch(err => {
      console.error('[ViewportFrame] Markup acceptance failed:', err);
      if (!previewGesture.isCurrent()) return;
      if (isRefusal(err)) { toast.error(String(err.message)); void clearTextDraft(p.key); }
      ctx.refs.iframe.current?.contentWindow?.postMessage({ type: 'RESTORE_ORIGINAL_TEXT', payload: { key: p.key } }, '*');
    }).finally(() => { markupCommits.delete(p.key); previewGesture.finish(); });
  }

  if (parsed?.type === 'instance-child') {
    // Instance child element - store markup override in Yjs
    ctx.actions.takeSnapshot();
    ctx.actions.dispatch({
      type: 'UPDATE_MARKUP_OVERRIDE',
      instanceId: parsed.instanceId,
      selector: parsed.selector,
      markup: p.innerHTML,
    });

    // Get elements map for subsequent operations
    const elements = ctx.env.doc.getMap('elements') as Y.Map<unknown>;

    // Store href in unified overrides if link data is present
    if (p.linkKey && p.href) {
      const linkParsed = parseKey(p.linkKey);
      if (linkParsed?.type === 'instance-child') {
        const api = getInstanceOverrideAPI(elements, linkParsed.instanceId);
        api?.setHref(linkParsed.selector, p.href, p.target);
      }
    }

    // Clean up overrides for removed links
    // Extract link selectors present in new markup (e.g., "a-0", "a-1")
    const linkSelectorsInMarkup = new Set(
      [...p.innerHTML.matchAll(/:a-(\d+)"/g)].map(m => `a-${m[1]}`)
    );

    // Remove orphaned link selector overrides from all override maps
    const instance = elements.get(parsed.instanceId) as Y.Map<unknown> | undefined;
    if (instance) {
      cleanOrphanedLinkOverrides(instance, linkSelectorsInMarkup);
    }
  } else if (parsed?.type === 'source') {
    // Source-tracked element. Doc overlay FIRST (doc-command-first law): the
    // UPDATE_SOURCE_MARKUP entry is the only persistence in WC (the writer
    // below silently no-ops there) and the reload carrier everywhere — the
    // scan re-apply (scanning.ts reapplySourceLinkAttrOverrides) repaints it
    // after every preview reload. The file write is the local/server
    // materialization of the same edit.
    ctx.actions.takeSnapshot();
    ctx.actions.dispatch({
      type: 'UPDATE_SOURCE_MARKUP',
      sourceKey: p.key,
      markup: p.innerHTML,
    });
    const element = ctx.refs.scannedElements.current.find(el => el.key === p.key);
    if (element?.sourceLocation) {
      const write = viteTextWriter.writeTextUpdate(element.sourceLocation, p.innerHTML);
      if (isLocalProjectId(ctx.env.projectId ?? '')) {
        // LOCAL runtime: files are truth (task-132 law) — once the FILE holds
        // the wrap, the doc overlay is a stale shadow that the scan re-apply
        // would paint over any later external edit (and a second wrap would
        // write that ghost back into the user's file). So the overlay is a
        // pre-write carrier only:
        // - resolved true  → write confirmed landed → drop the overlay.
        // - resolved false → writer DECLINED (cross-file edit from a page
        //   view, task-149 owner ruling / writer unavailable): the overlay is
        //   the sanctioned WC-identical carrier — keep it.
        // - rejected       → drop the overlay either way (a kept overlay is
        //   wrong in BOTH sub-cases: ghost-repaint if the write failed, stale
        //   shadow if it landed) and surface real failures. The ack is
        //   routinely LOST on landed writes (the write HMR-reloads the frame
        //   that owes the reply — BaseViteWriter, measured 2026-08-05), so a
        //   bare timeout gets no error toast: the file almost certainly moved.
        // The expectedMarkup guard keeps a NEWER wrap stored mid-flight safe.
        write.then((landed) => {
          if (landed) clearLinkMarkupOverride(ctx.env.doc, p.key, p.innerHTML);
        }).catch((err) => {
          clearLinkMarkupOverride(ctx.env.doc, p.key, p.innerHTML);
          console.error('[ViewportFrame] Markup write failed:', err);
          if (!/timeout/i.test(String((err as Error)?.message ?? ''))) {
            toast.error(t("Could not save the link to the file — it may be lost on reload."));
          }
        });
      } else {
        write.catch(err => console.error('[ViewportFrame] Markup write failed:', err));
      }
    } else {
      console.warn('[ViewportFrame] No source location for key:', p.key);
    }
  } else {
    // Dynamic element without proper key - bridge.js should have found an ancestor
    console.warn('[ViewportFrame] MARKUP_CHANGED not handled for key:', p.key);
  }

  // Don't clear text selection here - the cursor positioning in bridge.js
  // will trigger TEXT_SELECTION_CHANGED with updated state (isInsideLink, linkKey)
  // Clearing here causes the LinkBlock to blink (hide then show)
}

export function handleKeyboardEvent(ctx: ViewportMessageContext, payload: unknown): void {
  // Re-dispatch keyboard event to parent window for useKeyboardShortcuts
  const p = payload as KeyboardEventPayload;

  // Handle Escape to exit context (drill up)
  if (p.key === 'Escape' && ctx.refs.contextKey.current) {
    ctx.refs.exitContext.current();
    return; // Don't propagate if we handled it
  }

  // Handle Enter to drill down or enter text editing mode
  if (p.key === 'Enter' && !p.shiftKey && !p.ctrlKey && !p.metaKey && ctx.refs.selectedKey.current && !ctx.refs.isEditingText.current) {
    const children = ctx.refs.scannedElements.current.filter(el => el.parentKey === ctx.refs.selectedKey.current);

    if (children.length > 0) {
      // Has children - drill down to first child
      const firstChild = children[0];
      ctx.refs.enterContext.current(ctx.refs.selectedKey.current);
      ctx.refs.selectInContext.current(firstChild.key, {
        sourceLocation: firstChild.sourceLocation,
        tagName: firstChild.tagName,
        classes: firstChild.classes,
        rect: firstChild.rect,
      });
    } else {
      ctx.actions.sendEnterEditMode(ctx.refs.selectedKey.current); // db-bound keys are blocked inside the funnel itself
    }
    return;
  }

  const syntheticEvent = new KeyboardEvent('keydown', {
    key: p.key,
    code: p.code,
    shiftKey: p.shiftKey,
    ctrlKey: p.ctrlKey,
    metaKey: p.metaKey,
    altKey: p.altKey,
    repeat: p.repeat,
    bubbles: true,
    cancelable: true,
  });
  // Dispatch on document so capture-phase listeners (useKeyboardShortcuts) receive it
  document.dispatchEvent(syntheticEvent);
}
