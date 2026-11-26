import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '@/i18n';
import { useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Row, Button, OperationNotice } from '@/components/ui';
import { PlusIcon } from '@/assets/icons';
import { useDispatch } from '@/store/hooks';
import { useUndoContext } from '@/context/UndoContext';
import { useSelectedElement } from '@/context/SelectionContext';
import { useLocalProjectPath } from '@/hooks/useLocalProjectPath';
import { syncImageAttrToIframe, rebindLocalBoundAsset, repointLocalBoundAsset } from '@/utils/imageUpload';
import { makeLocalAssetSource, makeDexieAssetSource, type MediaAssetEntry } from './assetSources';

// task-135 second half (review F3) + task-144: the project's media library.
// Local mode lists the opened folder's real files (public/** served by the
// user's own astro dev, src/assets/** read-only); WC lists the Dexie asset
// store. ONE section, per-runtime source (assetSources.ts).

const MEDIA_EXPANDED_KEY = 'starquix:assets-media-expanded';

export const MediaSection = memo(function MediaSection() {
  const localPath = useLocalProjectPath();
  const params = useParams<{ '*': string }>();
  const projectId = params['*'] ?? '';
  const dispatch = useDispatch();
  const { takeSnapshot } = useUndoContext();
  const { key: selectedKey, tagName, sourceLocation: selectedSourceLocation, boundAssetPath } = useSelectedElement();
  const [expanded, setExpanded] = useState(() => localStorage.getItem(MEDIA_EXPANDED_KEY) === '1');
  const [assets, setAssets] = useState<MediaAssetEntry[]>([]);
  const assetsRef = useRef<MediaAssetEntry[]>([]);
  const [readState, setReadState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [operationIssue, setOperationIssue] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const requestVersion = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const source = useMemo(() => {
    return localPath ? makeLocalAssetSource(projectId, localPath) : makeDexieAssetSource(projectId);
  }, [localPath, projectId]);

  const sourceRef = useRef(source); sourceRef.current = source;
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    setReadState('loading');
    try {
      const list = await source.list();
      if (sourceRef.current !== source || version !== requestVersion.current) { source.dispose?.(list); return false; }
      source.dispose?.(assetsRef.current);
      assetsRef.current = list;
      setAssets(list); setReadState('ready'); setOperationIssue(null); return true;
    } catch {
      if (sourceRef.current === source && version === requestVersion.current) setReadState('unavailable');
      return false;
    }
  }, [source]);

  useEffect(() => { localStorage.setItem(MEDIA_EXPANDED_KEY, expanded ? '1' : '0'); }, [expanded]);

  useEffect(() => {
    setAssets([]); setOperationIssue(null); setUploading(false); void refresh();
    return () => { requestVersion.current++; source.dispose?.(assetsRef.current); assetsRef.current = []; };
  }, [source, refresh]);

  const handleUpload = useCallback(async (file: File) => {
    if (uploading) return;
    setUploading(true); setOperationIssue(null);
    let uploaded = false;
    try {
      await source.upload(file); uploaded = true;
      if (sourceRef.current !== source) return;
      if (!await refresh()) setOperationIssue('Media uploaded. The library is unavailable.');
    } catch {
      if (sourceRef.current === source) setOperationIssue(uploaded ? 'Media uploaded. The library is unavailable.' : "Media upload couldn't finish.");
    } finally { if (sourceRef.current === source) setUploading(false); }
  }, [source, refresh, uploading]);

  // task-142/144: picks route by WHAT the selected img is — the original
  // unconditional dispatch+DOM-sync was a silent lie for astro <Image>
  // elements (no source location → nothing ever written; the src mutation
  // also destroyed the /_image URL the bound-media detection needs).
  const handlePick = useCallback(async (entry: MediaAssetEntry) => {
    if (!entry.applySrc) return; // src/assets: import-based, read-only (design ledger #2)
    if (selectedKey && tagName === 'img') {
      // Source-located <img> — the attr write rides the runtime's image sync
      // (local: real file write; WC: doc overlay applied at RENDER).
      if (selectedSourceLocation) {
        takeSnapshot();
        dispatch({ type: 'UPDATE_IMAGE_ATTRIBUTE', elementId: selectedKey, attribute: 'src', value: entry.applySrc });
        syncImageAttrToIframe(selectedKey, 'src', entry.applySrc);
        toast.success(t("Set image to {0}", { 0: entry.applySrc }));
        return;
      }
      // Content-bound astro <Image> — rebind the DATA (local-only: the WC
      // source has no fileFor, so bound-looking picks fall through to the
      // honest note instead of faking success).
      if (boundAssetPath && localPath && source?.fileFor) {
        try {
          const file = await source.fileFor(entry);
          if (!file) throw new Error('Could not read the asset file');
          const oldPath = boundAssetPath;
          const { newAsset } = await rebindLocalBoundAsset(projectId, oldPath, file);
          takeSnapshot({
            reverse: () => { void repointLocalBoundAsset(projectId, newAsset, oldPath); },
            forward: () => { void repointLocalBoundAsset(projectId, oldPath, newAsset); },
          });
          toast.success(t("Image replaced — content data updated"));
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Replace failed');
        }
        return;
      }
      // Prop-driven — nothing writable; never mutate the DOM to fake success.
      toast('This image comes from component props — set it where the component is used', { icon: '⚠️' });
      return;
    }
    void navigator.clipboard?.writeText(entry.applySrc);
    toast(`URL copied — select an image element to apply directly`);
  }, [selectedKey, tagName, selectedSourceLocation, boundAssetPath, localPath, projectId, source, takeSnapshot, dispatch]);

  if (!source) return null;

  return (
    <>
      <div className="border-t border-stroke" />
      {/* Collapsed by DEFAULT and capped at max-h-48: this section used to
          claim up to 256px of the sidebar unconditionally, squeezing the
          component tree into a sliver. The choice is remembered per browser. */}
      <div className={`flex flex-col shrink-0 overflow-hidden ${expanded ? 'max-h-48' : ''}`}>
        <Row
          title="Media"
          size="sm"
          className="pl-3 pr-1"
          left={[{ type: 'chevron', expanded, onToggle: () => setExpanded(!expanded) }]}
          onClick={() => setExpanded(!expanded)}
          right={
            <Button variant="ghost" size="sm" iconOnly disabled={uploading} title={localPath ? 'Upload to public/uploads' : 'Upload to the media library'} aria-label="Upload media" onClick={() => { setExpanded(true); fileInputRef.current?.click(); }}>
              <PlusIcon className="w-4 h-4" />
            </Button>
          }
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleUpload(file);
            e.target.value = '';
          }}
        />
        <div className={`flex-1 overflow-y-auto scrollbar-thin px-2 pb-2 ${expanded ? '' : 'hidden'}`}>
          {readState === 'loading' && <Row size="sm" title="Loading project media…" hover={false} />}
          {(readState === 'unavailable' || operationIssue) && <OperationNotice title={operationIssue ?? 'Project media is unavailable.'} action={readState === 'unavailable' ? { label: 'Retry', onClick: () => { void refresh(); } } : undefined} />}
          {readState === 'ready' && assets.length === 0 && (
            <div className="px-1 py-2 text-xs text-text-muted">
              {localPath ? 'No media in public/ or src/assets' : 'No media yet — upload or drop images'}
            </div>
          )}
          <div className="grid grid-cols-4 gap-1">
            {assets.filter(a => a.kind === 'image').map(entry => (
              <Button
                key={entry.name}
                variant="ghost"
                title={entry.applySrc ?? `${entry.name} (import-based, read-only)`}
                aria-label={entry.name}
                onClick={() => handlePick(entry)}
                className="h-14 px-0 rounded-inner overflow-hidden"
                icon={
                  entry.thumbUrl ? (
                    <img
                      src={entry.thumbUrl}
                      alt=""
                      loading="lazy"
                      className={`w-full h-full object-cover ${entry.applySrc ? '' : 'opacity-50'}`}
                    />
                  ) : undefined
                }
              />
            ))}
          </div>
          {assets.filter(a => a.kind !== 'image').map(entry => (
            <Row
              key={entry.name}
              title={<span className="text-xs truncate">{entry.name.replace(/^public\//, '')}</span>}
              size="sm"
              className="h-7"
              onClick={() => handlePick(entry)}
            />
          ))}
        </div>
      </div>
    </>
  );
});
