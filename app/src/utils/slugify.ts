/**
 * Single source of truth for page-name → URL slug derivation.
 *
 * Both the editor (LinkBlock internal-page hrefs) and the export pipeline
 * (generateAstro route filenames, llms.txt slugs) MUST derive page URLs from
 * this module. They previously had divergent copies — "Q&A" minted editor href
 * /qa but exported route /q-a. See docs/archive/plans/2026-06-11-shared-slugify-design.md.
 *
 * NOT for theme slugs (ThemesLibraryContext.tsx) or deploy site names
 * (export/deploy.ts) — separate domains with different character rules.
 */

/** Lowercase, fold Czech (and other Latin) diacritics, collapse the rest to hyphens. */
export function slugify(text: string): string {
  const folded = text.normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/gi, 'l');
  const result = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  // Fallback for inputs that result in empty slug (e.g., all special characters)
  return result || 'untitled';
}

/**
 * The exported-route path for a page. The home page (explicit isHome flag,
 * resolved by selectHomePageId) → '/'. Callers that know home resolution MUST
 * pass `isHome` (editor links and exported routes stay in lockstep); when
 * omitted, falls back to the legacy name-magic (pageId 'default' or name
 * "home", case-insensitive) so un-migrated docs keep their root route.
 */
export function pageHref(pageId: string, pageName: string, isHome?: boolean): string {
  const home = isHome ?? (pageId === 'default' || pageName.toLowerCase() === 'home');
  return home ? '/' : `/${slugify(pageName)}`;
}
