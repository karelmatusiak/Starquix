/**
 * BlogCard field binding (task-240 Phase 2). In the card MASTER (component
 * view) a text/img element gets a picker of the collections' fields; picking
 * one rewrites the component file (`{post.data.x}` / `src={post.data.x…}`).
 * A placeholder BOX (the library card's `aspect-video` div) takes an IMAGE
 * field: its content becomes a bound <img>. On a page INSTANCE the block is
 * read-only: what the element is bound to and a jump to the master — never a
 * write from the instance.
 *
 * A card serving several collections (fields block, design
 * 2026-10-09-cards-any-collection §3): the element is a SLOT; the picker sets
 * which field of the VIEWED collection it shows (utils/cardSetup.setSlotField)
 * — in the card view or on a page, since it edits the card's setup, not the
 * instance. Other collections' mappings are untouched.
 */
import { useMemo } from 'react';
import { t } from '@/i18n';
import { Button, Field, Row, Tooltip } from '@/components/ui';
import { LockIcon } from '@/assets/icons';
import { useFieldBinding } from '@/hooks/useFieldBinding';
import { useLocalProjectPath } from '@/hooks/useLocalProjectPath';
import { useUndoContext } from '@/context/UndoContext';
import { bindLocalField } from '@/components/Editor/localFieldBind';
import { bindingKindFor, DATE_FORMATS } from '@/utils/fieldBinding';
import { hasSetupBlock, isFieldIdentifier } from '@/utils/cardFields';
import { readSetup, setSlotField } from '@/utils/cardSetup';
import { cardSourceOf, useCardTitleLockVersion } from '@/utils/cardTitleLock';
import { useCardCollectionView } from '@/utils/cardCollectionView';
import { rewriteLocalFile } from '@/utils/localElementSource';
import toast from 'react-hot-toast';
import type { Schema } from '@/utils/blogBinding';
import type { SourceLocation } from '@/store/types';
import { goToSource } from '../HeaderActionButtons';
import { ExpandableRow } from '../sections';
import { LabelRow } from './BlogBindingBlock';

interface Props {
  sourceLocation: SourceLocation;
  tagName: string;
  mode: 'master' | 'instance';
  collections: ReadonlyArray<{ name?: string; inferredFields?: Schema }>;
  /** On a page: the collection the selected listing shows (the viewed one by default). */
  listingCollection?: string;
}

export function FieldBindingBlock({ sourceLocation, tagName, mode, collections, listingCollection }: Props) {
  const localProjectPath = useLocalProjectPath();
  const { field, bindable, slot, dateFormat } = useFieldBinding(sourceLocation, tagName);
  const { pushStructuralUndo, takeSnapshot, claimSnapshot } = useUndoContext();
  useCardTitleLockVersion(); // the card source cache
  const cardSrc = cardSourceOf(sourceLocation.file);
  const block = cardSrc !== null && hasSetupBlock(cardSrc);
  const view = useCardCollectionView(sourceLocation.file, collections.flatMap((c) => (c.name ? [c.name] : [])), listingCollection);
  const kind = bindingKindFor(tagName);
  // Union of every collection's fields (first type wins) — the card may serve
  // more than one slot (design U12).
  const fields = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of collections) for (const f of c.inferredFields ?? []) if (!seen.has(f.name)) seen.set(f.name, f.type);
    return [...seen].map(([name, type]) => ({ name, type }));
  }, [collections]);

  const typeOf = (name: string | null) => fields.find((f) => f.name === name)?.type;

  if (!kind || !localProjectPath) return null;

  if (block) {
    const setup = readSetup(cardSrc!);
    if (!slot || !view || !(setup instanceof Map) || !setup.has(view)) return null;
    const mapped = setup.get(view)!.get(slot) ?? null;
    const shows = mapped && mapped[0] !== '!' ? mapped : null;
    if (slot === 'title') {
      return (
        <Row title={`Bound to ${shows ?? 'title'}`} caption={`in ${view}`} size="sm" hover={false} className="mt-2"
          right={[{ type: 'custom', unboxed: true, node: (
            <Tooltip content="Blog title cannot be deleted"><LockIcon aria-label="Blog title cannot be deleted" className="w-4 h-4 text-text-secondary" /></Tooltip>
          ) }]} />
      );
    }
    const own = collections.find((c) => c.name === view)?.inferredFields ?? [];
    const image = kind !== 'text';
    const offered = own.filter((f) => isFieldIdentifier(f.name) && (f.type === 'image') === image);
    const pick = async (v: string) => {
      takeSnapshot();
      try {
        await rewriteLocalFile(sourceLocation.file, (s) => setSlotField(s ?? '', view, slot, v || null), claimSnapshot());
      } catch (err) {
        toast.error(t("Could not change the field — {0}", { 0: err instanceof Error ? err.message : 'the card was not changed' }));
      }
    };
    return (
      <ExpandableRow title={`Field in ${view}`} className="mt-2" defaultExpanded>
        <div className="pb-2 pr-8">
          <LabelRow label="Field">
            <Field as="select" aria-label="Field" value={shows ?? ''} onChange={(v) => { void pick(v); }}
              options={[{ value: '', label: 'None' }, ...offered.map((f) => ({ value: f.name, label: f.name }))]} />
          </LabelRow>
        </div>
      </ExpandableRow>
    );
  }

  if (mode === 'instance') {
    if (!field) return null;
    return (
      <Row
        title={`Bound to ${field}`} size="sm" hover={false} className="mt-2"
        right={[{ type: 'custom', unboxed: true, node: (
          <Button variant="ghost" size="sm" label="Edit in card" onClick={() => goToSource(sourceLocation.file, null)} />
        ) }]}
      />
    );
  }

  if (!bindable) return null;
  // The post title can't leave a card (owner 2026-10-09) — not even by re-binding its element.
  if (field === 'title') {
    return (
      <Row title="Bound to title" size="sm" hover={false} className="mt-2"
        right={[{ type: 'custom', unboxed: true, node: (
          <Tooltip content="Blog title cannot be deleted"><LockIcon aria-label="Blog title cannot be deleted" className="w-4 h-4 text-text-secondary" /></Tooltip>
        ) }]} />
    );
  }
  // Type-strict (owner 2026-10-09): text elements take text-like fields, image
  // elements and image boxes take image fields. Hyphenated keys can't be written
  // as post.data.x — not offered.
  const assignable = fields.filter((f) => isFieldIdentifier(f.name));
  const offered = kind === 'text' ? assignable.filter((f) => f.type !== 'image') : assignable.filter((f) => f.type === 'image');
  if (kind !== 'text' && offered.length === 0) return null;
  const options = [
    ...(kind === 'text' ? [{ value: '', label: 'Static text' }] : []),
    ...(kind === 'box' && !field ? [{ value: '', label: 'None' }] : []),
    ...offered.map((f) => ({ value: f.name, label: f.name })),
  ];
  return (
    <ExpandableRow title={kind === 'box' ? 'Image' : 'Field'} className="mt-2" defaultExpanded>
      <div className="pb-2 pr-8">
        <LabelRow label={kind === 'box' ? 'Image' : 'Field'}>
          <Field
            as="select" aria-label="Field" value={field ?? ''} options={options}
            onChange={(v) => { if (kind === 'box' && !v) return; void bindLocalField({
              loc: sourceLocation, tagName, field: v || null,
              fieldType: typeOf(v) ?? 'text',
              pushUndo: pushStructuralUndo,
            }); }}
          />
        </LabelRow>
        {dateFormat !== null && typeOf(field) === 'date' && (
          <LabelRow label="Format">
            <Field
              as="select" aria-label="Date format" value={dateFormat}
              options={[{ value: '', label: 'As stored' }, ...DATE_FORMATS]}
              onChange={(v) => { void bindLocalField({ loc: sourceLocation, tagName, field: field!, fieldType: 'date', dateFormat: v, pushUndo: pushStructuralUndo }); }}
            />
          </LabelRow>
        )}
      </div>
    </ExpandableRow>
  );
}
