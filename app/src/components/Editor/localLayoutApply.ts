/**
 * Local-mode (files-truth) layout apply: picking a layout from the ⌘K picker
 * rewrites the REAL page file — add the layout import to the frontmatter and
 * wrap the template content in <Layout>…</Layout> — instead of dispatching
 * SET_PAGE_LAYOUT into the doc (a local iframe never receives doc-derived
 * RENDER, so the doc row renders nothing and evaporates on reopen).
 *
 * The write is ONE whole-file replace through the EXISTING restore-region
 * write channel (sq:write-restore-region spanning every line), and the undo
 * inverse is the same op carrying the original bytes — a whole-file restore.
 * No partial/mid-line inverse: task-133's live-smoke Critical proved splice
 * inverses silently delete wrong elements.
 *
 * Decision logic is resolveLayoutDrop, verbatim (same UX as WC): noop toast on
 * the already-applied layout, window.confirm on replace or on a page with
 * content, silent apply on an empty layout-less page.
 */
import toast from 'react-hot-toast';
import { t } from '@/i18n';
import type { ScannedComponent } from '@/hooks/useComponentLibrary';
import type { ThemeComponentTemplate } from '@/components/ComponentPickerModal';
import { isThemeComponentTemplate } from '@/components/ComponentPickerModal';
import { isLayoutPath } from '@/utils/astroAssetPaths';
import { resolveLayoutDrop } from '@/utils/layoutDropDecision';
import { viteStructuralWriter } from '@/services/ViteStructuralWriter';
import { afterLocalPageArrives, fetchLocalPageSource, isLocalPageInSync, LOCAL_PAGE_NOT_LOADED_REASON } from '@/utils/localPageSync';
import { importSpecifierFor, type LocalStructuralResult } from '@/utils/localStructural';
import { FRONTMATTER_RE } from '@/utils/blogBinding';
import type { PushStructuralUndo } from '@/store/structuralUndo';
import {
  acquireStructuralWrite,
  releaseStructuralWrite,
} from './localStructuralOps';
import { settleAcceptedWrites } from '@/utils/acceptedSource';
import { captureLocalWriteOrigin } from '@/utils/localWriteScope';

/**
 * Routing predicate for Editor.handleSelectComponent: a layout pick must NEVER
 * fall into insertLocalComponent (layouts scan with an empty template body —
 * the task-149 empty-markup guard refused them with "has no markup").
 * Local user-project layouts carry `src/layouts/…` paths (layoutToScannedComponent);
 * built-ins carry the canonical `layouts/…` astroSource.
 */
export function isLayoutComponent(component: ScannedComponent | ThemeComponentTemplate): boolean {
  if (isThemeComponentTemplate(component)) return false;
  return isLayoutPath(component.path) || component.path.startsWith('src/layouts/');
}


import { detectPageLayout } from '@/utils/detectPageLayout';
import { extractOpeningTag } from '@/vite-plugin/ast-updater';

/**
 * The content a fresh layout apply wraps. A layout-less local page is usually
 * a FULL HTML document — wrapping it whole would nest <html> inside the
 * layout's own document. Keep only the <body> inner content (or, with no
 * <body>, strip just the doctype/<html>/<head> shells). Unlike canvasHtml's
 * stripDocumentBoilerplate this PRESERVES meta/title/link/script bytes that
 * live in the kept region — that helper is for throwaway canvas rendering;
 * this rewrites the user's real file. Head content outside the kept region is
 * dropped by design: the layout now provides the document head (the confirm
 * dialog fires first whenever the page has content).
 */
function wrapTarget(body: string): string {
  const bodyMatch = body.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) return bodyMatch[1].trim();
  return body
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\/?html\b[^>]*>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .trim();
}


/**
 * Pure page-file transform.
 * - No current layout: add the import (creating the frontmatter if absent) and
 *   wrap the wrapTarget content; kept content bytes are preserved verbatim.
 * - Current layout: swap the import statement and the wrapper open/close tag
 *   NAMES (attributes and inner content byte-for-byte — Astro ignores props
 *   the new layout doesn't declare).
 */
export function applyLayoutToPage(source: string, layoutName: string, importPath: string): string {
  const importStmt = `import ${layoutName} from '${importPath}';`;
  const current = detectPageLayout(source);
  const fm = source.match(FRONTMATTER_RE);

  if (current && fm) {
    const importRe = new RegExp(`import\\s+${current.name}\\s+from\\s+['"][^'"]*['"];?`);
    const newFm = fm[0].replace(importRe, importStmt);
    let body = source.slice(fm[0].length);
    body = body.replace(new RegExp(`<${current.name}(?=[\\s/>])`), `<${layoutName}`);
    const close = `</${current.name}>`;
    const closeIdx = body.lastIndexOf(close);
    if (closeIdx !== -1) {
      body = body.slice(0, closeIdx) + `</${layoutName}>` + body.slice(closeIdx + close.length);
    }
    return newFm + body;
  }

  const inner = wrapTarget(fm ? source.slice(fm[0].length) : source);
  // A deleted wrapper leaves the layout's import behind (detectPageLayout only
  // sees WRAPPING layouts) — appending the import again created a duplicate
  // binding that broke the page build (owner's blog.astro, 2026-08-27). Strip
  // any existing import of this name before re-adding it.
  const staleImportRe = layoutImportRe(layoutName);
  const fmInner = (fm ? fm[1].replace(staleImportRe, '') : '').replace(/\s+$/, '');
  const fmBlock = fmInner
    ? `---\n${fmInner}\n${importStmt}\n---\n\n`
    : `---\n${importStmt}\n---\n\n`;
  const wrapped = inner === ''
    ? `<${layoutName}>\n</${layoutName}>\n`
    : `<${layoutName}>\n${inner}\n</${layoutName}>\n`;
  return fmBlock + wrapped;
}

/**
 * Line span of a file as the plugin's restore-region counts it (trailing
 * newline does not open a new line). CRLF-safe: every \r\n contains a \n.
 */
export function fileLineSpan(content: string): number {
  const lines = content.split('\n');
  return content.endsWith('\n') ? Math.max(1, lines.length - 1) : lines.length;
}

export interface LocalLayoutApplyArgs {
  component: ScannedComponent;
  /** Project-relative file backing the current page (resolveLocalPageFile). */
  pageFile: string | null;
  /** The local project's ABSOLUTE folder (page-source read endpoint). */
  localProjectPath: string | null;
  /** UndoContext's pushStructuralUndo — pushed ONLY on a successful write. */
  pushUndo?: PushStructuralUndo;
}

/** Result contract mirrors insertLocalComponent: {ok:true} only on a resolved write. */
export async function applyLocalPageLayout(args: LocalLayoutApplyArgs): Promise<LocalStructuralResult> {
  // Owner 2026-11-10 ("it must just SWITCH"): picked while the page switches →
  // applied to the switched-to page once its scan lands, never refused.
  if (!isLocalPageInSync()) {
    return afterLocalPageArrives((page) => applyLocalPageLayout({ ...args, pageFile: page.pageFile }),
      { ok: false, reason: LOCAL_PAGE_NOT_LOADED_REASON });
  }
  const { component, pageFile, localProjectPath, pushUndo } = args;
  const layoutName = component.name;

  // Only the user's own src/layouts files exist in a local project — the local
  // layout scan only surfaces those, so a built-in path here is a wiring bug.
  if (!component.path.startsWith('src/layouts/')) {
    const detail = 'only layouts from your own project can be applied in local mode';
    toast('Only layouts from your own project can be applied in local mode');
    return { ok: false, reason: detail };
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(layoutName)) {
    toast.error(t("Can't use \"{0}\" as a layout component name", { 0: layoutName }));
    return { ok: false, reason: `can't use "${layoutName}" as a layout component name` };
  }
  if (!pageFile || !localProjectPath) {
    toast('This page has no source file yet — layouts need a real page file');
    return { ok: false, reason: 'this page has no source file yet — layouts need a real page file' };
  }
  // Component view routes currentPageFile at the component's own file.
  if (!pageFile.startsWith('src/pages/')) {
    toast('Layouts apply to pages — open a page first');
    return { ok: false, reason: 'layouts apply to pages — open a page first' };
  }
  // .md/.mdx pages take layouts via `layout:` frontmatter, not a wrapper tag.
  if (!pageFile.endsWith('.astro')) {
    toast('Only .astro pages can take a layout here');
    return { ok: false, reason: 'only .astro pages can take a layout here' };
  }
  // Owner 2026-11-10: waits its write turn (never "Still saving the last
  // change") on the page it was picked for; disk catches up before the read.
  const origin = captureLocalWriteOrigin();
  await acquireStructuralWrite();
  try {
    await settleAcceptedWrites();
    const before = await fetchLocalPageSource(localProjectPath, pageFile);
    if (before === null) {
      toast.error(t("Could not read the page file"));
      return { ok: false, reason: 'could not read the page file' };
    }

    const current = detectPageLayout(before);
    const fm = before.match(FRONTMATTER_RE);
    const templateBody = fm ? before.slice(fm[0].length) : before;
    const decision = resolveLayoutDrop({
      currentLayout: current?.name ?? null,
      layoutName,
      // hasContent from the FILE itself (files are truth): would the wrap
      // relocate anything? Only consulted on a first-time apply.
      hasContent: current ? true : wrapTarget(templateBody) !== '',
    });
    if (decision.kind === 'noop') {
      toast(`Layout "${layoutName}" is already applied`);
      return { ok: false, reason: `layout "${layoutName}" is already applied` };
    }
    // No native confirm (owner rule: never window.confirm in the editor).
    // Replacing a layout or dropping the page's own <head> is one ⌘Z away —
    // the undo record below restores the exact original bytes.
    const after = applyLayoutToPage(before, layoutName, importSpecifierFor(pageFile, component.path));
    const loc = { file: pageFile, line: 1, column: 1 };

    // Whole-file replace over the existing restore-region channel: replace
    // every line of `before` with `after`. HMR reloads the page with the
    // layout applied.
    let res: Awaited<ReturnType<typeof viteStructuralWriter.writeRestoreRegion>>;
    try {
      res = await viteStructuralWriter.writeRestoreRegion(loc, fileLineSpan(before), after, origin);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'the file was not changed';
      toast.error(t("Could not apply the layout — {0}", { 0: detail }));
      return { ok: false, reason: detail };
    }
    if (!res || !res.success) {
      toast.error(t("Could not apply the layout — the file was not changed"));
      return { ok: false, reason: 'the file was not changed' };
    }

    // Undo = whole-file restore of the original bytes; redo = the apply again.
    // Both are the one restore-region op — byte-exact in both directions.
    pushUndo?.({
      origin,
      structuralOp: {
        forward: [{ kind: 'restore-region', loc, lineCount: fileLineSpan(before), segment: after }],
        inverse: [{ kind: 'restore-region', loc, lineCount: fileLineSpan(after), segment: before }],
      },
    });

    toast.success(current ? `Layout replaced with ${layoutName}` : `Applied layout ${layoutName}`);
    return { ok: true, file: pageFile, insertedLine: 1 };
  } finally {
    releaseStructuralWrite();
  }
}

/** A default-import line of `name` (with its line break) — the layout wrapper's import. */
export function layoutImportRe(name: string): RegExp {
  return new RegExp(`^[ \\t]*import\\s+${name}\\s+from\\s+['"][^'"]*['"];?[ \\t]*\\r?\\n?`, 'gm');
}

/** The inverse of applyLayoutToPage: drop the page's `<Name>` wrapper and its import; the body stays. */
export function detachLayoutSource(src: string, name: string): string {
  let out = src.replace(layoutImportRe(name), '');
  const open = out.search(new RegExp(`<${name}[\\s/>]`));
  if (open < 0) throw new Error(`<${name}> not found`);
  const tag = extractOpeningTag(out, open);
  if (!tag) throw new Error(`<${name}> is not closed`);
  if (tag.tagContent.endsWith('/>')) return out.slice(0, open) + out.slice(tag.endOffset).replace(/^\n/, '');
  const close = out.lastIndexOf(`</${name}>`);
  if (close < tag.endOffset) throw new Error(`</${name}> not found`);
  out = out.slice(0, open) + out.slice(tag.endOffset, close).replace(/^\n/, '').replace(/\n[ \t]*$/, '\n') + out.slice(close + name.length + 3).replace(/^\n/, '');
  return out;
}
