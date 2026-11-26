import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { t } from '@/i18n';
import toast from 'react-hot-toast';
import { useUndoContext } from '@/context/UndoContext';
import { useLocalProjectPath } from '@/hooks/useLocalProjectPath';
import { useLocalScanVersion } from '@/hooks/useLocalPageLayout';
import { getLocalExpectedRoute, getLocalPageFile, subscribeLocalPageFile } from '@/utils/localPageSync';
import { isEntryRoute, type PageSeoField, type PageSeoState, type PostRef } from '@/store/seo/headSeo';
import { fetchRenderedHead, loadPageSeo, resolvePostRef, savePageSeo, type RenderedHead } from '@/store/seo/seoFiles';

const noop = () => () => {};
const none = () => null;

/**
 * The current page's SEO, read from its files (page + layout + head component)
 * and re-read after every scan (our writes, ⌘Z, outside edits). `save` writes
 * one field as one durable batch, one ⌘Z.
 */
export function usePageSeo() {
  const localPath = useLocalProjectPath();
  const scanVersion = useLocalScanVersion(localPath);
  const pageFile = useSyncExternalStore(localPath ? subscribeLocalPageFile : noop, localPath ? getLocalPageFile : none);
  const { takeSnapshot, claimSnapshot } = useUndoContext();
  const [state, setState] = useState<PageSeoState | null>(null);
  const [rendered, setRendered] = useState<RenderedHead | null>(null);
  const [nonce, setNonce] = useState(0);
  const [post, setPost] = useState<PostRef | null>(null);
  const forFile = useRef<string | null>(null);

  // Read at render: this hook re-renders on every scan; the effects below key on the route STRING.
  const route = localPath ? getLocalExpectedRoute() : null;

  // Which post a dynamic route shows: per route (a scan does not change it).
  useEffect(() => {
    let live = true;
    if (!pageFile || !isEntryRoute(pageFile)) { setPost(null); return; }
    resolvePostRef(route).then((p) => { if (live) setPost(p); }).catch(() => { if (live) setPost(null); });
    return () => { live = false; };
  }, [pageFile, route]);

  // The files: re-read after every scan (our writes, ⌘Z, outside edits).
  useEffect(() => {
    let live = true;
    if (!pageFile) { setState(null); return; }
    if (forFile.current !== pageFile) { forFile.current = pageFile; setState(null); setRendered(null); }
    loadPageSeo(pageFile, post).then((s) => { if (live) setState(s); }).catch(() => {});
    return () => { live = false; };
  }, [pageFile, post, scanVersion, nonce]);

  // What search engines see (one SSR of the page): per route and after our own save, not per scan.
  useEffect(() => {
    let live = true;
    if (!route) { setRendered(null); return; }
    fetchRenderedHead(route).then((h) => { if (live) setRendered(h); }).catch(() => {});
    return () => { live = false; };
  }, [route, nonce]);

  const save = useCallback(async (field: PageSeoField, value: string | boolean) => {
    if (!pageFile) return;
    takeSnapshot();
    try {
      await savePageSeo(pageFile, field, value, claimSnapshot(), post);
    } catch (error) {
      toast.error(t("SEO change was not saved: {0}", { 0: error instanceof Error ? error.message : String(error) }));
    }
    setNonce((n) => n + 1); // re-read: the field shows what the file now says
  }, [pageFile, post, takeSnapshot, claimSnapshot]);

  return { pageFile, state, rendered, save, post };
}
