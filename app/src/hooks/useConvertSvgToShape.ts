/**
 * Convert a selected static inline <svg> (instance child, e.g. AI-generated
 * card art) into a real drawn pen shape: node editing, PenStyleBlock and
 * persistence all reuse the existing pen system. One undo step restores both
 * the deleted svg and removes the new shape.
 *
 * Silent mode backs the DesignBar auto-convert-on-selection; the loud mode
 * backs the manual button shown for unconvertible svgs.
 */
import { useCallback } from 'react';
import { t } from '@/i18n';
import toast from 'react-hot-toast';
import { useEditorDoc } from '@/store/hooks';
import { useUndoContext } from '@/context/UndoContext';
import { useSelectionContext } from '@/context/SelectionContext';
import { selectResolvedStaticMarkup, selectCurrentPageId } from '@/store/selectors';
import { parseKey } from '@/store/types';
import { planSvgConversion, dispatchSvgConversion } from '@/utils/convertElementSvgs';

export function useConvertSvgToShape(): (
  key: string,
  renderedRect?: { width: number; height: number } | null,
  opts?: { silent?: boolean },
) => Promise<boolean> {
  const doc = useEditorDoc();
  const { takeSnapshot, claimSnapshot } = useUndoContext();
  const { select } = useSelectionContext();

  return useCallback(async (key, renderedRect, opts) => {
    const silent = !!opts?.silent;
    const parsed = parseKey(key);
    if (parsed?.type !== 'instance-child' || !parsed.selector.startsWith('svg-')) return false;
    const { instanceId, selector } = parsed;

    const markup = selectResolvedStaticMarkup(doc, instanceId);
    if (!markup) { if (!silent) toast.error(t("Could not read the element source")); return false; }
    const plan = planSvgConversion(markup, selector, renderedRect);
    if (!plan) {
      if (!silent) toast.error(t("This SVG is too complex to convert (multiple shapes or arcs)"));
      return false;
    }
    const pageId = selectCurrentPageId(doc);
    if (!pageId) return false;

    takeSnapshot();
    let drawn;
    try { drawn = await dispatchSvgConversion(doc, instanceId, plan, pageId, claimSnapshot()); }
    catch (error) {
      console.error('SVG conversion was not saved', error);
      if (silent) throw error; // transient storage failure is not an unsupported SVG
      toast.error(t("Conversion was not saved")); return false;
    }
    select(drawn.key, { tagName: 'div', classes: '' });
    if (!silent) toast.success(t("Converted — double-click the shape to edit its nodes"));
    return true;
  }, [doc, takeSnapshot, claimSnapshot, select]);
}
