/**
 * `src/layouts/PostLayout.astro` — the post article look written into a
 * project (design docs/plans/2026-09-28-post-article-look-design.md, A1–A3).
 * A normal, user-editable layout: it wraps the site's own layout (header,
 * nav, footer stay theirs) and owns the header + reading column + body type.
 * Every class is a literal from articleTokens.ts, so Tailwind in the project
 * sees it and the editor can mirror it.
 */
import { siteUsesContentLayer } from '@/utils/siteAstro';
import { BODY, COLUMN, HEADER } from './articleTokens';
import { V1_BODY, V1_COVER_WIDE, V1_SUBTITLE_PICK } from './articleTokensV1';
import { SUBTITLE_KEYS, COVER_KEYS, DATE_KEYS, WORDS_PER_MINUTE } from './postHeaderView';

/** One set of pick keys for the page and the writing view (postHeaderView). */
const quoted = (keys: readonly string[]) => keys.map(k => `'${k}'`).join(', ');
/** The subtitle pick line the layout writes (also what an older layout's line upgrades to). */
export const SUBTITLE_PICK = `pick(${quoted(SUBTITLE_KEYS)})`;
import { rebaseImportSpecifier } from '@/utils/blogBinding';
import { importSpecifierFor } from '@/utils/localStructural';
import { SQ_SYSTEM_DIR } from '@/utils/systemComponents';

export const POST_LAYOUT_FILE = 'src/layouts/PostLayout.astro';
export const POST_LAYOUT_MARKER = 'sq-post-layout-v3';
/** Any version of our marker — a file carrying one is ours (upgradable), never the user's own. */
const ANY_POST_LAYOUT_MARKER = /sq-post-layout-v\d+/;
/** Used when the project already has its own PostLayout.astro (never overwritten). */
export const POST_LAYOUT_FALLBACK_FILE = 'src/layouts/sq/PostLayout.astro';
export const UTILITIES_FILE = `${SQ_SYSTEM_DIR}sq-utilities.css`;

export interface SiteLayoutRef {
  name: string;
  /** import specifier relative to POST_LAYOUT_FILE */
  importPath: string;
}

/** `utilitiesImport` = sq-utilities.css relative to the layout file. */
export function postLayoutSource(site: SiteLayoutRef | null, utilitiesImport = importSpecifierFor(POST_LAYOUT_FILE, UTILITIES_FILE), lang = 'cs'): string {
  const wrapperName = site && site.name !== 'PostLayout' ? site.name : 'SiteLayout';
  const frontmatter = `---
/**
 * ${POST_LAYOUT_MARKER} — how every post looks (Starquix). Yours to edit.
 * header: classic (Medium-like) · centered (Substack-like) · cover (image first).
 * Each piece shows only when it is switched on AND the post has the data;
 * a post can hide one with frontmatter (hideCover, hideAuthor, hideDate,
 * hideReadingTime, hideSubtitle: true).
 */
${site ? `import ${wrapperName} from '${site.importPath}';\n` : ''}import '${utilitiesImport}';

interface Props {
  post: { data?: Record<string, any>; body?: string };
  header?: 'classic' | 'centered' | 'cover';
  showSubtitle?: boolean;
  showAuthor?: boolean;
  showDate?: boolean;
  showReadingTime?: boolean;
  showCover?: boolean;
}

const {
  post,
  header = 'classic',
  showSubtitle = true,
  showAuthor = true,
  showDate = true,
  showReadingTime = true,
  showCover = true,
} = Astro.props;

const d = post?.data ?? {};
const pick = (...keys: string[]) => {
  for (const k of keys) {
    const v = d[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};
const hidden = (k: string) => d[k] === true;
const srcOf = (v: any): string | undefined => (typeof v === 'string' ? v : v?.src);

const rawTitle = pick('title');
const hasTitle = typeof rawTitle === 'string' && rawTitle.trim() !== '';
const title = hasTitle ? rawTitle : 'Untitled';
const subtitle = showSubtitle && !hidden('hideSubtitle') ? ${SUBTITLE_PICK} : undefined;
const cover = showCover && !hidden('hideCover') ? srcOf(pick(${quoted(COVER_KEYS)})) : undefined;
const author = showAuthor && !hidden('hideAuthor') ? pick('author') : undefined;
const authorName = typeof author === 'string' ? author : author?.name;
const authorAvatar = typeof author === 'object' ? srcOf(author?.avatar) : undefined;
const rawDate = showDate && !hidden('hideDate') ? pick(${quoted(DATE_KEYS)}) : undefined;
const date = rawDate ? new Date(rawDate) : null;
const dateText = date && !isNaN(date.getTime())
  ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  : null;
const words = showReadingTime && !hidden('hideReadingTime')
  ? String(post?.body ?? '')
      .replace(/^(import|export)\\s.*$/gm, ' ')
      .replace(/<[^>]*>/g, ' ')
      .split(/\\s+/)
      .filter((w) => /[\\p{L}\\p{N}]/u.test(w)).length
  : 0;
const readingText = words ? \`\${Math.max(1, Math.round(words / ${WORDS_PER_MINUTE}))} min read\` : null;
const meta = [dateText, readingText].filter(Boolean);
// No image → the cover header has nothing to lead with: classic instead.
const variant = header === 'cover' && !cover ? 'classic' : header;
---`;

  const article = `<article data-sq-post-layout={variant} dir="auto">
  {variant === 'cover' && cover && (
    <img src={cover} alt="" loading="eager" decoding="async" class="${HEADER.coverHero}" />
  )}
  <header class:list={['${COLUMN}', '${HEADER.base}', variant === 'centered' && '${HEADER.centered}']}>
    <h1 class:list={['${HEADER.title}', !hasTitle && '${HEADER.titleEmpty}']}>{title}</h1>
    {subtitle && <p class="${HEADER.subtitle}">{subtitle}</p>}
    {(authorName || meta.length > 0) && (
      <div class="sq-meta ${HEADER.meta}">
        {authorAvatar && <img src={authorAvatar} alt="" class="${HEADER.avatar}" loading="eager" />}
        {authorName && <span class="${HEADER.author}">{authorName}</span>}
        {meta.map((m, i) => (
          <span class="${HEADER.metaItem}">
            {(authorName || i > 0) && <span aria-hidden="true" class="${HEADER.dot}">·</span>}
            <span class="${HEADER.metaQuiet}">{m}</span>
          </span>
        ))}
      </div>
    )}
    {variant !== 'cover' && cover && (
      <img
        src={cover}
        alt=""
        loading="eager"
        decoding="async"
        class={variant === 'classic' ? '${HEADER.coverWide}' : '${HEADER.cover}'}
      />
    )}
  </header>
  <div class="${COLUMN} ${BODY}">
    <slot />
  </div>
</article>`;

  const indent = (s: string, n: number) => s.split('\n').map(l => (l ? ' '.repeat(n) + l : l)).join('\n');
  const body = site
    ? `<${wrapperName} title={title}>\n${indent(article, 2)}\n</${wrapperName}>`
    : `<html lang="${lang}">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>{title}</title>\n  </head>\n  <body class="m-0">\n${indent(article, 4)}\n  </body>\n</html>`;
  return `${frontmatter}\n\n${body}\n`;
}

/** A post route rendered through PostLayout (`src/pages/<c>/[slug].astro`). */
export function postRouteSource(collection: string, layoutImport: string, contentLayer = siteUsesContentLayer()): string {
  // Content layer (Astro ≥5): entries carry `id` and render through `render(entry)`; legacy entries carry both on themselves.
  return `---
import { getCollection${contentLayer ? ', render' : ''} } from 'astro:content';
import PostLayout from '${layoutImport}';
export async function getStaticPaths() {
  const posts = await getCollection('${collection}');
  return posts.map((post) => ({ params: { slug: post.${contentLayer ? 'id' : 'slug'} }, props: { post } }));
}
const { post } = Astro.props;
const { Content } = await ${contentLayer ? 'render(post)' : 'post.render()'};
---

<PostLayout post={post}>
  <Content />
</PostLayout>
`;
}

/**
 * THE rule for where our PostLayout lives, shared by the scaffold and the
 * on-open upgrade: reuse a file carrying our marker; else take the first free
 * name. A user's own PostLayout.astro is never overwritten. `read` answers a
 * file's text or null/undefined when absent. null = both names are the user's.
 * `writes` = the layout (when new, wrapping `site` — a spec relative to
 * `siteFrom`) + the utilities companion when missing.
 */
export function planPostLayout(
  read: (path: string) => string | null | undefined,
  site: SiteLayoutRef | null,
  siteFrom: string,
): { file: string; writes: Record<string, string> } | null {
  const writes: Record<string, string> = {};
  for (const file of [POST_LAYOUT_FILE, POST_LAYOUT_FALLBACK_FILE]) {
    const existing = read(file);
    if (existing != null && !ANY_POST_LAYOUT_MARKER.test(existing)) continue; // the user's own
    // the companion first: the layout imports it
    if (read(UTILITIES_FILE) == null) writes[UTILITIES_FILE] = '';
    if (existing == null) {
      const ref = site ? { name: site.name, importPath: rebaseImportSpecifier(site.importPath, siteFrom, file) } : null;
      const home = read('src/pages/index.astro') ?? read('src/layouts/Layout.astro') ?? '';
      const lang = home.match(/<html\b[^>]*\blang=["']([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)["']/i)?.[1] ?? 'cs';
      writes[file] = postLayoutSource(ref, importSpecifierFor(file, UTILITIES_FILE), lang);
    }
    return { file, writes };
  }
  return null;
}

/**
 * Every layout version we ever shipped, frozen: the literals it wrote that a
 * newer version replaces. An older marker is upgraded by swapping ONLY those
 * literals (a class list the user edited keeps their edit) and bumping the
 * marker. A new version = bump POST_LAYOUT_MARKER + freeze the old literals
 * here; postLayoutSource.ratchet.test.ts fails until both happen.
 */
const FROZEN_LAYOUTS: Record<string, { bodyClasses: string; coverWide: string; subtitlePick: string }> = {
  // v1 shipped in more than one BODY variant (a media rule was added without
  // a marker bump), so the body test is "every class is one v1 ever wrote"
  'sq-post-layout-v1': { bodyClasses: `${COLUMN} ${V1_BODY}`, coverWide: V1_COVER_WIDE, subtitlePick: V1_SUBTITLE_PICK },
  // v2 is the current article look, with the bare shell still in English.
  'sq-post-layout-v2': { bodyClasses: `${COLUMN} ${BODY}`, coverWide: HEADER.coverWide, subtitlePick: SUBTITLE_PICK },
};

/** An older layout of ours → the current literals. null = nothing to upgrade. */
export function upgradePostLayout(src: string): string | null {
  // whole marker only: 'sq-post-layout-v1' must not match a future v10
  const marker = Object.keys(FROZEN_LAYOUTS).find(m => new RegExp(`${m}(?!\\d)`).test(src));
  if (!marker) return null;
  const old = FROZEN_LAYOUTS[marker];
  const known = new Set(old.bodyClasses.split(/\s+/));
  return src
    .replace(/<div class="([^"]*)">(\s*<slot \/>)/, (whole, cls: string, rest: string) =>
      cls.split(/\s+/).every(t => known.has(t)) ? `<div class="${COLUMN} ${BODY}">${rest}` : whole)
    .split(`'${old.coverWide}'`).join(`'${HEADER.coverWide}'`)
    .split(old.subtitlePick).join(SUBTITLE_PICK)
    .replace(/<html lang="en">/g, '<html lang="cs">')
    .replace(marker, POST_LAYOUT_MARKER);
}
