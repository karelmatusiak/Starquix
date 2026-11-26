import React, { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/i18n';
import toast from 'react-hot-toast';
import { Row, Field } from '@/components/ui';
import { CodeBracesIcon } from '@/assets/icons';
import { useUndoContext } from '@/context/UndoContext';
import { useLocalProjectPath } from '@/hooks/useLocalProjectPath';
import { useLocalScanVersion } from '@/hooks/useLocalPageLayout';
import { normalizeJsonLd, type PageSeoState, type StructuredDataState } from '@/store/seo/headSeo';
import { loadStructuredData, saveStructuredData } from '@/store/seo/seoFiles';
import { SECTION_ROW_CLS, SECTION_ICON_CLS, SECTION_CONTENT_CLS, shownValue } from './shared';

/** Starter JSON-LD per schema.org type (filled with the page's title/description; '@context' and '@type' added by fill). */
const TEMPLATES: Record<string, (t: { name: string; description: string }) => object> = {
  Organization: ({ name, description }) => ({ name, description, url: '', logo: '', sameAs: [] }),
  LocalBusiness: ({ name, description }) => ({ name, description, telephone: '', address: { '@type': 'PostalAddress', streetAddress: '', addressLocality: '', postalCode: '', addressCountry: '' }, openingHours: 'Mo-Fr 09:00-18:00' }),
  Product: ({ name, description }) => ({ name, description, image: '', offers: { '@type': 'Offer', price: '', priceCurrency: 'USD', availability: 'https://schema.org/InStock' } }),
  FAQPage: () => ({ mainEntity: [{ '@type': 'Question', name: '', acceptedAnswer: { '@type': 'Answer', text: '' } }] }),
  Article: ({ name, description }) => ({ headline: name, description, author: { '@type': 'Person', name: '' }, datePublished: '' }),
  WebSite: ({ name, description }) => ({ name, description, url: '' }),
  Event: ({ name, description }) => ({ name, description, startDate: '', location: { '@type': 'Place', name: '', address: '' } }),
};

/** JSON-LD for rich results: a block on the page, or (post routes) a BlogPosting built from every post's fields. */
export const StructuredDataSection: React.FC<{ pageFile: string; page: PageSeoState; posts: boolean }> = ({ pageFile, page, posts }) => {
  const [expanded, setExpanded] = useState(false);
  const [sd, setSd] = useState<StructuredDataState | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [nonce, setNonce] = useState(0);
  const focused = useRef(false);
  const scan = useLocalScanVersion(useLocalProjectPath());
  const { takeSnapshot, claimSnapshot } = useUndoContext();

  useEffect(() => {
    if (!expanded) return;
    let live = true;
    loadStructuredData(pageFile, posts).then((s) => { if (!live) return; setSd(s); if (!focused.current) { setDraft(s.value); setError(undefined); } }).catch(() => {});
    return () => { live = false; };
  }, [expanded, pageFile, posts, scan, nonce]);

  const save = useCallback(async (json: string) => {
    takeSnapshot();
    try { await saveStructuredData(pageFile, json, claimSnapshot(), posts); }
    catch (e) { toast.error(t("Structured data was not saved: {0}", { 0: e instanceof Error ? e.message : String(e) })); }
    setNonce((n) => n + 1);
  }, [pageFile, posts, takeSnapshot, claimSnapshot]);

  const commit = () => {
    focused.current = false;
    if (!sd || draft.trim() === sd.value.trim()) return;
    if (draft.trim()) { try { normalizeJsonLd(draft); } catch (e) { setError(e instanceof Error ? e.message : String(e)); return; } }
    setError(undefined);
    void save(draft);
  };

  const fill = (type: string) => {
    const json = JSON.stringify({ '@context': 'https://schema.org', '@type': type, ...TEMPLATES[type]({ name: shownValue(page.fields.title), description: shownValue(page.fields.description) }) }, null, 2);
    setDraft(json);
    void save(json);
  };

  return (
    <Row hover={false} title="Structured data" expandable expanded={expanded} onExpandChange={setExpanded} className={SECTION_ROW_CLS} left={<CodeBracesIcon className={SECTION_ICON_CLS} />}>
      <div className={SECTION_CONTENT_CLS} data-testid="seo-structured-data">
        {sd?.kind === 'posts' ? (
          <Row hover={false} title="Article schema for every post" size="sm" className="px-0"
            right={[{ type: 'toggle', value: sd.value === 'on', 'aria-label': 'Article schema for every post', onChange: (on: boolean) => void save(on ? 'on' : '') }]} />
        ) : (
          <>
            <Row hover={false} title="Type" size="sm" className="px-0" right={[{ type: 'custom', unboxed: true, node: (
              <div className="w-32"><Field as="select" value="" onChange={(v) => v && fill(v)} disabled={!sd?.editable} aria-label="Structured data template"
                options={[{ value: '', label: 'Template…' }, ...Object.keys(TEMPLATES).map((k) => ({ value: k, label: k }))]} /></div>) }]} />
            <Field as="textarea" rows={8} mono value={draft} onChange={(v) => { setDraft(v); setError(undefined); }} disabled={!sd?.editable}
              onFocus={() => { focused.current = true; }} onBlur={commit} error={error} placeholder='{ "@context": "https://schema.org", … }' aria-label="Structured data JSON" />
          </>
        )}
      </div>
    </Row>
  );
};
