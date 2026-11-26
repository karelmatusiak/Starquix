/**
 * The open collection card's fields (owner 2026-10-09), read from the card
 * FILE. A field the card renders has an EYE: off = its element is left out of
 * the HTML, on = back with its styling — or, for a field the card has no
 * element for, a new element of its own. The title has a lock instead of an
 * eye (it can't leave a card). Assigning a field = select an element of the
 * card → Field (FieldBindingBlock). Re-read on every files-truth sync.
 *
 * Cards × collections (design 2026-10-09-cards-any-collection §3): a card
 * serving ONE collection keeps its plain form (eyes = `const show`,
 * utils/cardFields). A card serving several has a fields block
 * (utils/cardSetup): a switcher picks the collection, eyes and pickers edit
 * that collection's setup only. Unassigned → "Assign to a collection";
 * rendered with a collection it is not set up for → "Not set up for X — Set up".
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { t } from '@/i18n';
import toast from 'react-hot-toast';
import { Button, Field, IconButton, Row, Tooltip } from '@/components/ui';
import { DeleteIcon, HiddenIcon, LockIcon, VisibleIcon } from '@/assets/icons';
import { useUndoContext } from '@/context/UndoContext';
import { readLocalFile, rewriteLocalFile } from '@/utils/localElementSource';
import { hasSetupBlock, scanCardFields, setCardFieldVisible } from '@/utils/cardFields';
import { assignCard, fieldStatesIn, readSetup, setFieldVisibleIn } from '@/utils/cardSetup';
import { useCardCollectionView } from '@/utils/cardCollectionView';
import { assignCardToCollection } from '@/components/Editor/localCardMove';
import { getFilesTruthSyncStatus, subscribeFilesTruthSyncStatus } from '@/services/filesTruthSync';
import { useScannedElements, useSelectionContext } from '@/context/SelectionContext';
import { cardFieldAt, useCardTitleLockVersion } from '@/utils/cardTitleLock';
import { selectOptionsFor } from '@/utils/selectOptions';
import type { Schema } from '@/utils/blogBinding';
import { ExpandableRow } from '../sections';

type Collection = { name: string; inferredFields?: Schema };

export function CardFieldsBlock({ file, collections, conflict = [], allCollections = collections, listingCollection }: {
  file: string;
  /** The collections the card is assigned to (design L1–L3). */
  collections: ReadonlyArray<Collection>;
  /** Collections the card is rendered with but not set up for (L10). */
  conflict?: readonly string[];
  /** Every collection of the project (the Assign picker). */
  allCollections?: ReadonlyArray<Collection>;
  /** On a page: the collection the selected listing shows — the switcher opens on it. */
  listingCollection?: string;
}) {
  const sync = useSyncExternalStore(subscribeFilesTruthSyncStatus, getFilesTruthSyncStatus);
  const { takeSnapshot, claimSnapshot } = useUndoContext();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    readLocalFile(file).then((s) => { if (!cancelled) setSrc(s); }, () => {});
    return () => { cancelled = true; };
  }, [file, sync]);
  const names = collections.map((c) => c.name);
  // Fields ↔ canvas (owner 2026-10-11): a row selects the element showing its
  // field (in the selected card copy first); the selected element lights its row.
  useCardTitleLockVersion();
  const { scannedElements, scannedByKey } = useScannedElements();
  const { selectedKey, select } = useSelectionContext();
  const copyOf = (key: string | null) => key?.split('~')[1] ?? null;
  const fieldOfKey = (key: string | null) => {
    const loc = key ? scannedByKey.get(key)?.sourceLocation : undefined;
    return loc && loc.file === file ? cardFieldAt(loc) : null;
  };
  const selectedField = fieldOfKey(selectedKey);
  const selectField = (field: string) => {
    const matches = scannedElements.filter((el) => el.sourceLocation?.file === file && cardFieldAt(el.sourceLocation) === field);
    const el = matches.find((m) => copyOf(m.key) === copyOf(selectedKey)) ?? matches[0];
    if (el) select(el.key, selectOptionsFor(el));
    return el ?? null;
  };
  // Remove = delete the element through the ONE delete path (useKeyboardShortcuts:
  // undo, guards, journal). ponytail: synthetic Delete after the selection
  // commits; a shared deleteSelection() export replaces this if a second caller appears.
  const removeField = (field: string) => {
    if (!selectField(field)) return;
    setTimeout(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })), 50);
  };
  const view = useCardCollectionView(file, names, listingCollection);

  const edit = async (what: string, compute: (s: string) => string) => {
    takeSnapshot();
    try {
      let next = '';
      await rewriteLocalFile(file, (s) => (next = compute(s ?? '')), claimSnapshot());
      setSrc(next);
    } catch (err) {
      toast.error(t("Could not {0} — {1}", { 0: what, 1: err instanceof Error ? err.message : 'the card was not changed' }));
    }
  };
  const assign = (collection: string) => {
    const fields = allCollections.find((c) => c.name === collection)?.inferredFields ?? [];
    void assignCardToCollection({ cardFile: file, collection, fields, current: names[0] ?? null, takeSnapshot, claimSnapshot });
  };
  if (src === null) return null;

  // Owner 2026-10-11: blog → card → click the card → ITS listing's collection
  // fields. No switcher there; a card not set up for that collection still
  // lists every field, and turning one on sets the card up in the same edit.
  const listing = listingCollection ? allCollections.find((c) => c.name === listingCollection) : undefined;
  const setUp = !listing || names.includes(listing.name);
  const block = hasSetupBlock(src);
  const setup = block ? readSetup(src) : null;
  const viewName = listing?.name ?? view;
  const viewed = listing ?? (block && view ? collections.find((c) => c.name === view) : undefined);
  // Block form: the viewed collection's fields; plain form: every assigned collection's.
  const fields = new Map<string, string>();
  for (const c of viewed ? [viewed] : collections) for (const f of c.inferredFields ?? []) if (!fields.has(f.name)) fields.set(f.name, f.type);
  // Not set up yet: preview what the card's own elements would show once set up (pure).
  const shape = listing && !setUp ? assignCard(src, listing.name, listing.inferredFields ?? [], names[0] ?? null) : src;
  const states: Map<string, string> = hasSetupBlock(shape) && viewName ? fieldStatesIn(shape, viewName) : scanCardFields(shape);
  const row = setup instanceof Map && viewName ? setup.get(viewName) : undefined;
  const titleField = row ? row.get('title') : 'title';
  // L11/L12: a slot mapped to a field the collection no longer has.
  const missing = row ? [...row].filter(([, x]) => x && !fields.has(x.replace(/^!/, ''))) : [];
  const toggle = (name: string, visible: boolean, type: string) => void edit(`${visible ? 'show' : 'hide'} ${name}`, (s) => {
    const ready = listing && !setUp ? assignCard(s, listing.name, listing.inferredFields ?? [], names[0] ?? null) : s;
    return hasSetupBlock(ready) && viewName ? setFieldVisibleIn(ready, viewName, name, visible, type) : setCardFieldVisible(ready, name, visible, type);
  });

  const notice = (
    <>
      {!listing && collections.length === 0 && (
        <Row size="sm" hover={false} title="Assign to a collection" caption="This card shows no posts yet"
          right={[{ type: 'custom', unboxed: true, node: (
            <Field as="select" aria-label="Assign to a collection" value="" onChange={(v) => { if (v) assign(v); }}
              options={[{ value: '', label: 'Choose…' }, ...allCollections.map((c) => ({ value: c.name, label: c.name }))]} />
          ) }]} />
      )}
      {!listing && conflict.map((c) => (
        <Row key={c} size="sm" hover={false} title={`Not set up for ${c}`}
          right={[{ type: 'custom', unboxed: true, node: <Button variant="ghost" size="sm" label="Set up" onClick={() => assign(c)} /> }]} />
      ))}
    </>
  );
  if (setup === 'custom') {
    return (
      <ExpandableRow title="Fields" className="mt-2" defaultExpanded>
        <div className="pb-2">{notice}<Row size="sm" hover={false} title="Edited by hand — change it in Source" /></div>
      </ExpandableRow>
    );
  }
  if (fields.size === 0 && (listing || (collections.length > 0 && conflict.length === 0))) return null;
  return (
    <ExpandableRow title="Fields" className="mt-2" defaultExpanded>
      <div className="pb-2">
        {notice}
        {missing.map(([slot, x]) => (
          <Row key={`missing:${slot}`} size="sm" hover={false} title={slot} caption={`${x!.replace(/^!/, '')} is missing in ${viewName}`}
            right={[{ type: 'badge', label: 'Missing', variant: 'warning' }]} />
        ))}
        {[...fields].filter(([name]) => states.has(name)).map(([name, type]) => {
          // Owner 2026-10-11: only fields an element of THIS card is bound to — the
          // app never makes up an element; add one on the card and bind it (Field).
          const shown = states.get(name) === 'on-card';
          return (
            <Row key={name} title={name} rightText={type} size="sm"
              selected={selectedField === name} onClick={() => selectField(name)}
              className={shown ? undefined : 'text-text-muted'}
              right={[{ type: 'custom', unboxed: true, node: name === titleField && shown ? (
                <Tooltip content="Blog title cannot be deleted">
                  <LockIcon aria-label="Blog title cannot be deleted" className="w-4 h-4 text-text-secondary" />
                </Tooltip>
              ) : (
                <span className="flex items-center">
                  <IconButton size="sm" aria-label={`Remove ${name}`} title="Remove from card"
                    onClick={(e) => { e.stopPropagation(); removeField(name); }}>
                    <DeleteIcon className="w-4 h-4" />
                  </IconButton>
                  <IconButton size="sm" aria-label={`${shown ? 'Hide' : 'Show'} ${name}`} title={shown ? 'Hide from card' : 'Show on card'}
                    onClick={(e) => { e.stopPropagation(); toggle(name, !shown, type); }}>
                    {shown ? <VisibleIcon className="w-4 h-4" /> : <HiddenIcon className="w-4 h-4" />}
                  </IconButton>
                </span>
              ) }]} />
          );
        })}
      </div>
    </ExpandableRow>
  );
}
