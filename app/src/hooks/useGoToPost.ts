import { useCallback } from 'react';
import { t } from '@/i18n';
import { useEditorDoc } from '@/store/hooks';
import { selectCurrentPageId, selectPostPageByCollectionId } from '@/store/selectors';
import { selectContentCollections } from '@/store/collectionSelectors';
import { usePages } from '@/context/PagesContext';
import { usePostEditor } from '@/context/PostEditorContext';
import { createPostPage } from '@/utils/createPostPage';
import toast from 'react-hot-toast';

/**
 * Navigate to a blog post's rendered page in the editor. Creates the post page
 * on demand, expands the host page so the new entry is visible in the Pages
 * panel, and primes the previewer so the canvas renders the clicked post.
 *
 * `parentPageId` overrides the host page (defaults to the currently active
 * page — the page hosting the blog slot in most cases).
 */
export function useGoToPost() {
  const doc = useEditorDoc();
  const { setActivePage, expandPages } = usePages();
  const { setPreviewPost } = usePostEditor();

  return useCallback(async (collectionId: string, postSlug: string, parentPageId?: string | null) => {
    const collection = selectContentCollections(doc).find(c => c.id === collectionId);
    if (!collection) return;
    const hostPageId = parentPageId ?? selectCurrentPageId(doc);
    const existing = selectPostPageByCollectionId(doc, collectionId);
    let targetPageId: string;
    try {
      targetPageId = existing?.id ?? await createPostPage(doc, collectionId, collection.name, hostPageId);
    } catch (error) {
      toast.error(t("Could not open the post page — {0}", { 0: error instanceof Error ? error.message : 'storage failed' }));
      return;
    }
    if (hostPageId) expandPages([hostPageId]);
    setActivePage(targetPageId);
    setPreviewPost(collection.name, postSlug);
  }, [doc, setActivePage, expandPages, setPreviewPost]);
}
