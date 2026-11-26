import React, { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/i18n';
import toast from 'react-hot-toast';
import { Row, Button } from '@/components/ui';
import { GearIcon, UploadIcon } from '@/assets/icons';
import { useUndoContext } from '@/context/UndoContext';
import { useLocalProjectPath } from '@/hooks/useLocalProjectPath';
import { useLocalScanVersion } from '@/hooks/useLocalPageLayout';
import { useYjsValue } from '@/store/hooks';
import { selectProjectId } from '@/store/selectors';
import { uploadLocalAssetFile } from '@/utils/imageUpload';
import type { SeoFieldState, SiteHeadField } from '@/store/seo/headSeo';
import { loadSiteSeo, saveSiteAddress, saveSiteHead, saveSitemap, type SiteSeoState } from '@/store/seo/seoFiles';
import { SeoTextField } from '../SeoTextField';
import { SECTION_ROW_CLS, SECTION_ICON_CLS, SECTION_CONTENT_CLS } from './shared';

type SiteField = SiteHeadField | 'site';
const fail = (what: string) => (error: unknown) => toast.error(t("{0} was not saved: {1}", { 0: what, 1: error instanceof Error ? error.message : String(error) }));

/** Settings every page shares: the site's address, sitemap + robots.txt, favicon, language, name, X handle. */
export const SiteSection: React.FC = () => {
  const [expanded, setExpanded] = useState(false);
  const [site, setSite] = useState<SiteSeoState | null>(null);
  const [nonce, setNonce] = useState(0);
  const scan = useLocalScanVersion(useLocalProjectPath());
  const projectId = useYjsValue(selectProjectId);
  const { takeSnapshot, claimSnapshot } = useUndoContext();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!expanded) return;
    let live = true;
    loadSiteSeo().then((s) => { if (live) setSite(s); }).catch(() => {});
    return () => { live = false; };
  }, [expanded, scan, nonce]);

  const save = useCallback(async (field: SiteField, value: string) => {
    if (field === 'site') await saveSiteAddress(value).catch(fail('Site address'));
    else { takeSnapshot(); await saveSiteHead(field, value, claimSnapshot()).catch(fail('Site setting')); }
    setNonce((n) => n + 1);
  }, [takeSnapshot, claimSnapshot]);

  const st = (field: SiteField): SeoFieldState => {
    if (!site) return { value: '', editable: false };
    if (field === 'site') return { value: site.site, editable: !!site.configFile };
    const h = site.head[field];
    return { value: h.mixed ? '' : h.value, placeholder: h.mixed ? `Mixed — ${h.value}` : undefined, editable: true };
  };

  const uploadFavicon = async (file: File) => {
    if (!projectId) return;
    try { await save('favicon', (await uploadLocalAssetFile(projectId, file)).src); } catch (e) { fail('Favicon')(e); }
  };

  return (
    <Row hover={false} title="Site" expandable expanded={expanded} onExpandChange={setExpanded} className={SECTION_ROW_CLS} left={<GearIcon className={SECTION_ICON_CLS} />}>
      <div className={SECTION_CONTENT_CLS} data-testid="seo-site">
        <SeoTextField label="Site address" field="site" st={st('site')} save={save} placeholder="https://example.com" />
        <Row hover={false} title="Sitemap and robots.txt" size="sm" className="px-0" disabled={!site?.site}
          rightText={site && !site.site ? 'needs the address' : undefined}
          right={[{ type: 'toggle', value: !!site?.sitemap, 'aria-label': 'Sitemap and robots.txt',
            onChange: (on: boolean) => { void saveSitemap(on).catch(fail('Sitemap')).then(() => setNonce((n) => n + 1)); } }]} />
        <SeoTextField label="Favicon" field="favicon" st={st('favicon')} save={save} placeholder="/favicon.svg"
          trailing={<Button variant="ghost" size="sm" iconOnly aria-label="Upload favicon" icon={<UploadIcon className="w-4 h-4" />} onClick={() => fileRef.current?.click()} />} />
        <input ref={fileRef} type="file" className="hidden" accept="image/png,image/svg+xml,image/x-icon,image/jpeg,image/webp"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadFavicon(f); }} />
        <SeoTextField label="Language" field="lang" st={st('lang')} save={save} placeholder="en" />
        <SeoTextField label="Site name" field="siteName" st={st('siteName')} save={save} placeholder="Shown on share cards" />
        <SeoTextField label="X handle" field="xHandle" st={st('xHandle')} save={save} placeholder="@yourname" />
      </div>
    </Row>
  );
};
