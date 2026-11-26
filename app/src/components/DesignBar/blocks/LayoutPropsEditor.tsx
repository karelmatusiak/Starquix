import { TrashIcon as SharedTrashIcon } from '@/assets/icons';
import { t } from '@/i18n';
/**
 * LayoutPropsEditor — the shared layout-prop UI, reused by BOTH surfaces:
 *
 *  - mode="page"   (PageLayoutBlock): a value Field per declared prop bound to
 *                  page.layoutProps + 🗑 delete + "+ Add property".
 *  - mode="editor" (layout open in the component editor): schema only — prop name
 *                  + 🗑 delete + "+ Add property"; no value inputs (no page context).
 *
 * Schema add/delete edits the SHARED layout .astro via mutateLayoutProp →
 * /__sq/layout-prop (interface Props + Astro.props destructuring) and broadcasts
 * sq:layouts-changed; useLayoutLibrary refetches so the panel self-updates.
 */

import { useState, useEffect, useCallback, type FC } from 'react';
import toast from 'react-hot-toast';
import { isReservedLayoutProp } from '@/store/layoutReservedProps';
import { mutateLayoutProp } from '@/utils/mutateLayoutProp';
import { Field, IconButton } from '@/components/ui';

export interface LayoutPropDef {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
}

interface LayoutPropsEditorProps {
  layoutName: string;
  /** Non-reserved props, already filtered by the caller. */
  propDefs: LayoutPropDef[];
  mode: 'page' | 'editor';
  /** Page mode only: current prop values (page.layoutProps). */
  values?: Record<string, string>;
  /** Page mode only: commit a changed value (caller owns takeSnapshot + dispatch). */
  onCommitValue?: (name: string, value: string) => void;
}

export const LayoutPropsEditor: FC<LayoutPropsEditorProps> = ({
  layoutName,
  propDefs,
  mode,
  values,
  onCommitValue,
}) => {
  const [draft, setDraft] = useState<Record<string, string>>(values ?? {});
  const [newProp, setNewProp] = useState('');

  // Resync the value buffer when the committed values change (commit, page switch).
  // Guarded to page mode with a defined `values` so the default empty object in
  // editor mode can't create a render loop.
  useEffect(() => { if (mode === 'page' && values) setDraft(values); }, [mode, values]);

  const removeProp = useCallback(async (name: string) => {
    const r = await mutateLayoutProp(layoutName, 'remove', name);
    if (!r.ok) toast.error(r.error);
  }, [layoutName]);

  const addProp = useCallback(async () => {
    const name = newProp.trim();
    if (!name) return;
    if (isReservedLayoutProp(name) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      toast.error(t("Use a non-reserved name (letters/digits/_; not title or description)."));
      return;
    }
    if (propDefs.some((p) => p.name === name)) { toast.error(t("\"{0}\" already exists.", { 0: name })); return; }
    setNewProp('');
    const r = await mutateLayoutProp(layoutName, 'add', name);
    if (!r.ok) toast.error(r.error);
  }, [layoutName, newProp, propDefs]);

  return (
    <div data-testid="layout-props-editor">
      {propDefs.map((p) => (
        <div key={p.name} className="pb-2">
          <div className="flex items-center justify-between pl-1 py-1">
            <label className="block text-xs text-text-muted">{p.name}</label>
            <IconButton size="sm" title={`Delete property ${p.name}`} onClick={() => removeProp(p.name)}>
              <SharedTrashIcon className="w-4 h-4" />
            </IconButton>
          </div>
          {mode === 'page' && (
            <Field
              aria-label={p.name}
              value={draft[p.name] ?? ''}
              placeholder={p.defaultValue ?? ''}
              onChange={(next) => setDraft((v) => ({ ...v, [p.name]: next }))}
              onBlur={() => {
                const next = draft[p.name] ?? '';
                if (next !== (values?.[p.name] ?? '')) onCommitValue?.(p.name, next);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                else if (e.key === 'Escape') {
                  setDraft((v) => ({ ...v, [p.name]: values?.[p.name] ?? '' }));
                  e.currentTarget.blur();
                }
              }}
            />
          )}
        </div>
      ))}

      <div className="pt-1">
        <Field
          aria-label="New property name"
          value={newProp}
          placeholder="+ Add property"
          onChange={setNewProp}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.currentTarget.blur(); void addProp(); }
          }}
        />
        <div className="text-2xs text-text-muted pl-1 pt-1">Edits the layout — shared by all its pages.</div>
      </div>
    </div>
  );
};

export default LayoutPropsEditor;
