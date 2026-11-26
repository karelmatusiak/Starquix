// Engine ledger tests — docs/plans/2026-11-17-seo-files-truth-design.md §7.
import { describe, it, expect } from 'vitest';
import { readPageSeo, editPageSeo, chainFiles, SeoEditError } from '../headSeo';
import { scanTags } from '../astroScan';

const SCAFFOLD = `<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Home</title>
  </head>
  <body></body>
</html>
`;

// Shape of the imported mayhopar site (src/layouts/Main.astro, 2026-11-17).
const MAIN = `---
import Header from "../components/Header.astro";
import '../fonts.css';

interface Props { bodyClass?: string;
	title: string;
	description?: string;
	image?: string;
}

const { title, description = "Designs for user delight", image = "https://mayhopar.com/cover.jpg" } = Astro.props;
---

<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<title>{title}</title>
		<meta name="description" content={description} />
		<meta name="keywords" content="design, ui">
		<link rel="icon" type="image/svg+xml" href="/favicon.jpg" />
		<meta property="og:image" content={image} />
		<meta property="og:image:alt" content="A website cover" />
		<meta name="twitter:title" content={title} />
	</head>
	<body class={Astro.props.bodyClass ?? "bg-slate-50"}>
		<Header />
		<slot />
	</body>
</html>
`;
const ABOUT = `---
import Layout from '../layouts/Main.astro';
import Main from '../components/Main.astro';
---

<Layout bodyClass="bg-slate-50" title="Oleg | About">
	<Main>
		<p>Hi</p>
	</Main>
</Layout>
`;
const BLOG = ABOUT.replace('Oleg | About', 'Oleg | Blog');

const site = (extra: Record<string, string> = {}) => ({
  'src/pages/about.astro': ABOUT, 'src/pages/blog.astro': BLOG, 'src/layouts/Main.astro': MAIN, ...extra,
});
const apply = (sources: Record<string, string>, out: Record<string, string>) => ({ ...sources, ...out });

describe('scanner', () => {
  it('finds guarded tags, attr spans and close spans', () => {
    const src = '<head><title>{t}</title>{d && <meta name="description" content={d} />}</head>';
    const tags = scanTags(src);
    const meta = tags.find((t) => t.name === 'meta')!;
    expect(meta.expr).toEqual({ start: src.indexOf('{d'), end: src.indexOf('</head>') });
    expect(meta.parent).toBe(0);
    const content = meta.attrs.find((a) => a.name === 'content')!;
    expect(src.slice(content.start, content.end)).toBe('content={d}');
    expect(src.slice(tags[1].close!.start, tags[1].close!.end)).toBe('</title>');
  });
  it('skips script/style bodies (JSON-LD braces) and comments', () => {
    const src = '<head><script type="application/ld+json">{"a":"<meta>"}</script><!-- <title>x</title> --><title>Y</title></head>';
    expect(scanTags(src).map((t) => t.name)).toEqual(['head', 'script', 'title']);
  });
  it('apostrophes in text are not strings', () => {
    const src = "<p>it's {x}</p><title>Z</title>";
    expect(scanTags(src).map((t) => t.name)).toEqual(['p', 'title']);
  });
});

describe('row 2 — scaffold page (own head)', () => {
  const S = { 'src/pages/index.astro': SCAFFOLD };
  it('reads the literal title, everything else empty + editable', () => {
    const st = readPageSeo(S, 'src/pages/index.astro');
    expect(st.headFile).toBe('src/pages/index.astro');
    expect(st.fields.title).toMatchObject({ value: 'Home', editable: true });
    expect(st.fields.description).toMatchObject({ value: '', editable: true });
    expect(st.fields.shareTitle.placeholder).toBe('Home');
  });
  it('edits the title in place', () => {
    const out = editPageSeo(S, 'src/pages/index.astro', 'title', 'Acme — bikes');
    expect(out['src/pages/index.astro']).toContain('<title>Acme — bikes</title>');
    expect(readPageSeo(apply(S, out), 'src/pages/index.astro').fields.title.value).toBe('Acme — bikes');
  });
  it('inserts a missing description with the head indentation', () => {
    const out = editPageSeo(S, 'src/pages/index.astro', 'description', 'We fix bikes.');
    expect(out['src/pages/index.astro']).toContain('    <title>Home</title>\n    <meta name="description" content="We fix bikes." />\n  </head>');
  });
  it('a share image also adds the large twitter card, once', () => {
    let s: Record<string, string> = S;
    s = apply(s, editPageSeo(s, 'src/pages/index.astro', 'image', '/uploads/a.png'));
    s = apply(s, editPageSeo(s, 'src/pages/index.astro', 'image', '/uploads/b.png'));
    const out = s['src/pages/index.astro'];
    expect(out.match(/twitter:card/g)).toHaveLength(1);
    expect(out).toContain('<meta property="og:image" content="/uploads/b.png" />');
  });
  it('row 14 — clearing removes the tag (title keeps an empty <title>)', () => {
    let s: Record<string, string> = S;
    s = apply(s, editPageSeo(s, 'src/pages/index.astro', 'description', 'X'));
    s = apply(s, editPageSeo(s, 'src/pages/index.astro', 'description', ''));
    expect(s['src/pages/index.astro']).toBe(SCAFFOLD);
    s = apply(s, editPageSeo(s, 'src/pages/index.astro', 'title', ''));
    expect(s['src/pages/index.astro']).toContain('<title></title>');
  });
  it('noindex toggles a robots tag', () => {
    let s: Record<string, string> = S;
    s = apply(s, editPageSeo(s, 'src/pages/index.astro', 'noindex', true));
    expect(readPageSeo(s, 'src/pages/index.astro').fields.noindex.value).toBe(true);
    s = apply(s, editPageSeo(s, 'src/pages/index.astro', 'noindex', false));
    expect(s['src/pages/index.astro']).toBe(SCAFFOLD);
  });
});

describe('row 3 — layout fed by props', () => {
  it('reads the page attribute and the layout default as placeholder', () => {
    const st = readPageSeo(site(), 'src/pages/about.astro');
    expect(st.headFile).toBe('src/layouts/Main.astro');
    expect(st.layoutFile).toBe('src/layouts/Main.astro');
    expect(st.fields.title).toMatchObject({ value: 'Oleg | About', editable: true });
    expect(st.fields.description).toMatchObject({ value: '', placeholder: 'Designs for user delight', editable: true });
    expect(st.fields.image).toMatchObject({ value: '', placeholder: 'https://mayhopar.com/cover.jpg' });
  });
  it('editing writes ONLY the page attribute', () => {
    const out = editPageSeo(site(), 'src/pages/about.astro', 'description', 'About Oleg');
    expect(Object.keys(out)).toEqual(['src/pages/about.astro']);
    expect(out['src/pages/about.astro']).toContain('<Layout bodyClass="bg-slate-50" title="Oleg | About" description="About Oleg">');
  });
  it('clearing removes the attribute → the default shows again', () => {
    const s = apply(site(), editPageSeo(site(), 'src/pages/about.astro', 'description', 'About Oleg'));
    const back = editPageSeo(s, 'src/pages/about.astro', 'description', '');
    expect(back['src/pages/about.astro']).toBe(ABOUT);
  });
});

describe('row 4/5 — connect: the layout learns a prop, other pages unchanged', () => {
  it('a literal in the layout becomes `{p ?? old}`', () => {
    const out = editPageSeo(site(), 'src/pages/about.astro', 'imageAlt', 'Portrait of Oleg');
    expect(Object.keys(out).sort()).toEqual(['src/layouts/Main.astro', 'src/pages/about.astro']);
    expect(out['src/layouts/Main.astro']).toContain('<meta property="og:image:alt" content={imageAlt ?? "A website cover"} />');
    expect(out['src/layouts/Main.astro']).toMatch(/image = "https:\/\/mayhopar\.com\/cover\.jpg", imageAlt \} = Astro\.props/);
    expect(out['src/layouts/Main.astro']).toMatch(/image\?: string;\n\timageAlt\?: string;\n\}/);
    expect(out['src/pages/about.astro']).toContain('imageAlt="Portrait of Oleg"');
    const after = apply(site(), out);
    // Another page keeps the old literal (as its placeholder) and reads back as editable.
    expect(readPageSeo(after, 'src/pages/blog.astro').fields.imageAlt).toMatchObject({ value: '', editable: true });
    expect(readPageSeo(after, 'src/pages/about.astro').fields.imageAlt.value).toBe('Portrait of Oleg');
  });
  it('a missing tag is inserted guarded + prop + page attr', () => {
    const out = editPageSeo(site(), 'src/pages/about.astro', 'canonical', 'https://mayhopar.com/about');
    expect(out['src/layouts/Main.astro']).toContain('{canonical && <link rel="canonical" href={canonical} />}\n\t</head>');
    expect(out['src/pages/about.astro']).toContain('canonical="https://mayhopar.com/about"');
    expect(readPageSeo(apply(site(), out), 'src/pages/about.astro').fields.canonical.value).toBe('https://mayhopar.com/about');
  });
  it('noindex connect: guarded robots tag, boolean page attr', () => {
    let s: Record<string, string> = site();
    s = apply(s, editPageSeo(s, 'src/pages/about.astro', 'noindex', true));
    expect(s['src/pages/about.astro']).toMatch(/<Layout [^>]* noindex>/);
    expect(readPageSeo(s, 'src/pages/about.astro').fields.noindex.value).toBe(true);
    expect(readPageSeo(s, 'src/pages/blog.astro').fields.noindex.value).toBe(false);
    s = apply(s, editPageSeo(s, 'src/pages/about.astro', 'noindex', false));
    expect(s['src/pages/about.astro']).toBe(ABOUT);
  });
  it('a prop name already used for something else gets a fresh one', () => {
    const L = MAIN.replace('const { title,', 'const { canonical, title,');
    const out = editPageSeo(site({ 'src/layouts/Main.astro': L }), 'src/pages/about.astro', 'canonical', 'https://a.co/x');
    expect(out['src/layouts/Main.astro']).toContain('{seoCanonical && <link rel="canonical" href={seoCanonical} />}');
  });
});

describe('share fields follow their fallback until split', () => {
  it('og:title={title} follows the title; a share title splits it off', () => {
    const L = MAIN.replace('<meta name="twitter:title" content={title} />', '<meta property="og:title" content={title} />');
    const s = site({ 'src/layouts/Main.astro': L });
    expect(readPageSeo(s, 'src/pages/about.astro').fields.shareTitle).toMatchObject({ value: '', placeholder: 'Oleg | About' });
    const out = editPageSeo(s, 'src/pages/about.astro', 'shareTitle', 'Meet Oleg');
    expect(out['src/layouts/Main.astro']).toContain('<meta property="og:title" content={shareTitle ?? title} />');
    const after = apply(s, out);
    expect(readPageSeo(after, 'src/pages/about.astro').fields.shareTitle.value).toBe('Meet Oleg');
    expect(readPageSeo(after, 'src/pages/about.astro').fields.title.value).toBe('Oleg | About');
  });
});

describe('row 6 — one hop into a head component', () => {
  const HEAD = `---
const { title, description, ogImage, canonicalUrl } = Astro.props;
---
<title>{title}</title>
<meta name="description" content={description} />
<meta property="og:image" content={ogImage} />
<link rel="canonical" href={canonicalUrl} />`;
  const LAYOUT = `---
import BaseHead from '../components/Head.astro';
const { title, description } = Astro.props;
---
<html><head><BaseHead title={title} description={description} /></head><body><slot /></body></html>`;
  const PAGE = `---\nimport L from '../layouts/Base.astro';\n---\n<L title="Hi"><p/></L>\n`;
  const S = { 'src/pages/index.astro': PAGE, 'src/layouts/Base.astro': LAYOUT, 'src/components/Head.astro': HEAD };
  it('follows the hop to the page attribute', () => {
    const st = readPageSeo(S, 'src/pages/index.astro');
    expect(st.fields.title).toMatchObject({ value: 'Hi', editable: true });
    const out = editPageSeo(S, 'src/pages/index.astro', 'description', 'D');
    expect(Object.keys(out)).toEqual(['src/pages/index.astro']);
  });
  it('a hop prop the layout does not pass is threaded through the layout', () => {
    const out = editPageSeo(S, 'src/pages/index.astro', 'image', '/a.png');
    expect(out['src/layouts/Base.astro']).toContain('<BaseHead title={title} description={description} ogImage={image} />');
    expect(out['src/pages/index.astro']).toContain('<L title="Hi" image="/a.png">');
    expect(readPageSeo(apply(S, out), 'src/pages/index.astro').fields.image.value).toBe('/a.png');
  });
  it('chainFiles reads exactly page → layout → head component', async () => {
    const read: string[] = [];
    const got = await chainFiles('src/pages/index.astro', async (f) => { read.push(f); return (S as Record<string, string>)[f] ?? null; });
    expect(read).toEqual(['src/pages/index.astro', 'src/layouts/Base.astro', 'src/components/Head.astro']);
    expect(Object.keys(got)).toHaveLength(3);
  });
});

describe('rows 7/9/10/17 — edges', () => {
  it('row 7 — computed in the page is read-only with file:line', () => {
    const P = `---\nconst { post } = Astro.props;\n---\n<html><head><title>{post.data.title}</title></head><body/></html>`;
    const st = readPageSeo({ 'src/pages/x.astro': P }, 'src/pages/x.astro');
    expect(st.fields.title).toMatchObject({ editable: false, setIn: { file: 'src/pages/x.astro', line: 4 } });
    expect(() => editPageSeo({ 'src/pages/x.astro': P }, 'src/pages/x.astro', 'title', 'N')).toThrow(SeoEditError);
  });
  it('a const literal in the page frontmatter reads as the literal', () => {
    const P = `---\nconst title = 'Pricing';\n---\n<html><head><title>{title}</title></head><body/></html>`;
    expect(readPageSeo({ 'src/pages/x.astro': P }, 'src/pages/x.astro').fields.title.value).toBe('Pricing');
  });
  it('row 9 — a fragment page is wrapped into the document shape', () => {
    const P = `---\nimport Hero from '../components/Hero.astro';\n---\n<Hero />\n<section>Hi</section>\n`;
    const S = { 'src/pages/x.astro': P, 'src/components/Hero.astro': '<div/>' };
    expect(readPageSeo(S, 'src/pages/x.astro').headFile).toBeNull();
    const out = editPageSeo(S, 'src/pages/x.astro', 'title', 'X');
    expect(out['src/pages/x.astro']).toMatch(/^---[\s\S]*---\n<html lang="cs">\n  <head>[\s\S]*<title>X<\/title>\n  <\/head>\n  <body>\n<Hero \/>\n<section>Hi<\/section>\n  <\/body>\n<\/html>\n$/);
  });
  it('a fragment page keeps the language already used in the project', () => {
    const P = `---\n---\n<section>Hi</section>\n`;
    const out = editPageSeo({ 'src/pages/x.astro': P, 'src/pages/index.astro': '<html lang="de"><head></head><body></body></html>' }, 'src/pages/x.astro', 'title', 'X');
    expect(out['src/pages/x.astro']).toContain('<html lang="de">');
  });
  it('a wrapper we cannot locate makes the fields read-only (never wraps a layout page)', () => {
    const P = `---\nimport L from 'some-package/Layout.astro';\n---\n<L title="x"><p/></L>`;
    const st = readPageSeo({ 'src/pages/x.astro': P }, 'src/pages/x.astro');
    expect(st.headFile).toBeNull();
  });
  it('row 17 — quotes, braces, ampersands and emoji round-trip', () => {
    const S = { 'src/pages/index.astro': SCAFFOLD };
    for (const v of ['Tom & "Jerry" {x} <b>', 'Café ☕️ — 日本', "it's"]) {
      const s = apply(S, editPageSeo(S, 'src/pages/index.astro', 'title', v));
      expect(readPageSeo(s, 'src/pages/index.astro').fields.title.value).toBe(v);
      const d = apply(S, editPageSeo(S, 'src/pages/index.astro', 'description', v));
      expect(readPageSeo(d, 'src/pages/index.astro').fields.description.value).toBe(v);
      const p = apply(site(), editPageSeo(site(), 'src/pages/about.astro', 'description', v));
      expect(readPageSeo(p, 'src/pages/about.astro').fields.description.value).toBe(v);
    }
  });
  it('newlines collapse; values are trimmed', () => {
    const S = { 'src/pages/index.astro': SCAFFOLD };
    const s = apply(S, editPageSeo(S, 'src/pages/index.astro', 'description', '  line one\n line two  '));
    expect(readPageSeo(s, 'src/pages/index.astro').fields.description.value).toBe('line one line two');
  });
  it('row 16 — canonical must be an absolute http(s) URL', () => {
    expect(() => editPageSeo({ 'src/pages/index.astro': SCAFFOLD }, 'src/pages/index.astro', 'canonical', 'about')).toThrow(/https/);
  });
  it('row 8 — duplicate titles are reported', () => {
    const P = SCAFFOLD.replace('<title>Home</title>', '<title>Home</title><title>Again</title>');
    expect(readPageSeo({ 'src/pages/index.astro': P }, 'src/pages/index.astro').fields.title.duplicateIn).toBe('src/pages/index.astro');
  });
  it('row 10 — an unclosed head is a problem, nothing editable', () => {
    const P = '<html><head><title>x</title><body></body></html>';
    const st = readPageSeo({ 'src/pages/x.astro': P }, 'src/pages/x.astro');
    expect(st.problem).toMatch(/not closed/);
  });
});

describe('any layout depth is editable (props threaded up to the page)', () => {
  const BASE = `---\nconst { title } = Astro.props;\n---\n<html><head><title>{title}</title><link rel="icon" href="/f.svg" /></head><body><slot /></body></html>`;
  const MID = `---\nimport Base from './Base.astro';\nconst { heading } = Astro.props;\n---\n<Base title={heading}><main><slot /></main></Base>`;
  const PAGE = `---\nimport Mid from '../layouts/Mid.astro';\n---\n<Mid heading="Hello"><p/></Mid>\n`;
  const S = { 'src/pages/index.astro': PAGE, 'src/layouts/Mid.astro': MID, 'src/layouts/Base.astro': BASE };
  it('reads the page attribute through two layouts', () => {
    expect(readPageSeo(S, 'src/pages/index.astro').fields.title).toMatchObject({ value: 'Hello', editable: true });
  });
  it('a tag two layouts away is inserted in the head and threaded through the middle layout', () => {
    const out = editPageSeo(S, 'src/pages/index.astro', 'description', 'Desc');
    expect(out['src/layouts/Base.astro']).toContain('{description && <meta name="description" content={description} />}');
    expect(out['src/layouts/Mid.astro']).toContain('<Base title={heading} description={description}>');
    expect(out['src/layouts/Mid.astro']).toContain('const { heading, description } = Astro.props;');
    expect(out['src/pages/index.astro']).toContain('<Mid heading="Hello" description="Desc">');
    expect(readPageSeo(apply(S, out), 'src/pages/index.astro').fields.description.value).toBe('Desc');
  });
});

describe('post routes: SEO is per post (frontmatter), the route learns to read it', () => {
  const ROUTE = `---
import { getCollection } from 'astro:content';
import PostLayout from '../../layouts/Post.astro';
export async function getStaticPaths() {
  return (await getCollection('blog')).map((post) => ({ params: { slug: post.id }, props: { post } }));
}
const { post } = Astro.props;
---
<PostLayout title={post.data.title}><p/></PostLayout>
`;
  const LAYOUT = `---\nconst { title } = Astro.props;\n---\n<html><head><title>{title} | Blog</title></head><body><slot /></body></html>`;
  const POST = `---\ntitle: Hello world\ndate: 2026-01-01\n---\nBody\n`;
  const S = { 'src/pages/blog/[slug].astro': ROUTE, 'src/layouts/Post.astro': LAYOUT, 'src/content/blog/hello.md': POST };
  const ref = { file: 'src/content/blog/hello.md', collection: 'blog' };
  it('reads the title from the post', () => {
    const st = readPageSeo(S, 'src/pages/blog/[slug].astro', ref);
    expect(st.fields.title).toMatchObject({ value: 'Hello world', editable: true, postKey: 'title' });
    expect(st.post).toEqual({ file: ref.file });
  });
  it('editing the title writes the post only', () => {
    const out = editPageSeo(S, 'src/pages/blog/[slug].astro', 'title', 'Hi "there"', ref);
    expect(Object.keys(out)).toEqual([ref.file]);
    expect(out[ref.file]).toBe('---\ntitle: "Hi \\"there\\""\ndate: 2026-01-01\n---\nBody\n');
    expect(readPageSeo(apply(S, out), 'src/pages/blog/[slug].astro', ref).fields.title.value).toBe('Hi "there"');
  });
  it('a missing description: layout gets a guarded tag, the route passes post.data.description, the post gets the value', () => {
    const out = editPageSeo(S, 'src/pages/blog/[slug].astro', 'description', 'About hello', ref);
    expect(out['src/layouts/Post.astro']).toContain('{description && <meta name="description" content={description} />}');
    expect(out['src/pages/blog/[slug].astro']).toContain('<PostLayout title={post.data.title} description={post.data.description}>');
    expect(out[ref.file]).toContain('description: "About hello"');
    const after = apply(S, out);
    expect(readPageSeo(after, 'src/pages/blog/[slug].astro', ref).fields.description.value).toBe('About hello');
    // a second edit only touches the post
    expect(Object.keys(editPageSeo(after, 'src/pages/blog/[slug].astro', 'description', 'Again', ref))).toEqual([ref.file]);
  });
  it('noindex on a post is a boolean field', () => {
    let s: Record<string, string> = S;
    s = apply(s, editPageSeo(s, 'src/pages/blog/[slug].astro', 'noindex', true, ref));
    expect(s[ref.file]).toContain('noindex: true');
    expect(readPageSeo(s, 'src/pages/blog/[slug].astro', ref).fields.noindex.value).toBe(true);
    s = apply(s, editPageSeo(s, 'src/pages/blog/[slug].astro', 'noindex', false, ref));
    expect(s[ref.file]).not.toContain('noindex');
  });
  it('without an open post, a per-post field is read-only (never written into the shared route)', () => {
    const st = readPageSeo(S, 'src/pages/blog/[slug].astro');
    expect(st.fields.title).toMatchObject({ editable: false, setIn: { reason: expect.stringMatching(/open a post/) } });
    expect(() => editPageSeo(S, 'src/pages/blog/[slug].astro', 'title', 'X')).toThrow(/Open a post/);
  });
  it('a paginated list ([...page].astro, no post) is a normal page: its SEO is the list page\'s', () => {
    const LIST = "---\nimport L from '../../layouts/Post.astro';\nexport async function getStaticPaths({ paginate }) { return paginate([], { pageSize: 10 }); }\nconst { page } = Astro.props;\n---\n<L title=\"Blog\">{page.data.map((p) => <a>{p.id}</a>)}</L>\n";
    const P = { 'src/pages/blog/[...page].astro': LIST, 'src/layouts/Post.astro': LAYOUT };
    expect(readPageSeo(P, 'src/pages/blog/[...page].astro').fields.title).toMatchObject({ value: 'Blog', editable: true });
    const out = editPageSeo(P, 'src/pages/blog/[...page].astro', 'title', 'All posts');
    expect(out['src/pages/blog/[...page].astro']).toContain('<L title="All posts">');
  });
});

describe('generated post layouts read post data through an alias (d = post.data, pick)', () => {
  const POSTLAYOUT = `---
import Post from './Post.astro';
const { post } = Astro.props;
const d = post?.data ?? {};
const pick = (...keys: string[]) => { for (const k of keys) { const v = d[k]; if (v) return v; } return undefined; };
const rawTitle = pick('title');
const hasTitle = typeof rawTitle === 'string' && rawTitle.trim() !== '';
const title = hasTitle ? rawTitle : 'Untitled';
---
<Post title={title} description={typeof d.description === 'string' ? d.description : undefined}><slot /></Post>
`;
  const POST = `---\nconst { title, description = "Default" } = Astro.props;\n---\n<html><head><title>{title}</title><meta name="description" content={description} /></head><body><slot/></body></html>`;
  const ROUTE = "---\nimport PostLayout from '../../layouts/PostLayout.astro';\nconst { post } = Astro.props;\n---\n<PostLayout post={post}><p/></PostLayout>\n";
  const S = { 'src/pages/blog/[slug].astro': ROUTE, 'src/layouts/PostLayout.astro': POSTLAYOUT, 'src/layouts/Post.astro': POST, 'src/content/blog/a.md': '---\ntitle: A\ndescription: Desc A\n---\n' };
  const ref = { file: 'src/content/blog/a.md', collection: 'blog' };
  it('title and description are the post fields — edits touch only the post', () => {
    const st = readPageSeo(S, 'src/pages/blog/[slug].astro', ref);
    expect(st.fields.title).toMatchObject({ value: 'A', postKey: 'title', editable: true });
    expect(st.fields.description).toMatchObject({ value: 'Desc A', postKey: 'description', editable: true });
    expect(Object.keys(editPageSeo(S, 'src/pages/blog/[slug].astro', 'description', 'New', ref))).toEqual([ref.file]);
    expect(Object.keys(editPageSeo(S, 'src/pages/blog/[slug].astro', 'title', 'New T', ref))).toEqual([ref.file]);
  });
});

describe('legacy Astro.glob post routes (post.frontmatter.x)', () => {
  const ROUTE = `---
import Layout from '../../layouts/Layout.astro';
export async function getStaticPaths() {
  const posts = await Astro.glob('../../content/posts/*.md');
  return posts.map(post => ({ params: { slug: post.frontmatter.slug }, props: { post } }));
}
const { post } = Astro.props;
---
<Layout title={post.frontmatter.title}>
  <main><post.Content /></main>
</Layout>
`;
  const LAYOUT = `---\nconst { title = 'Release fixture' } = Astro.props;\n---\n<html lang="en">\n  <head>\n    <title>{title}</title>\n  </head>\n  <body><slot /></body>\n</html>\n`;
  const S = { 'src/pages/posts/[slug].astro': ROUTE, 'src/layouts/Layout.astro': LAYOUT, 'src/content/posts/hello.md': '---\ntitle: Hello\nslug: hello\n---\nHi\n' };
  const ref = { file: 'src/content/posts/hello.md', collection: 'posts' };
  it('reads + writes through post.frontmatter', () => {
    expect(readPageSeo(S, 'src/pages/posts/[slug].astro', ref).fields.title).toMatchObject({ value: 'Hello', postKey: 'title' });
    const out = editPageSeo(S, 'src/pages/posts/[slug].astro', 'description', 'D', ref);
    expect(out['src/pages/posts/[slug].astro']).toContain('<Layout title={post.frontmatter.title} description={post.frontmatter.description}>');
    expect(readPageSeo({ ...S, ...out }, 'src/pages/posts/[slug].astro', ref).fields.description.value).toBe('D');
  });
});

// Altitude guard: the engine must keep understanding what OUR generator writes (a generator
// refactor must not silently make post SEO read-only). Real postLayoutSource()/postRouteSource() output.
import { postLayoutSource, postRouteSource } from '@/core/post/postLayoutSource';
describe('generated post layout + route (real generator output)', () => {
  const layoutFile = 'src/layouts/PostLayout.astro';
  for (const site of [null, { name: 'Main', importPath: './Main.astro' }] as const) {
    it(`title is the post's own field (${site ? 'wrapping a site layout' : 'own document'})`, () => {
      const MAIN = `---\nconst { title } = Astro.props;\n---\n<html><head><title>{title}</title></head><body><slot/></body></html>`;
      const S: Record<string, string> = {
        'src/pages/blog/[slug].astro': postRouteSource('blog', '../../layouts/PostLayout.astro'),
        [layoutFile]: postLayoutSource(site),
        'src/layouts/Main.astro': MAIN,
        'src/content/blog/a.md': '---\ntitle: A\n---\n',
      };
      const ref = { file: 'src/content/blog/a.md', collection: 'blog' };
      const st = readPageSeo(S, 'src/pages/blog/[slug].astro', ref);
      expect(st.fields.title).toMatchObject({ value: 'A', postKey: 'title', editable: true });
      expect(Object.keys(editPageSeo(S, 'src/pages/blog/[slug].astro', 'title', 'B', ref))).toEqual([ref.file]);
      // a field the layout lacks is still writable (connect + thread), and reads back from the post
      const out = editPageSeo(S, 'src/pages/blog/[slug].astro', 'description', 'D', ref);
      expect(readPageSeo({ ...S, ...out }, 'src/pages/blog/[slug].astro', ref).fields.description.value).toBe('D');
    });
  }
});
