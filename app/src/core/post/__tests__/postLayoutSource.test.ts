import { describe, it, expect } from 'vitest';
import { ALL_ARTICLE_CLASS_STRINGS } from '../articleTokens';
import { postLayoutSource, postRouteSource, POST_LAYOUT_MARKER } from '../postLayoutSource';

describe('PostLayout source', () => {
  const src = postLayoutSource({ name: 'Layout', importPath: './Layout.astro' });

  it.each(ALL_ARTICLE_CLASS_STRINGS)('carries the token literal verbatim (Tailwind scans it): %s', cls => {
    expect(src).toContain(cls);
  });
  it('marker, no font-family, no style block', () => {
    expect(src).toContain(POST_LAYOUT_MARKER);
    expect(src).not.toMatch(/font-family|font-(serif|sans|mono)\b/);
    expect(src).not.toMatch(/<style[\s>]/);
  });
  it('header variants + every toggle are typed Props (→ the settings panel)', () => {
    expect(src).toContain("header?: 'classic' | 'centered' | 'cover';");
    for (const t of ['showSubtitle', 'showAuthor', 'showDate', 'showReadingTime', 'showCover']) expect(src).toContain(`${t}?: boolean;`);
  });
  it('cover without an image falls back to classic; per-post hide flags honoured', () => {
    expect(src).toContain("header === 'cover' && !cover ? 'classic' : header");
    for (const f of ['hideCover', 'hideAuthor', 'hideDate', 'hideReadingTime', 'hideSubtitle']) expect(src).toContain(`'${f}'`);
  });
  it('wraps the site layout; without one it brings a margin-free html shell', () => {
    expect(src).toContain('<Layout title={title}>');
    const bare = postLayoutSource(null);
    expect(bare).toContain('<html lang="cs">');
    expect(bare).toContain('<body class="m-0">');
    expect(postLayoutSource(null, undefined, 'de')).toContain('<html lang="de">');
    expect(bare).not.toContain('import Layout');
  });
  it('a site layout itself named PostLayout never self-imports', () => {
    expect(postLayoutSource({ name: 'PostLayout', importPath: './Base.astro' })).toContain("import SiteLayout from './Base.astro';");
  });
  it('the route is one PostLayout invocation', () => {
    const r = postRouteSource('blog', '../../layouts/PostLayout.astro');
    expect(r).toContain("import PostLayout from '../../layouts/PostLayout.astro';");
    expect(r).toContain('<PostLayout post={post}>\n  <Content />\n</PostLayout>');
  });
});
