import React, { useEffect, useState } from 'react';
import { t } from '@/i18n';
import toast from 'react-hot-toast';
import { Row, Dropzone } from '@/components/ui';
import { ShareIcon } from '@/assets/icons';
import { useYjsValue } from '@/store/hooks';
import { selectProjectId } from '@/store/selectors';
import { uploadLocalAssetFile, uploadLocalPostFieldImage } from '@/utils/imageUpload';
import { ALLOWED_IMAGE_TYPES } from '@/utils/imageValidation';
import type { PageSeoField, PageSeoState, PostRef } from '@/store/seo/headSeo';
import type { RenderedHead } from '@/store/seo/seoFiles';
import { SeoTextField } from '../SeoTextField';
import { SECTION_ROW_CLS, SECTION_ICON_CLS, SECTION_CONTENT_CLS, shownValue } from './shared';

interface Props {
  state: PageSeoState;
  rendered: RenderedHead | null;
  save: (field: PageSeoField, value: string | boolean) => void;
  /** The open post on a dynamic route: its share image is one of its fields. */
  post?: PostRef | null;
}

/** An image the page serves (`/uploads/x.png`) or an absolute URL, as something the editor can show. */
function usePreviewSrc(src: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!src) { setUrl(null); return; }
    if (/^(https?:|data:)/.test(src)) { setUrl(src); return; }
    let live = true, blobUrl: string | null = null;
    import('@/services/desktopDriver').then(({ desktopDriver, isDesktop }) => isDesktop() ? desktopDriver.fetchDocument(src.startsWith('/') ? src : `/${src}`) : null)
      .then((r) => (r?.ok ? r.blob() : null))
      .then((b) => { if (live && b) { blobUrl = URL.createObjectURL(b); setUrl(blobUrl); } else if (live) setUrl(null); })
      .catch(() => { if (live) setUrl(null); });
    return () => { live = false; if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [src]);
  return url;
}

/** The card a link to this page makes in Slack, X, LinkedIn, iMessage. */
export const SharingSection: React.FC<Props> = ({ state, rendered, save, post }) => {
  const [expanded, setExpanded] = useState(true);
  const [uploading, setUploading] = useState(false);
  const projectId = useYjsValue(selectProjectId);
  const { fields } = state;
  const image = shownValue(fields.image);
  const preview = usePreviewSrc(rendered?.image && !/^https?:\/\/localhost/.test(rendered.image) ? rendered.image : image);

  const upload = async (file: File) => {
    if (!projectId) return;
    setUploading(true);
    try {
      // A post's field may be an image() schema field: the post uploader writes what that schema accepts.
      const src = post && fields.image.postKey
        ? await uploadLocalPostFieldImage(projectId, post.file, file, fields.image.postKey, post.collection)
        : (await uploadLocalAssetFile(projectId, file)).src;
      save('image', src);
    } catch (error) {
      toast.error(t("Share image was not uploaded: {0}", { 0: error instanceof Error ? error.message : String(error) }));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Row hover={false} title="Sharing" expandable expanded={expanded} onExpandChange={setExpanded} className={SECTION_ROW_CLS} left={<ShareIcon className={SECTION_ICON_CLS} />}>
      <div className={SECTION_CONTENT_CLS}>
        <div data-testid="seo-share-card" className="pb-1">
          <Row hover={false} title="Share image" size="sm" className="px-0" rightText="1200×630" />
          <Dropzone accept={ALLOWED_IMAGE_TYPES.join(',')} disabled={!fields.image.editable || uploading} className="aspect-[1.91/1] p-0 overflow-hidden"
            onFiles={(files) => { if (files[0]) void upload(files[0]); }}>
            {preview
              ? <img src={preview} alt={shownValue(fields.imageAlt)} className="w-full h-full object-cover" />
              : <span>{uploading ? 'Uploading…' : 'Drop or choose an image'}</span>}
          </Dropzone>
        </div>
        <SeoTextField label="Image address" field="image" st={fields.image} save={save} placeholder="/uploads/share.png or https://…" />
        <SeoTextField label="Image description" field="imageAlt" st={fields.imageAlt} save={save} placeholder="What the image shows" />
        <SeoTextField label="Share title" field="shareTitle" st={fields.shareTitle} save={save} />
        <SeoTextField label="Share description" field="shareDescription" st={fields.shareDescription} save={save} multiline />
      </div>
    </Row>
  );
};
