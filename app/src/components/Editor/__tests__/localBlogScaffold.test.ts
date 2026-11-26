// task-240 Phase 4: ⌘K BlogSlot insert into a project with NO collection
// scaffolds one — config entry + one post + the post route — with no prompt.
// Files are truth: three journaled writes, nothing in the doc.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ files: {} as Record<string, string>, writes: [] as Array<{ file: string; content: string }>, posts: [] as unknown[] }));
vi.mock('@/utils/sqLocalBase', () => ({
  localFetch: vi.fn(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/__sq/local/file?file=')) {
      const file = decodeURIComponent(path.split('file=')[1]);
      return file in h.files ? new Response(h.files[file], { status: 200 }) : new Response('nope', { status: 404 });
    }
    if (path === '/__sq/local/write-file') {
      const body = JSON.parse(String(init?.body)) as { file: string; content: string };
      h.writes.push(body); h.files[body.file] = body.content;
      return new Response(JSON.stringify({ ok: true, file: body.file }), { status: 200 });
    }
    throw new Error(`unexpected ${path}`);
  }),
}));
vi.mock('@/core/collections/content-ops', () => ({
  contentOps: { createPost: vi.fn(async (...a: unknown[]) => { h.posts.push(a); }) },
}));

import { scaffoldBlogCollection, addBlogToContentConfig, ensurePostLayout } from '../localBlogScaffold';
import { legacyPostRouteSource, legacyRouteLayout } from '@/core/post/legacyRoute';
import { contentOps } from '@/core/collections/content-ops';

const LISTING = "---\nimport Layout1 from '../layouts/Layout1.astro';\nimport BlogSlot from '../components/BlogSlot.astro';\n---\n<Layout1>\n  <BlogSlot />\n</Layout1>\n";

beforeEach(() => { h.files = {}; h.writes = []; h.posts = []; vi.mocked(contentOps.createPost).mockClear(); });

describe('addBlogToContentConfig', () => {
  it('creates src/content/config.ts when the project has no content config', () => {
    const out = addBlogToContentConfig(null);
    expect(out).toContain("import { defineCollection, z } from 'astro:content';");
    expect(out).toContain('const blog = defineCollection({');
    expect(out).toContain('date: z.coerce.date()');
    expect(out).toMatch(/export const collections = \{\s*blog,?\s*\};/);
  });
  it('adds a blog collection to an existing config (before the collections export, inside the map)', () => {
    const existing = "import { defineCollection, z } from 'astro:content';\n\nconst works = defineCollection({ schema: z.object({ title: z.string() }) });\n\nexport const collections = {\n  works,\n};\n";
    const out = addBlogToContentConfig(existing);
    expect(out).toContain('const works = defineCollection');
    expect(out).toContain('const blog = defineCollection({');
    expect(out).toMatch(/export const collections = \{\n  works,\n  blog,\n\};/);
    expect(out.indexOf('const blog = defineCollection')).toBeLessThan(out.indexOf('export const collections'));
  });
  it('leaves a config that already defines blog untouched', () => {
    const existing = "import { defineCollection, z } from 'astro:content';\nconst blog = defineCollection({ schema: z.object({}) });\nexport const collections = { blog };\n";
    expect(addBlogToContentConfig(existing)).toBe(existing);
  });
});

describe('ensurePostLayout (design A1)', () => {
  it('writes src/layouts/PostLayout.astro wrapping the site layout (import re-based to the layout file) + the utilities companion', async () => {
    expect(await ensurePostLayout({ name: 'Layout1', importPath: '../layouts/Layout1.astro' }, 'src/pages/blog.astro')).toBe('src/layouts/PostLayout.astro');
    const src = h.files['src/layouts/PostLayout.astro'];
    expect(src).toContain('sq-post-layout-v3');
    expect(src).toContain("import Layout1 from './Layout1.astro';");
    expect(src).toContain("import '../components/sq/sq-utilities.css';");
    expect(src).toContain('<Layout1 title={title}>');
    expect(h.files['src/components/sq/sq-utilities.css']).toBe('');
  });
  it('reuses ours; never overwrites a user PostLayout (ours goes to layouts/sq/)', async () => {
    h.files['src/layouts/PostLayout.astro'] = '---\n// sq-post-layout-v1\n---\n<slot />';
    expect(await ensurePostLayout(null, 'src/pages/index.astro')).toBe('src/layouts/PostLayout.astro');
    // ours is reused as is; only its missing utilities companion is created
    expect(h.writes.map(w => w.file)).toEqual(['src/components/sq/sq-utilities.css']);
    h.files['src/layouts/PostLayout.astro'] = '<main><slot /></main>';
    expect(await ensurePostLayout(null, 'src/pages/index.astro')).toBe('src/layouts/sq/PostLayout.astro');
    expect(h.files['src/layouts/PostLayout.astro']).toBe('<main><slot /></main>');
    expect(h.files['src/layouts/sq/PostLayout.astro']).toContain("import '../../components/sq/sq-utilities.css';");
  });
  it('no site layout → PostLayout brings its own html shell', async () => {
    await ensurePostLayout(null, 'src/pages/index.astro');
    expect(h.files['src/layouts/PostLayout.astro']).toContain('<html lang="cs">');
  });
});

describe('legacyRouteLayout (upgrade only untouched routes)', () => {
  it('recognises our legacy output, with and without a layout; an edited one is not ours', () => {
    const withLayout = legacyPostRouteSource('blog', { name: 'Layout1', importPath: '../../layouts/Layout1.astro' });
    expect(legacyRouteLayout('blog', withLayout)).toEqual({ name: 'Layout1', importPath: '../../layouts/Layout1.astro' });
    expect(legacyRouteLayout('blog', legacyPostRouteSource('blog', null))).toBeNull();
    expect(legacyRouteLayout('blog', withLayout.replace('<h1>', '<h1 class="x">'))).toBeUndefined();
  });
});

describe('scaffoldBlogCollection', () => {
  it('writes the config, one post and the post route; returns the created paths', async () => {
    const r = await scaffoldBlogCollection({ pageFile: 'src/pages/blog.astro', pageSource: LISTING });
    expect(r).toEqual({ ok: true, collection: 'blog', post: 'hello-world', created: ['src/content/config.ts', 'src/pages/blog/[slug].astro'] });
    expect(h.writes.map((w) => w.file)).toEqual(['src/content/config.ts', 'src/components/sq/sq-utilities.css', 'src/layouts/PostLayout.astro', 'src/pages/blog/[slug].astro']);
    expect(h.files['src/pages/blog/[slug].astro']).toContain("import PostLayout from '../../layouts/PostLayout.astro';");
    // `image: ''` — the schema declares the field and the card is bound to it; an
    // empty value makes the post editor show the image editor at once (no '+ Add field').
    expect(contentOps.createPost).toHaveBeenCalledWith('blog', 'hello-world', expect.objectContaining({ title: 'Hello world', draft: false, image: '' }), expect.stringContaining('first post'));
    expect(h.files['src/pages/blog/[slug].astro']).toContain("getCollection('blog')");
  });
  it('reuses an existing src/content.config.ts (Astro 5 name) instead of creating the legacy one', async () => {
    h.files['src/content.config.ts'] = "import { defineCollection, z } from 'astro:content';\nexport const collections = {\n};\n";
    const r = await scaffoldBlogCollection({ pageFile: 'src/pages/blog.astro', pageSource: LISTING });
    expect(r.ok).toBe(true);
    expect(h.writes[0].file).toBe('src/content.config.ts');
    expect(h.files['src/content.config.ts']).toContain('const blog = defineCollection');
    expect('src/content/config.ts' in h.files).toBe(false);
  });
  it('a refused write reports the reason (no throw)', async () => {
    h.files['src/pages/blog/[slug].astro'] = 'taken';
    const r = await scaffoldBlogCollection({ pageFile: 'src/pages/blog.astro', pageSource: LISTING });
    expect(r.ok).toBe(false);
    expect(contentOps.createPost).not.toHaveBeenCalled();
  });
});

describe('ensurePostRoute (posts need a route to be child pages — owner report 2026-09-28)', () => {
  const routes = vi.hoisted(() => ({ list: [] as string[] | null }));
  vi.mock('@/utils/localPageSync', async (orig) => ({
    ...(await orig<typeof import('@/utils/localPageSync')>()),
    fetchLocalPageRoutes: async () => { if (routes.list === null) throw new Error('down'); return routes.list; },
  }));

  it('a collection with no post route gets src/pages/<collection>/[slug].astro in the listing layout', async () => {
    const { ensurePostRoute } = await import('../localBlogScaffold');
    routes.list = ['/'];
    expect(await ensurePostRoute({ collection: 'blog', projectPath: 'wc://p', pageFile: 'src/pages/blog.astro', pageSource: LISTING })).toBe(true);
    expect(h.writes.map(w => w.file)).toEqual(['src/components/sq/sq-utilities.css', 'src/layouts/PostLayout.astro', 'src/pages/blog/[slug].astro']);
    expect(h.files['src/pages/blog/[slug].astro']).toContain("getCollection('blog')");
    expect(h.files['src/pages/blog/[slug].astro']).toContain('<PostLayout post={post}>');
  });

  it('createLocalCollection: the seed post first, then a post route laid out like the home page (owner report 2026-09-28)', async () => {
    const { createLocalCollection } = await import('../localBlogScaffold');
    routes.list = ['/'];
    h.files['src/pages/index.astro'] = LISTING;
    const slug = await createLocalCollection('notes', 'wc://p');
    expect(slug).toMatch(/^untitled-\d+$/);
    expect(h.posts[0]).toEqual(['notes', slug, expect.objectContaining({ title: 'Untitled' }), '']);
    expect(h.files['src/pages/notes/[slug].astro']).toContain("getCollection('notes')");
  });

  it('an existing /<collection>/[slug] or [...slug] route → nothing written', async () => {
    const { ensurePostRoute } = await import('../localBlogScaffold');
    for (const r of ['/blog/[slug]', '/blog/[...slug]']) {
      routes.list = ['/', r];
      expect(await ensurePostRoute({ collection: 'blog', projectPath: 'wc://p', pageFile: 'src/pages/index.astro', pageSource: '' })).toBe(false);
    }
    expect(h.writes).toEqual([]);
  });

  it('an UNTOUCHED legacy route is upgraded to PostLayout (site layout carried over); an edited one is left alone', async () => {
    const { ensurePostRoute } = await import('../localBlogScaffold');
    routes.list = ['/', '/blog/[slug]'];
    h.files['src/pages/blog/[slug].astro'] = legacyPostRouteSource('blog', { name: 'Layout1', importPath: '../../layouts/Layout1.astro' });
    await ensurePostRoute({ collection: 'blog', projectPath: 'wc://p', pageFile: 'src/pages/index.astro', pageSource: '' });
    expect(h.files['src/pages/blog/[slug].astro']).toContain('<PostLayout post={post}>');
    expect(h.files['src/layouts/PostLayout.astro']).toContain("import Layout1 from './Layout1.astro';");
    h.writes = [];
    h.files['src/pages/blog/[slug].astro'] = 'edited by hand';
    await ensurePostRoute({ collection: 'blog', projectPath: 'wc://p', pageFile: 'src/pages/index.astro', pageSource: '' });
    expect(h.writes).toEqual([]);
  });

  it('routes cannot be listed → nothing written (never guess)', async () => {
    const { ensurePostRoute } = await import('../localBlogScaffold');
    routes.list = null;
    expect(await ensurePostRoute({ collection: 'blog', projectPath: 'wc://p', pageFile: 'src/pages/index.astro', pageSource: '' })).toBe(false);
    expect(h.writes).toEqual([]);
  });
});
