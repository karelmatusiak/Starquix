import { memo, useCallback, useState } from 'react';
import { t } from '@/i18n';
import toast from 'react-hot-toast';
import { useContentCollections } from '@/hooks/useContentCollections';
import { useYjsValue, useEditorDoc } from '@/store/hooks';
import { selectContentCollections } from '@/store/collectionSelectors';
import { selectCurrentPageId } from '@/store/selectors';
import { useUndoContext } from '@/context/UndoContext';
import { createDefaultCollection } from '@/core/collections/types';
import { createCollectionOnDisk } from '@/core/collections/api';
import { createLocalCollection } from '@/components/Editor/localBlogScaffold';
import { synthesizeLocalCollections } from '@/core/collections/localFields';
import { createPostPage } from '@/utils/createPostPage';
import { useLocalProjectPath } from '@/hooks/useLocalProjectPath';
import { CollectionTree } from './CollectionTree';
import { Row, Button, InlineEdit } from '@/components/ui';
import { PlusIcon } from '@/assets/icons';

export const CollectionsPanel = memo(function CollectionsPanel() {
  const doc = useEditorDoc();
  const { takeSnapshot, claimSnapshot } = useUndoContext();
  const yCollections = useYjsValue(selectContentCollections);
  const { collections: diskCollections, isLoading } = useContentCollections();
  const currentPageId = useYjsValue(selectCurrentPageId);
  const localPath = useLocalProjectPath();
  // Review F2: local_ projects render DISK collections — files are truth,
  // nothing seeds Yjs contentCollections for them.
  const rows = localPath ? synthesizeLocalCollections(diskCollections) : yCollections;

  // The name is an inline row, never a native prompt() (owner 2026-09-12: the
  // dialog "appears and disappears immediately" — any attached automation
  // client or extension dismisses native dialogs, and they freeze the
  // browser extension's own tabs).
  const [naming, setNaming] = useState(false);
  const handleCreateCollection = useCallback(async (collectionName: string) => {
    if (localPath) {
      // Files-truth: the shared create (seed post + post route) — see createLocalCollection.
      try {
        await createLocalCollection(collectionName, localPath);
      } catch (err) {
        toast.error(t("Could not create the collection — {0}", { 0: err instanceof Error ? err.message : 'write failed' }));
      }
      return;
    }
    try {
      takeSnapshot();
      const collection = createDefaultCollection(collectionName);
      await createPostPage(doc, collection.id, collectionName, currentPageId, claimSnapshot?.(),
        [{ type: 'ADD_CONTENT_COLLECTION', collection }]);
      if (currentPageId) {
        window.dispatchEvent(new CustomEvent('sq:expand-page', { detail: { pageId: currentPageId } }));
      }
      await createCollectionOnDisk(collectionName, collection);
    } catch (error) {
      toast.error(t("Could not finish creating the collection — {0}", { 0: error instanceof Error ? error.message : 'storage failed' }));
    }
  }, [doc, takeSnapshot, claimSnapshot, currentPageId, localPath]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Row
        title="Content Collections"
        size="sm"
        className="pl-3 pr-1"
        right={
          <Button variant="ghost" size="sm" iconOnly title="New collection" onClick={() => setNaming(true)}>
            <PlusIcon className="w-4 h-4" />
          </Button>
        }
      />
      {naming && (
        <Row size="sm" hover={false} className="pl-3 pr-2" title={
          <InlineEdit value="" aria-label="Collection name" editing onEditingChange={() => setNaming(false)}
            onCommit={(name) => { void handleCreateCollection(name); }} />
        } />
      )}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-1">
        {isLoading && <div className="px-3 py-2 text-xs text-text-muted">Loading...</div>}
        {rows.map(col => (
          <CollectionTree
            key={col.id}
            collection={col}
            diskPosts={diskCollections.find(d => d.name === col.name)?.posts || []}
          />
        ))}
      </div>
    </div>
  );
});
