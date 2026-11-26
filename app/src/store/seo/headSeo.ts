/**
 * Page SEO in the project files — the engine (design: docs/plans/2026-11-17-seo-files-truth-design.md).
 *
 * A page's SEO lives where an Astro developer would put it:
 *  - the page's own `<head>` (scaffold / layout-less pages) → literal tags, edited in place;
 *  - a layout's `<head>` fed by props → attributes on the page's `<Layout …>` tag;
 *  - one hop into a head component (`<BaseHead … />`) inside that head.
 * A value the layout hard-codes (or a tag it lacks) is "connected" on first edit:
 * the layout learns a prop (`{p ?? <old>}`, or a guarded tag), every other page
 * renders exactly as before, and the page sets the attribute — one batch, one ⌘Z.
 *
 * Pure + sync over a `sources` map (path → bytes). `chainFiles` tells the IO
 * layer which files to read; `readPageSeo` / `editPageSeo` re-resolve from the
 * bytes they are given, so an edit computed on fresh before-bytes stays exact.
 */
import { parseFrontmatter } from '@/core/collections/content-ops';
import {
  applySplices, attrOf, decodeEntities, jsString, jsStringValue, readLocalConsts, readPropsDecl, referencedIdents,
  removeAttr, scanTags, skipJs, splitFrontmatter,
  type Attr, type Frontmatter, type PropsDecl, type Span, type Splice, type Tag,
} from './astroScan';

export type PageSeoField = 'title' | 'description' | 'image' | 'imageAlt' | 'noindex' | 'canonical' | 'shareTitle' | 'shareDescription';
export const PAGE_SEO_FIELDS: PageSeoField[] = ['title', 'description', 'image', 'imageAlt', 'noindex', 'canonical', 'shareTitle', 'shareDescription'];

interface FieldSpec {
  match(tag: Tag): boolean;
  /** Where the value sits: the element's text, or an attribute. */
  attr?: string;
  bool?: boolean;
  /** Default prop name when a layout learns this field. */
  prop: string;
  /** Literal tag for a page head. */
  literal(v: string): string;
  /** Guarded tag for a layout head, fed by prop `p`. */
  guarded(p: string): string;
  /** Shares fall back to this field when this one is unset. */
  fallback?: PageSeoField;
}

const metaIs = (key: 'name' | 'property', value: string) => (t: Tag) =>
  t.name === 'meta' && (attrOf(t, key)?.value ?? attrOf(t, key === 'name' ? 'property' : 'name')?.value)?.toLowerCase() === value;
const absUrl = (p: string) => `Astro.site ? new URL(${p}, Astro.site).href : ${p}`;

const SPECS: Record<PageSeoField, FieldSpec> = {
  title: {
    match: (t) => t.name === 'title', prop: 'title',
    literal: (v) => `<title>${titleText(v)}</title>`,
    guarded: (p) => `<title>{${p}}</title>`,
  },
  description: {
    match: metaIs('name', 'description'), attr: 'content', prop: 'description',
    literal: (v) => `<meta name="description" content=${htmlAttr(v)} />`,
    guarded: (p) => `{${p} && <meta name="description" content={${p}} />}`,
  },
  image: {
    match: metaIs('property', 'og:image'), attr: 'content', prop: 'image',
    literal: (v) => `<meta property="og:image" content=${htmlAttr(v)} />`,
    guarded: (p) => `{${p} && <meta property="og:image" content={${absUrl(p)}} />}`,
  },
  imageAlt: {
    match: metaIs('property', 'og:image:alt'), attr: 'content', prop: 'imageAlt',
    literal: (v) => `<meta property="og:image:alt" content=${htmlAttr(v)} />`,
    guarded: (p) => `{${p} && <meta property="og:image:alt" content={${p}} />}`,
  },
  noindex: {
    match: metaIs('name', 'robots'), attr: 'content', bool: true, prop: 'noindex',
    literal: () => '<meta name="robots" content="noindex, nofollow" />',
    guarded: (p) => `{${p} && <meta name="robots" content="noindex, nofollow" />}`,
  },
  canonical: {
    match: (t) => t.name === 'link' && (attrOf(t, 'rel')?.value ?? '').toLowerCase() === 'canonical', attr: 'href', prop: 'canonical',
    literal: (v) => `<link rel="canonical" href=${htmlAttr(v)} />`,
    guarded: (p) => `{${p} && <link rel="canonical" href={${p}} />}`,
  },
  shareTitle: {
    match: metaIs('property', 'og:title'), attr: 'content', prop: 'shareTitle', fallback: 'title',
    literal: (v) => `<meta property="og:title" content=${htmlAttr(v)} />`,
    guarded: (p) => `{${p} && <meta property="og:title" content={${p}} />}`,
  },
  shareDescription: {
    match: metaIs('property', 'og:description'), attr: 'content', prop: 'shareDescription', fallback: 'description',
    literal: (v) => `<meta property="og:description" content=${htmlAttr(v)} />`,
    guarded: (p) => `{${p} && <meta property="og:description" content={${p}} />}`,
  },
};

const TWITTER_CARD = metaIs('name', 'twitter:card');

// ── value encoders ──────────────────────────────────────────────────────────

/** A quoted HTML attribute, or a JS string expression when quoting would be lossy. */
function htmlAttr(v: string): string {
  return /["\n{}]/.test(v) ? `{${jsString(v)}}` : `"${v.replace(/&/g, '&amp;')}"`;
}
/** A component prop value: Astro passes quoted values raw (no entity decoding). */
function propAttr(key: string, v: string): string {
  return /["\n]/.test(v) ? `${key}={${jsString(v)}}` : `${key}="${v}"`;
}
function titleText(v: string): string {
  return /[{}<>&]/.test(v) ? `{${jsString(v)}}` : v;
}
/** One-line, trimmed: what a meta tag can carry. */
function normalizeSeoValue(field: PageSeoField, v: string): string {
  const flat = v.replace(/\s*\n\s*/g, ' ').trim();
  return field === 'title' || field === 'shareTitle' ? flat.replace(/\s+/g, ' ') : flat;
}

// ── files + chain ───────────────────────────────────────────────────────────

interface FileInfo {
  file: string;
  src: string;
  fm: Frontmatter | null;
  tags: Tag[];
  props: PropsDecl | null;
  consts: Map<string, Span>;
  /** Consts that ARE a prop's content-entry data (`const d = post?.data ?? {}`) → that prop's key. */
  dataAliases: Map<string, string>;
  /** Helper functions reading such data by key (`const pick = (...keys) => d[k]…`). */
  dataPickers: Set<string>;
}

const infoCache = new Map<string, FileInfo>();

/** Parsed file, memoized by path while its bytes are unchanged (a read re-resolves the chain several times). */
function info(file: string, src: string): FileInfo {
  const hit = infoCache.get(file);
  if (hit && hit.src === src) return hit;
  const parsed = parseInfo(file, src);
  infoCache.set(file, parsed);
  return parsed;
}

function parseInfo(file: string, src: string): FileInfo {
  const fm = splitFrontmatter(src);
  const props = fm ? readPropsDecl(src, fm) : null;
  const consts = fm ? readLocalConsts(src, fm) : new Map<string, Span>();
  const dataAliases = new Map<string, string>();
  const dataPickers = new Set<string>();
  for (const [name, span] of consts) {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*\??\.\s*(?:data|frontmatter)\s*(?:\?\?\s*\{\s*\})?\s*$/.exec(src.slice(span.start, span.end));
    const entry = m && props?.entries.find((e) => e.alias === m[1]);
    if (entry) dataAliases.set(name, entry.key);
  }
  for (const [name, span] of consts) {
    const body = src.slice(span.start, span.end);
    if (/^\s*\(\s*\.\.\.\s*\w+/.test(body) && [...dataAliases.keys()].some((a) => new RegExp(`\\b${a}\\s*\\[`).test(body))) dataPickers.add(name);
  }
  return { file, src, fm, tags: scanTags(src, fm?.templateStart ?? 0), props, consts, dataAliases, dataPickers };
}

const isComponent = (t: Tag) => /^[A-Z]/.test(t.name);
const tagEnd = (t: Tag) => t.close?.end ?? t.openEnd;
const lineOf = (src: string, offset: number) => src.slice(0, offset).split('\n').length;

/** `import Name from 'spec'` → spec. */
function importSpec(f: FileInfo, name: string): string | null {
  if (!f.fm) return null;
  const re = new RegExp(`import\\s+${name.replace(/\./g, '\\.')}\\s+from\\s+['"]([^'"]+)['"]`);
  return re.exec(f.fm.code)?.[1] ?? null;
}

/** Project-relative path of an import, or null for one we cannot place. */
function resolveImport(fromFile: string, spec: string): string | null {
  let path: string;
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const parts = fromFile.split('/').slice(0, -1);
    for (const seg of spec.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    path = parts.join('/');
  } else if (/^\/?src\//.test(spec)) path = spec.replace(/^\//, '');
  else if (/^[@~]\//.test(spec)) path = `src/${spec.slice(2)}`;
  else return null;
  return /\.astro$/.test(path) ? path : `${path}.astro`;
}

/** The single top-level component wrapping the whole template (a layout candidate). */
function wrapperOf(f: FileInfo): number {
  const top = f.tags.map((t, i) => [t, i] as const).filter(([t]) => t.parent === -1 && !t.expr && !/^(style|script)$/i.test(t.name));
  if (top.length !== 1) return -1;
  const [t, i] = top[0];
  return isComponent(t) ? i : -1;
}

const headTagOf = (f: FileInfo) => f.tags.findIndex((t) => t.name === 'head' && !t.expr);

interface Chain {
  page: FileInfo;
  /** layouts[0] wraps the page; each wraps the previous. */
  layouts: Array<{ info: FileInfo; tagInParent: number }>;
  head: { info: FileInfo; tag: number } | null;
  /** Head components (one hop), keyed by their tag index in the head file. */
  hops: Map<number, FileInfo>;
}

type ChainResult = { chain: Chain } | { need: string } | { problem: string };

const MAX_LAYOUT_DEPTH = 3;

function buildChain(sources: Record<string, string | null | undefined>, pageFile: string): ChainResult {
  const pageSrc = sources[pageFile];
  if (pageSrc == null) return { need: pageFile };
  const page = info(pageFile, pageSrc);
  const layouts: Chain['layouts'] = [];
  let cur = page;
  let head: Chain['head'] = headTagOf(page) >= 0 ? { info: page, tag: headTagOf(page) } : null;
  while (!head && layouts.length < MAX_LAYOUT_DEPTH) {
    const w = wrapperOf(cur);
    if (w < 0) break;
    const spec = importSpec(cur, cur.tags[w].name);
    if (!spec) break; // a component defined/imported in a way we do not follow → not a layout
    const path = resolveImport(cur.file, spec);
    if (!path) return { problem: `Can't find the file of <${cur.tags[w].name}> (${spec})` };
    const src = sources[path];
    if (src === undefined) return { need: path };
    if (src === null) return { problem: `Can't read ${path}` };
    const next = info(path, src);
    layouts.push({ info: next, tagInParent: w });
    cur = next;
    const h = headTagOf(next);
    if (h >= 0) head = { info: next, tag: h };
  }
  if (!head) layouts.length = 0; // wrappers without a head are page content, not layouts
  const hops = new Map<number, FileInfo>();
  if (head) {
    const h = head.info.tags[head.tag];
    for (let i = head.tag + 1; i < head.info.tags.length; i++) {
      const t = head.info.tags[i];
      if (t.start >= (h.close?.start ?? h.openEnd)) break;
      if (!isComponent(t)) continue;
      const spec = importSpec(head.info, t.name);
      const path = spec && resolveImport(head.info.file, spec);
      if (!path) continue;
      const src = sources[path];
      if (src === undefined) return { need: path };
      if (src !== null) hops.set(i, info(path, src));
    }
  }
  return { chain: { page, layouts, head, hops } };
}

/** The resolved chain, or a SeoEditError saying what is missing (the editors' entry). */
function chainOf(sources: Record<string, string | null | undefined>, pageFile: string): Chain {
  const r = buildChain(sources, pageFile);
  if ('need' in r) throw new SeoEditError(`Can't read ${r.need}`);
  if ('problem' in r) throw new SeoEditError(r.problem);
  return r.chain;
}

/** The files a page's SEO depends on, discovered by reading: call with a reader. */
export async function chainFiles(pageFile: string, read: (file: string) => Promise<string | null>): Promise<Record<string, string | null>> {
  const sources: Record<string, string | null> = {};
  for (let guard = 0; guard < 12; guard++) {
    const r = buildChain(sources, pageFile);
    if (!('need' in r)) return sources;
    sources[r.need] = await read(r.need).catch(() => null);
  }
  return sources;
}

// ── classification ──────────────────────────────────────────────────────────

/** An attribute's current value as a JS expression (for `{p ?? <old>}`). */
function attrExpr(a: Attr): string {
  if (a.kind === 'quoted') return jsString(a.value);
  if (a.kind === 'empty') return 'true';
  if (a.kind === 'shorthand') return a.name;
  if (a.kind === 'template') return '`' + a.value + '`';
  return `(${a.value.trim()})`;
}

type Cls =
  /** `span` = a frontmatter const's string literal, edited in place. */
  | { kind: 'literal'; value: string; span?: Span }
  /** A prop of this file; `dataKey` = the value is `<prop>.data.<dataKey>` (a content entry's field). */
  | { kind: 'prop'; key: string; defaultText?: string; exact: boolean; dataKey?: string }
  | { kind: 'computed' };

const DATA_RE = /^\s*([A-Za-z_$][\w$]*)\s*\??\.\s*(?:data|frontmatter)\s*\??\.\s*([A-Za-z_$][\w$]*)\s*(?:(?:\?\?|\|\|)\s*([\s\S]+?))?\s*$/;
const INLINE_DEFAULT_RE = /(?:\?\?|\|\|)\s*(["'`][^"'`]*["'`])\s*$/;

function classify(f: FileInfo, expr: string, depth = 0): Cls {
  const lit = jsStringValue(expr);
  if (lit !== null) return { kind: 'literal', value: lit };
  // `{p ?? <fallback>}` — the connect form: p overrides, the rest is the default.
  const ov = /^\s*([A-Za-z_$][\w$]*)\s*\?\?\s*([\s\S]+?)\s*$/.exec(expr);
  const ovEntry = ov && f.props?.entries.find((e) => e.alias === ov[1]);
  if (ov && ovEntry) return { kind: 'prop', key: ovEntry.key, defaultText: ovEntry.defaultText ?? ov[2], exact: true };
  // `post.data.title` (+ `?? default`) — a field of a content entry the file receives.
  const dm = DATA_RE.exec(expr);
  const dmEntry = dm && f.props?.entries.find((e) => e.alias === dm[1]);
  if (dm && dmEntry) return { kind: 'prop', key: dmEntry.key, dataKey: dm[2], defaultText: dm[3], exact: false };
  // `d.title` / `d?.title` / `pick('title', …)` over a data alias — one key read, nothing else of the props.
  if (f.dataAliases.size) {
    const reads = new Set<string>();
    let prop = '';
    for (const [alias, key] of f.dataAliases) {
      for (const m of expr.matchAll(new RegExp(`\\b${alias}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)`, 'g'))) { reads.add(m[1]); prop = key; }
    }
    for (const picker of f.dataPickers) {
      for (const m of expr.matchAll(new RegExp(`\\b${picker}\\s*\\(\\s*['"]([^'"]+)['"]`, 'g'))) { reads.add(m[1]); prop = f.dataAliases.values().next().value!; }
    }
    const others = referencedIdents(expr).some((id) => !f.dataAliases.has(id.name) && !f.dataPickers.has(id.name) && (f.props?.entries.some((e) => e.alias === id.name) || f.consts.has(id.name)));
    if (reads.size === 1 && !others) return { kind: 'prop', key: prop, dataKey: [...reads][0], exact: false };
  }
  // Every identifier resolves to a prop (through consts, up to 3 deep) or is ignored (literals, globals).
  const found = new Map<string, { key: string; dataKey?: string; defaultText?: string }>();
  const add = (x: { key: string; dataKey?: string; defaultText?: string }) => found.set(`${x.key}|${x.dataKey ?? ''}`, x);
  let opaque = false;
  for (const id of referencedIdents(expr)) {
    if (id.astroProp) { add({ key: id.astroProp }); continue; }
    const entry = f.props?.entries.find((e) => e.alias === id.name);
    if (entry) { add({ key: entry.key, defaultText: entry.defaultText }); continue; }
    const c = f.consts.get(id.name);
    if (!c || f.dataAliases.has(id.name) || f.dataPickers.has(id.name)) continue;
    if (depth >= 3) { opaque = true; continue; }
    const inner = classify(f, f.src.slice(c.start, c.end), depth + 1);
    if (inner.kind === 'literal' && expr.trim() === id.name && depth === 0) {
      const lead = f.src.slice(c.start, c.end).length - f.src.slice(c.start, c.end).trimStart().length;
      const text = f.src.slice(c.start, c.end).trim();
      return { ...inner, span: { start: c.start + lead, end: c.start + lead + text.length } };
    }
    if (inner.kind === 'literal') continue;
    if (inner.kind === 'prop') { add({ key: inner.key, dataKey: inner.dataKey, defaultText: inner.defaultText }); continue; }
    opaque = true;
  }
  if (found.size !== 1 || opaque) return { kind: 'computed' };
  const [{ key, dataKey, defaultText }] = [...found.values()];
  const t = expr.trim();
  const exact = !dataKey && (/^[A-Za-z_$][\w$]*$/.test(t) || /^Astro\.props\.[A-Za-z_$][\w$]*$/.test(t));
  return { kind: 'prop', key, dataKey, defaultText: defaultText ?? INLINE_DEFAULT_RE.exec(t)?.[1], exact };
}

/** A tag's value as an expression or literal. */
type Raw = { kind: 'literal'; value: string } | { kind: 'expr'; text: string } | { kind: 'none' };

function rawValue(f: FileInfo, t: Tag, spec: FieldSpec): Raw {
  if (!spec.attr) {
    if (!t.close) return { kind: 'literal', value: '' };
    const body = f.src.slice(t.openEnd, t.close.start);
    const trimmed = body.trim();
    if (!trimmed.includes('{')) return { kind: 'literal', value: decodeEntities(trimmed).replace(/\s+/g, ' ') };
    if (trimmed.startsWith('{') && skipJs(trimmed, 0) === trimmed.length) return { kind: 'expr', text: trimmed.slice(1, -1) };
    // text + expressions: read as one template
    const tpl = trimmed.replace(/\{([^{}]*)\}/g, (_, e: string) => '${' + e + '}');
    return { kind: 'expr', text: '`' + tpl.replace(/`/g, '\\`') + '`' };
  }
  const a = attrOf(t, spec.attr);
  if (!a) return { kind: 'none' };
  if (a.kind === 'quoted') return { kind: 'literal', value: isComponent(t) ? a.value : decodeEntities(a.value) };
  if (a.kind === 'expression') return { kind: 'expr', text: a.value };
  if (a.kind === 'template') return { kind: 'expr', text: '`' + a.value + '`' };
  return { kind: 'none' };
}

/** Where a field's value comes from. */
type Home =
  | { kind: 'missing' }
  /** A literal in the page file itself (head tag, or a frontmatter const it reads). */
  | { kind: 'page'; match: Match; value: string; constSpan?: Span }
  /** A prop chain that ends at an attribute of a tag in the page (its layout or head component). */
  | { kind: 'pageAttr'; tag: Tag; key: string; attr?: Attr; defaultText?: string; bool: boolean }
  /** The value is a field of the route's content entry (a blog post's frontmatter). */
  | { kind: 'postField'; key: string; defaultText?: string }
  /** Set in a layout / head component (literal, computed, or a prop nobody passes): connect there. */
  | { kind: 'connect'; match: Match; at: 'value' | 'thread'; threadKey?: string; threadOld?: string }
  | { kind: 'readonly'; file: string; line: number; reason: string };

interface Match { f: FileInfo; tag: Tag }

function findMatches(chain: Chain, spec: FieldSpec | ((t: Tag) => boolean)): Match[] {
  const test = typeof spec === 'function' ? spec : spec.match;
  if (!chain.head) return [];
  const { info: hf, tag: hi } = chain.head;
  const h = hf.tags[hi];
  const out: Match[] = [];
  for (let i = hi + 1; i < hf.tags.length; i++) {
    const t = hf.tags[i];
    if (t.start >= (h.close?.start ?? h.openEnd)) break;
    const hop = chain.hops.get(i);
    if (hop) hop.tags.forEach((ht) => { if (test(ht)) out.push({ f: hop, tag: ht }); });
    else if (test(t)) out.push({ f: hf, tag: t });
  }
  return out;
}

/** The file that renders `f` and the tag it renders it with. */
function parentOf(chain: Chain, f: FileInfo): { f: FileInfo; tag: Tag } | null {
  if (chain.head) for (const [i, hop] of chain.hops) if (hop === f) return { f: chain.head.info, tag: chain.head.info.tags[i] };
  const li = chain.layouts.findIndex((l) => l.info === f);
  if (li < 0) return null;
  const parent = li === 0 ? chain.page : chain.layouts[li - 1].info;
  return { f: parent, tag: parent.tags[chain.layouts[li].tagInParent] };
}

/** A dynamic route (`[slug].astro`) gets its entry as a prop: SEO is per post. */
export const isEntryRoute = (file: string) => /\[[^\]]+\]/.test(file);
const isEntryProp = (chain: Chain, key: string) => isEntryRoute(chain.page.file) && !!chain.page.props?.entries.some((e) => e.key === key);

function homeOf(chain: Chain, field: PageSeoField): Home {
  const spec = SPECS[field];
  const [m] = findMatches(chain, spec);
  if (!m) return { kind: 'missing' };
  const page = chain.page;
  const readonly = (f: FileInfo, at: number, reason: string): Home => ({ kind: 'readonly', file: f.file, line: lineOf(f.src, at), reason });

  // noindex behind a guard: `{noindex && <meta name="robots" …/>}` → the guard's prop.
  let cls: Cls;
  let viaGuard = false;
  if (spec.bool && m.tag.expr) {
    cls = classify(m.f, m.f.src.slice(m.tag.expr.start + 1, m.tag.start).replace(/&&\s*$/, ''));
    viaGuard = true;
  } else {
    const raw = rawValue(m.f, m.tag, spec);
    cls = raw.kind === 'expr' ? classify(m.f, raw.text) : { kind: 'literal', value: raw.kind === 'literal' ? raw.value : '' };
  }
  if (m.f === page) {
    if (cls.kind === 'literal') return { kind: 'page', match: m, value: cls.value, constSpan: cls.span };
    if (cls.kind === 'prop' && cls.dataKey && isEntryProp(chain, cls.key)) return { kind: 'postField', key: cls.dataKey, defaultText: cls.defaultText };
    return readonly(m.f, m.tag.start, 'set by code in the page');
  }
  // Walk the prop chain up toward the page.
  let f = m.f;
  let at: Match = m;
  for (let hop = 0; hop < 8; hop++) {
    if (cls.kind !== 'prop') return { kind: 'connect', match: at, at: 'value' };
    const parent = parentOf(chain, f);
    if (!parent) return readonly(f, at.tag.start, `set by code in ${f.file}`);
    const key = cls.key;
    const attr = attrOf(parent.tag, key) ?? parent.tag.attrs.find((a) => a.kind === 'shorthand' && a.name === key);
    const spread = !attr && parent.tag.attrs.some((a) => a.kind === 'spread' && /^\s*\.\.\.\s*Astro\.props\s*$/.test(a.value));
    const parentMatch: Match = { f: parent.f, tag: parent.tag };
    if (parent.f === page) {
      const bool = !!spec.bool && (viaGuard || !cls.exact);
      if (!attr) return { kind: 'pageAttr', tag: parent.tag, key, defaultText: cls.defaultText, bool };
      if (attr.kind === 'quoted' || attr.kind === 'empty' || jsStringValue(attr.value) !== null || /^\s*(true|false)\s*$/.test(attr.value)) {
        return { kind: 'pageAttr', tag: parent.tag, key, attr, defaultText: cls.defaultText, bool };
      }
      const inner = classify(page, attr.kind === 'shorthand' ? attr.name : attr.value);
      const dataKey = inner.kind === 'prop' ? inner.dataKey ?? (inner.exact ? cls.dataKey : undefined) : undefined;
      if (inner.kind === 'prop' && dataKey && isEntryProp(chain, inner.key)) return { kind: 'postField', key: dataKey, defaultText: inner.defaultText ?? cls.defaultText };
      return readonly(page, parent.tag.start, 'set by code in the page');
    }
    if (spread) {
      const pk = parent.f.props?.entries.find((e) => e.key === key);
      cls = { ...cls, defaultText: pk?.defaultText ?? cls.defaultText };
      f = parent.f; at = parentMatch;
      continue;
    }
    if (!attr) return { kind: 'connect', match: parentMatch, at: 'thread', threadKey: key };
    const inner: Cls = attr.kind === 'quoted' ? { kind: 'literal', value: attr.value }
      : attr.kind === 'shorthand' ? classify(parent.f, attr.name)
      : attr.kind === 'expression' ? classify(parent.f, attr.value) : { kind: 'computed' };
    if (inner.kind !== 'prop') {
      return { kind: 'connect', match: parentMatch, at: 'thread', threadKey: key, threadOld: attrExpr(attr) };
    }
    cls = { ...inner, defaultText: inner.defaultText ?? cls.defaultText, dataKey: inner.dataKey ?? (inner.exact ? cls.dataKey : undefined) };
    f = parent.f;
    at = parentMatch;
  }
  return readonly(m.f, m.tag.start, 'too deep to follow');
}

// ── read ────────────────────────────────────────────────────────────────────

export interface SeoFieldState {
  value: string | boolean;
  /** What shows when `value` is empty (the layout's default, or the fallback field). */
  placeholder?: string;
  editable: boolean;
  /** Where a read-only value is set. */
  setIn?: { file: string; line: number; reason: string };
  /** A second tag for this field renders too (duplicates confuse search engines). */
  duplicateIn?: string;
  /** The value lives in the post's own field (dynamic routes). */
  postKey?: string;
}

export interface PageSeoState {
  fields: Record<PageSeoField, SeoFieldState>;
  /** The file holding the page's `<head>` (null = none yet; the first edit adds one). */
  headFile: string | null;
  layoutFile: string | null;
  /** A dynamic route: values are per post (the open post's frontmatter). */
  post: { file: string } | null;
  problem?: string;
}

function literalDefault(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return jsStringValue(text) ?? undefined;
}

/** The post a dynamic route shows right now (its markdown file), when the editor knows it. */
export interface PostRef { file: string; collection: string }

/** Frontmatter key a field is written to on a post when the route does not read one yet. */
const POST_KEYS: Record<PageSeoField, string> = {
  title: 'title', description: 'description', image: 'ogImage', imageAlt: 'ogImageAlt',
  noindex: 'noindex', canonical: 'canonical', shareTitle: 'ogTitle', shareDescription: 'ogDescription',
};

export function readPageSeo(sources: Record<string, string | null | undefined>, pageFile: string, post?: PostRef | null): PageSeoState {
  const r = buildChain(sources, pageFile);
  const blank = (problem: string): PageSeoState => ({
    fields: Object.fromEntries(PAGE_SEO_FIELDS.map((k) => [k, { value: SPECS[k].bool ? false : '', editable: false }])) as PageSeoState['fields'],
    headFile: null, layoutFile: null, post: null, problem,
  });
  if ('need' in r) return blank(`Can't read ${r.need}`);
  if ('problem' in r) return blank(r.problem);
  const { chain } = r;
  const postMode = !!post && isEntryRoute(pageFile);
  const postSrc = post ? sources[post.file] : null;
  const fm = postSrc ? readFrontmatter(postSrc) : null;
  const headProblem = chain.head && !chain.head.info.tags[chain.head.tag].close ? `The <head> in ${chain.head.info.file} is not closed` : undefined;
  const fields = {} as PageSeoState['fields'];
  for (const field of PAGE_SEO_FIELDS) {
    const spec = SPECS[field];
    const home = homeOf(chain, field);
    const all = findMatches(chain, spec);
    const st: SeoFieldState = { value: spec.bool ? false : '', editable: !headProblem };
    if (all.length > 1) st.duplicateIn = all[1].f.file;
    const fmValue = (key: string) => { const v = fm?.[key]; st.postKey = key; return v; };
    switch (home.kind) {
      case 'missing':
        if (postMode) { const v = fmValue(POST_KEYS[field]); st.value = spec.bool ? v === true : typeof v === 'string' ? v : ''; }
        break;
      case 'postField': {
        if (!postMode) { st.editable = false; st.setIn = { file: pageFile, line: 1, reason: 'each post\'s own — open a post' }; break; }
        const v = fmValue(home.key);
        if (spec.bool) st.value = v === true || (typeof v === 'string' && /noindex|true/i.test(v));
        else { st.value = typeof v === 'string' ? v : ''; st.placeholder = literalDefault(home.defaultText); }
        break;
      }
      case 'page':
        st.value = spec.bool ? /noindex/i.test(home.value) : home.value;
        if (postMode) { const v = fmValue(POST_KEYS[field]); if (!spec.bool) { st.placeholder = home.value; st.value = typeof v === 'string' ? v : ''; } else st.value = v === true || st.value; }
        break;
      case 'pageAttr': {
        const a = home.attr;
        const v = !a ? undefined : a.kind === 'empty' ? true : a.kind === 'quoted' ? a.value : (jsStringValue(a.value) ?? a.value.trim());
        if (!spec.bool) { st.value = typeof v === 'string' ? v : ''; st.placeholder = literalDefault(home.defaultText); }
        // A guard/ternary prop is truthy unless absent or `{false}`; a string prop carries the robots text.
        else if (home.bool) st.value = v !== undefined && v !== 'false';
        else st.value = /noindex/i.test(typeof v === 'string' ? v : literalDefault(home.defaultText) ?? '');
        if (postMode) {
          const pv = fmValue(POST_KEYS[field]);
          if (!spec.bool) { st.placeholder = (st.value as string) || st.placeholder; st.value = typeof pv === 'string' ? pv : ''; } else st.value = pv === true || st.value;
        }
        break;
      }
      case 'connect': {
        const raw = home.at === 'value' ? rawValue(home.match.f, home.match.tag, spec) : { kind: 'none' as const };
        if (spec.bool) st.value = raw.kind === 'literal' && /noindex/i.test(raw.value);
        else st.placeholder = raw.kind === 'literal' ? raw.value : undefined;
        if (postMode) { const pv = fmValue(POST_KEYS[field]); if (spec.bool) st.value = pv === true || st.value; else st.value = typeof pv === 'string' ? pv : ''; }
        break;
      }
      case 'readonly':
        st.editable = false;
        st.setIn = { file: home.file, line: home.line, reason: home.reason };
        break;
    }
    fields[field] = st;
  }
  // A share field that follows its fallback (same home, or no tag) shows the fallback as its placeholder.
  for (const field of PAGE_SEO_FIELDS) {
    const fb = SPECS[field].fallback;
    if (!fb) continue;
    const st = fields[field];
    if (followsFallback(chain, field)) { st.value = postMode ? st.value : ''; st.placeholder = (fields[fb].value as string) || fields[fb].placeholder; }
    else if (!st.value && !st.placeholder) st.placeholder = (fields[fb].value as string) || fields[fb].placeholder;
  }
  const headFile = chain.head?.info.file ?? null;
  return { fields, headFile, layoutFile: chain.layouts[0]?.info.file ?? null, post: postMode && post ? { file: post.file } : null, problem: headProblem };
}

/** A share field rendered from the same source as its fallback field (og:title={title}). */
function followsFallback(chain: Chain, field: PageSeoField): boolean {
  const fb = SPECS[field].fallback;
  if (!fb) return false;
  const a = homeOf(chain, field), b = homeOf(chain, fb);
  return (a.kind === 'pageAttr' && b.kind === 'pageAttr' && a.key === b.key) || (a.kind === 'postField' && b.kind === 'postField' && a.key === b.key);
}

// ── frontmatter (post fields) ───────────────────────────────────────────────

const FM_RE = /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;

/** A post's frontmatter scalars (strings, booleans; numbers as text) — the shared YAML reader the post editor uses. */
export function readFrontmatter(src: string): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(parseFrontmatter(src).frontmatter)) {
    if (typeof v === 'string' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number') out[k] = String(v);
  }
  return out;
}

/** Set (or remove, `null`) one top-level frontmatter key; other lines are kept byte for byte. */
function setFrontmatterKey(src: string, key: string, value: string | boolean | null): string {
  const text = value === null ? null : typeof value === 'boolean' ? `${key}: ${value}` : `${key}: ${JSON.stringify(value)}`;
  const m = FM_RE.exec(src);
  if (!m) return text === null ? src : `---\n${text}\n---\n${src}`;
  const lines = m[2].split('\n');
  const at = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (at >= 0) {
    let end = at + 1;
    while (end < lines.length && /^(\s+\S|\s*$)/.test(lines[end]) && lines[end].trim() !== '') end++; // a multi-line value
    lines.splice(at, end - at, ...(text === null ? [] : [text]));
  } else if (text !== null) lines.push(text);
  return src.slice(0, m.index) + m[1] + lines.join('\n') + m[3] + src.slice(m.index + m[0].length);
}

// ── edit ────────────────────────────────────────────────────────────────────

/** Insert `text` as the last child of `tag` (before its close), matching indentation. */
function appendChild(f: FileInfo, tag: Tag, text: string): Splice {
  const close = tag.close!;
  let q = close.start;
  while (q > tag.openEnd && /\s/.test(f.src[q - 1])) q--;
  const lineStart = f.src.lastIndexOf('\n', close.start - 1) + 1;
  const closeIndent = /^[ \t]*/.exec(f.src.slice(lineStart))![0];
  const self = f.tags.indexOf(tag);
  const lastChild = f.tags.filter((t) => t.parent === self).pop();
  let indent = closeIndent + (closeIndent.includes('\t') ? '\t' : '  ');
  if (lastChild) {
    const at = lastChild.expr?.start ?? lastChild.start;
    const ls = f.src.lastIndexOf('\n', at - 1) + 1;
    if (f.src.slice(ls, at).trim() === '') indent = f.src.slice(ls, at);
  }
  const sameLine = !f.src.slice(tag.openEnd, close.start).includes('\n');
  return sameLine ? { start: q, end: q, text } : { start: q, end: q, text: `\n${indent}${text}` };
}

/** Remove a tag (and the guard holding it), plus its line when it stands alone. */
function removeTag(f: FileInfo, t: Tag): Splice {
  let start = t.expr?.start ?? t.start;
  let end = t.expr?.end ?? tagEnd(t);
  const ls = f.src.lastIndexOf('\n', start - 1) + 1;
  const le = f.src.indexOf('\n', end);
  const lineEnd = le < 0 ? f.src.length : le;
  if (f.src.slice(ls, start).trim() === '' && f.src.slice(end, lineEnd).trim() === '') { start = ls > 0 ? ls - 1 : ls; end = lineEnd; }
  return { start, end, text: '' };
}

/** Set/replace/remove one attribute on a tag. `null` removes it. */
function setAttr(f: FileInfo, t: Tag, key: string, text: string | null): Splice {
  const a = attrOf(t, key) ?? t.attrs.find((x) => x.kind === 'shorthand' && x.name === key);
  if (a) {
    if (text === null) return removeAttr(f.src, a);
    return { start: a.start, end: a.end, text };
  }
  if (text === null) return { start: t.start, end: t.start, text: '' };
  const after = t.attrs.length ? t.attrs[t.attrs.length - 1].end : t.start + 1 + t.name.length;
  return { start: after, end: after, text: ` ${text}` };
}

/** Teach a layout a prop: destructure (+ default) and the Props interface. */
function addProp(f: FileInfo, key: string, bool: boolean, defaultText?: string): Splice[] {
  const entry = defaultText !== undefined ? `${key} = ${defaultText}` : key;
  const out: Splice[] = [];
  if (f.props) {
    let q = f.props.inner.end;
    while (q > f.props.inner.start && /\s/.test(f.src[q - 1])) q--;
    const multiline = f.src.slice(f.props.inner.start, f.props.inner.end).includes('\n');
    const lastComma = f.src[q - 1] === ',';
    const indent = multiline ? (/\n([ \t]*)\S[^\n]*$/.exec(f.src.slice(f.props.inner.start, q))?.[1] ?? '  ') : '';
    const sep = lastComma ? (multiline ? `\n${indent}` : ' ') : (multiline ? `,\n${indent}` : ', ');
    out.push({ start: q, end: q, text: q === f.props.inner.start ? ` ${entry} ` : `${sep}${entry}${multiline && lastComma ? ',' : ''}` });
  } else if (f.fm) {
    const end = f.fm.codeStart + f.fm.code.length;
    out.push({ start: end, end, text: `${f.fm.code.trim() ? '\n' : ''}const { ${entry} } = Astro.props;` });
  } else {
    out.push({ start: 0, end: 0, text: `---\nconst { ${entry} } = Astro.props;\n---\n` });
  }
  if (f.fm) {
    const im = /\b(?:interface\s+Props\s*(?:extends[^{]*)?|type\s+Props\s*=\s*)\{/.exec(f.fm.code);
    if (im) {
      const open = f.fm.codeStart + im.index + im[0].length - 1;
      const close = skipJs(f.src, open) - 1;
      let q = close;
      while (q > open + 1 && /\s/.test(f.src[q - 1])) q--;
      const body = f.src.slice(open + 1, close);
      const indent = /\n([ \t]+)\S/.exec(body)?.[1] ?? '\t';
      const line = `${key}?: ${bool ? 'boolean' : 'string'};`;
      out.push(body.includes('\n')
        ? { start: q, end: q, text: `${/[;,]$/.test(f.src.slice(open + 1, q).trim()) || q === open + 1 ? '' : ';'}\n${indent}${line}` }
        : { start: q, end: q, text: `${q === open + 1 ? ' ' : (/[;,]$/.test(f.src.slice(open + 1, q).trim()) ? ' ' : '; ')}${line} ` });
    }
  }
  return out;
}

/** A prop name the layout does not use yet. */
function freshProp(f: FileInfo, base: string): string {
  const taken = (n: string) => !!f.props?.entries.some((e) => e.key === n || e.alias === n) || f.consts.has(n)
    || new RegExp(`\\b(?:import|function|class|let|var|const)\\b[^;\\n]*\\b${n}\\b`).test(f.fm?.code ?? '');
  if (!taken(base)) return base;
  const seo = `seo${base[0].toUpperCase()}${base.slice(1)}`;
  for (let i = 0; ; i++) { const n = i ? `${seo}${i + 1}` : seo; if (!taken(n)) return n; }
}

/** The expression text of a tag's current value (for `{p ?? <old>}`). */
function valueExprText(f: FileInfo, t: Tag, spec: FieldSpec): string {
  const raw = rawValue(f, t, spec);
  if (raw.kind === 'literal') return jsString(raw.value);
  if (raw.kind === 'expr') return /^[\w$.]+$/.test(raw.text.trim()) ? raw.text.trim() : `(${raw.text.trim()})`;
  return 'undefined';
}

/** Rewrite a tag's value to `newExpr` (text content or the spec attribute). */
function setValueExpr(f: FileInfo, t: Tag, spec: FieldSpec, newExpr: string): Splice {
  if (!spec.attr) return { start: t.openEnd, end: t.close!.start, text: `{${newExpr}}` };
  return setAttr(f, t, spec.attr, `${spec.attr}={${newExpr}}`);
}

export class SeoEditError extends Error {}

/**
 * The new bytes of every file an edit touches (unchanged files omitted).
 * `value` '' / false clears the page's own value (a layout default then shows).
 * On a dynamic route (`[slug].astro`) the value is the open post's: it is
 * written to `post`'s frontmatter, and the route learns to read it when needed.
 */
export function editPageSeo(
  sources: Record<string, string | null | undefined>, pageFile: string, field: PageSeoField, input: string | boolean, post?: PostRef | null,
): Record<string, string> {
  const chain = chainOf(sources, pageFile);
  const spec = SPECS[field];
  const value = typeof input === 'boolean' ? input : normalizeSeoValue(field, input);
  const clear = value === false || value === '';
  if (field === 'canonical' && !clear && !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(value as string)) throw new SeoEditError('Canonical URL must start with https://');
  const page = chain.page;
  const postSrc = post ? sources[post.file] : undefined;
  const postMode = !!post && isEntryRoute(pageFile);
  if (postMode && typeof postSrc !== 'string') throw new SeoEditError(`Can't read ${post!.file}`);
  const edits = new Map<FileInfo, Splice[]>();
  const out: Record<string, string> = {};
  const push = (f: FileInfo, ...s: Splice[]) => edits.set(f, [...(edits.get(f) ?? []), ...s]);
  /** The page's own value for prop `key`: a literal attr, or (post mode) the post's field. */
  const entry = postMode ? entryExpr(chain) : '';
  const writePost = (key: string) => {
    out[post!.file] = setFrontmatterKey(postSrc as string, key, clear ? null : value);
  };
  const pageValue = (key: string, bool: boolean, fmKey: string): string | null => {
    if (postMode) { writePost(fmKey); return `${key}={${entry}.${fmKey}}`; }
    return clear ? null : bool ? key : propAttr(key, value as string);
  };
  /** Make `f` receive prop `key` from the page, adding props/attrs on every file between. */
  const feed = (f: FileInfo, key: string, bool: boolean, fmKey: string): void => {
    const parent = parentOf(chain, f);
    if (!parent) throw new SeoEditError(`Can't find what renders ${f.file}`);
    if (parent.f === page) { push(page, setAttr(page, parent.tag, key, pageValue(key, bool, fmKey))); return; }
    const existing = attrOf(parent.tag, key);
    const pk = freshProp(parent.f, key);
    const old = existing ? attrExpr(existing) : null;
    push(parent.f, setAttr(parent.f, parent.tag, key, `${key}={${old ? `${pk} ?? ${old}` : pk}}`), ...addProp(parent.f, pk, bool));
    feed(parent.f, pk, bool, fmKey);
  };
  /** Connect at `m` (a tag in a layout or head component): `{p ?? old}`, then feed p. */
  const connectValue = (m: Match, fmKey: string) => {
    const p = freshProp(m.f, spec.prop);
    const old = valueExprText(m.f, m.tag, spec);
    const next = spec.bool ? `${p} ? "noindex, nofollow" : ${old}` : `${p} ?? ${old}`;
    push(m.f, setValueExpr(m.f, m.tag, spec, next), ...addProp(m.f, p, !!spec.bool));
    feed(m.f, p, !!spec.bool, fmKey);
  };

  // A share field following its fallback's value splits off on its first own value.
  if (followsFallback(chain, field) && !clear && !postMode) {
    const [m] = findMatches(chain, spec);
    connectValue(m, POST_KEYS[field]);
    return render();
  }

  const home = homeOf(chain, field);
  const fmKey = home.kind === 'postField' ? home.key : POST_KEYS[field];
  switch (home.kind) {
    case 'readonly':
      throw new SeoEditError(`${fieldLabel(field)} is ${home.reason} (${home.file}:${home.line})`);
    case 'postField':
      if (!postMode) throw new SeoEditError('Open a post to edit its SEO — this value is each post\'s own');
      writePost(home.key);
      break;
    case 'page': {
      const { tag } = home.match;
      if (postMode) {
        // A literal in a route shared by every post: the post's own field overrides it.
        if (!/(data|frontmatter)\.\w+/.test(page.src.slice(tag.start, tagEnd(tag)))) push(page, setValueExpr(page, tag, spec, spec.bool ? `${entry}.${fmKey} ? "noindex, nofollow" : ${valueExprText(page, tag, spec)}` : `${entry}.${fmKey} ?? ${valueExprText(page, tag, spec)}`));
        writePost(fmKey);
        break;
      }
      if (home.constSpan && !spec.bool) push(page, { ...home.constSpan, text: jsString(clear ? '' : value as string) });
      else if (clear) push(page, field === 'title' ? { start: tag.openEnd, end: tag.close!.start, text: '' } : removeTag(page, tag));
      else if (spec.bool) push(page, setAttr(page, tag, 'content', 'content="noindex, nofollow"'));
      else if (!spec.attr) push(page, { start: tag.openEnd, end: tag.close!.start, text: titleText(value as string) });
      else push(page, setAttr(page, tag, spec.attr, `${spec.attr}=${htmlAttr(value as string)}`));
      break;
    }
    case 'pageAttr': {
      if (postMode) {
        const old = home.attr ? attrExpr(home.attr) : null;
        push(page, setAttr(page, home.tag, home.key, `${home.key}={${entry}.${fmKey}${old ? ` ?? ${old}` : ''}}`));
        writePost(fmKey);
      } else if (spec.bool && !home.bool) push(page, setAttr(page, home.tag, home.key, clear ? null : `${home.key}="noindex, nofollow"`));
      else push(page, setAttr(page, home.tag, home.key, pageValue(home.key, !!spec.bool, fmKey)));
      break;
    }
    case 'connect': {
      if (clear && !postMode) break; // nothing of the page's own to clear: the layout's value stays
      if (home.at === 'thread') {
        const f = home.match.f;
        const p = freshProp(f, spec.prop);
        push(f, setAttr(f, home.match.tag, home.threadKey!, `${home.threadKey}={${home.threadOld ? `${p} ?? ${home.threadOld}` : p}}`), ...addProp(f, p, !!spec.bool));
        feed(f, p, !!spec.bool, fmKey);
      } else connectValue(home.match, fmKey);
      break;
    }
    case 'missing': {
      if (clear && !postMode) break;
      const headF = chain.head?.info;
      if (!headF) {
        if (postMode) throw new SeoEditError(`${page.file} renders no <head>`);
        push(page, ...wrapDocument(page, spec.literal(value as string), documentLang(sources)));
        break;
      }
      const headTag = headF.tags[chain.head!.tag];
      const needsCard = field === 'image' && !findMatches(chain, TWITTER_CARD).length;
      if (headF === page) {
        if (postMode) {
          const ex = `${entry}.${fmKey}`;
          push(page, appendChild(page, headTag, spec.guarded(ex)));
          if (needsCard) push(page, appendChild(page, headTag, `{${ex} && <meta name="twitter:card" content="summary_large_image" />}`));
          writePost(fmKey);
          break;
        }
        push(page, appendChild(page, headTag, spec.literal(value as string)));
        if (needsCard) push(page, appendChild(page, headTag, '<meta name="twitter:card" content="summary_large_image" />'));
        break;
      }
      const p = freshProp(headF, spec.prop);
      push(headF, appendChild(headF, headTag, spec.guarded(p)), ...addProp(headF, p, !!spec.bool));
      if (needsCard) push(headF, appendChild(headF, headTag, `{${p} && <meta name="twitter:card" content="summary_large_image" />}`));
      feed(headF, p, !!spec.bool, fmKey);
      break;
    }
  }
  return render();

  function render(): Record<string, string> {
    for (const [f, s] of edits) { const next = applySplices(f.src, s); if (next !== f.src) out[f.file] = next; }
    if (post && out[post.file] === postSrc) delete out[post.file];
    return out;
  }
}

/** How a dynamic route reaches its entry's fields: `post.data` (content collections) or `post.frontmatter` (Astro.glob). */
function entryExpr(chain: Chain): string {
  const page = chain.page;
  const entries = page.props?.entries ?? [];
  const reads = (base: string, acc: string) => new RegExp(`\\b${base.replace(/[.$]/g, '\\$&')}\\s*\\??\\.\\s*${acc}\\b`).test(page.src);
  const used = entries.find((e) => reads(e.alias, 'data') || reads(e.alias, 'frontmatter') || page.tags.some((t) => t.attrs.some((a) => a.value.trim() === e.alias)));
  const direct = /Astro\.props\.([A-Za-z_$][\w$]*)/.exec(page.src)?.[1];
  const base = (used ?? (entries.length === 1 ? entries[0] : undefined))?.alias ?? (direct ? `Astro.props.${direct}` : null);
  if (!base) throw new SeoEditError(`Can't find the post in ${page.file}`);
  return reads(base, 'frontmatter') && !reads(base, 'data') ? `${base}.frontmatter` : `${base}.data`;
}

/** The language already used on a page in this project, otherwise Czech. */
function documentLang(sources: Record<string, string | null | undefined>): string {
  for (const text of Object.values(sources)) {
    const match = text?.match(/<html\b[^>]*\blang=["']([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)["']/i);
    if (match) return match[1];
  }
  return 'cs';
}

/** A page with no head and no layout becomes the scaffold document shape. */
function wrapDocument(page: FileInfo, tag: string, lang: string): Splice[] {
  const start = page.fm?.templateStart ?? 0;
  const body = page.src.slice(start).replace(/^\s*\n/, '').replace(/\s+$/, '');
  return [{
    start, end: page.src.length,
    text: `<html lang="${lang}">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    ${tag}\n  </head>\n  <body>\n${body}\n  </body>\n</html>\n`,
  }];
}

function fieldLabel(field: PageSeoField): string {
  return ({ title: 'Title', description: 'Description', image: 'Share image', imageAlt: 'Image description', noindex: 'Hide from search engines', canonical: 'Canonical URL', shareTitle: 'Share title', shareDescription: 'Share description' } as const)[field];
}

// ── site-wide head tags (favicon, language, site name, X handle) ────────────
// Owner D2: written into EVERY head of the project (each page's own <head>,
// each layout's, and head components one hop in) as one batch.

export type SiteHeadField = 'favicon' | 'lang' | 'siteName' | 'xHandle';
const SITE_HEAD_FIELDS: SiteHeadField[] = ['favicon', 'lang', 'siteName', 'xHandle'];

const SITE_SPECS: Record<Exclude<SiteHeadField, 'lang'>, { match: (t: Tag) => boolean; attr: string; literal: (v: string) => string }> = {
  favicon: {
    match: (t) => t.name === 'link' && /(^|\s)icon(\s|$)/i.test(attrOf(t, 'rel')?.value ?? '') && !/apple/i.test(attrOf(t, 'rel')?.value ?? ''),
    attr: 'href', literal: (v) => `<link rel="icon" href=${htmlAttr(v)}${iconType(v) ? ` type="${iconType(v)}"` : ''} />`,
  },
  siteName: { match: metaIs('property', 'og:site_name'), attr: 'content', literal: (v) => `<meta property="og:site_name" content=${htmlAttr(v)} />` },
  xHandle: { match: metaIs('name', 'twitter:site'), attr: 'content', literal: (v) => `<meta name="twitter:site" content=${htmlAttr(v)} />` },
};

function iconType(v: string): string | null {
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(v)?.[1]?.toLowerCase();
  return ({ png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as Record<string, string>)[ext ?? ''] ?? null;
}

interface HeadUnit { f: FileInfo; head: number; hops: FileInfo[] }

/** Every distinct head the given pages render (page heads and layout heads), with their head components. */
function headUnits(sources: Record<string, string | null | undefined>, pageFiles: string[]): HeadUnit[] {
  const byFile = new Map<string, HeadUnit>();
  for (const pf of pageFiles) {
    const r = buildChain(sources, pf);
    if (!('chain' in r) || !r.chain.head) continue;
    const { info: f, tag } = r.chain.head;
    if (!byFile.has(f.file)) byFile.set(f.file, { f, head: tag, hops: [...r.chain.hops.values()] });
  }
  return [...byFile.values()];
}

function siteTagIn(u: HeadUnit, field: Exclude<SiteHeadField, 'lang'>): { f: FileInfo; tag: Tag } | null {
  const spec = SITE_SPECS[field];
  const h = u.f.tags[u.head];
  for (let i = u.head + 1; i < u.f.tags.length; i++) {
    const t = u.f.tags[i];
    if (t.start >= (h.close?.start ?? h.openEnd)) break;
    if (spec.match(t)) return { f: u.f, tag: t };
  }
  for (const hop of u.hops) { const t = hop.tags.find(spec.match); if (t) return { f: hop, tag: t }; }
  return null;
}

function htmlTagOf(u: HeadUnit): Tag | null {
  const p = u.f.tags[u.head].parent;
  return p >= 0 && u.f.tags[p].name === 'html' ? u.f.tags[p] : null;
}

export interface SiteHeadState { value: string; mixed: boolean; /** heads where the value is set by code (left alone) */ fixedIn: string[] }

export function readSiteHead(sources: Record<string, string | null | undefined>, pageFiles: string[]): Record<SiteHeadField, SiteHeadState> {
  const units = headUnits(sources, pageFiles);
  const out = {} as Record<SiteHeadField, SiteHeadState>;
  for (const field of SITE_HEAD_FIELDS) {
    const values: string[] = [];
    const fixedIn: string[] = [];
    for (const u of units) {
      let a: Attr | undefined;
      if (field === 'lang') a = htmlTagOf(u) ? attrOf(htmlTagOf(u)!, 'lang') : undefined;
      else { const hit = siteTagIn(u, field); a = hit ? attrOf(hit.tag, SITE_SPECS[field].attr) : undefined; }
      if (!a) { values.push(''); continue; }
      const lit = a.kind === 'quoted' ? decodeEntities(a.value) : jsStringValue(a.value);
      if (lit === null) fixedIn.push(u.f.file); else values.push(lit);
    }
    const set = [...new Set(values)];
    out[field] = { value: set.find((v) => v) ?? '', mixed: set.length > 1, fixedIn };
  }
  return out;
}

/** Set a site-wide tag in every head (literal or missing); values set by code are left alone. */
export function editSiteHead(sources: Record<string, string | null | undefined>, pageFiles: string[], field: SiteHeadField, input: string): Record<string, string> {
  const value = input.trim();
  if (field === 'lang' && value && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)) throw new SeoEditError('Language must be a code like en or pt-BR');
  const edits = new Map<FileInfo, Splice[]>();
  const push = (f: FileInfo, s: Splice) => edits.set(f, [...(edits.get(f) ?? []), s]);
  for (const u of headUnits(sources, pageFiles)) {
    if (field === 'lang') {
      const html = htmlTagOf(u);
      if (!html) continue;
      const a = attrOf(html, 'lang');
      if (a && a.kind !== 'quoted' && jsStringValue(a.value) === null) continue;
      if (value || a) push(u.f, setAttr(u.f, html, 'lang', value ? `lang="${value}"` : null));
      continue;
    }
    const spec = SITE_SPECS[field];
    const hit = siteTagIn(u, field);
    if (hit) {
      const a = attrOf(hit.tag, spec.attr);
      if (a && a.kind !== 'quoted' && jsStringValue(a.value) === null) continue; // set by code
      if (!value) { push(hit.f, removeTag(hit.f, hit.tag)); continue; }
      push(hit.f, setAttr(hit.f, hit.tag, spec.attr, `${spec.attr}=${htmlAttr(value)}`));
      if (field === 'favicon') { const ty = attrOf(hit.tag, 'type'); if (ty) push(hit.f, setAttr(hit.f, hit.tag, 'type', iconType(value) ? `type="${iconType(value)}"` : null)); }
    } else if (value) {
      const h = u.f.tags[u.head];
      if (h.close) push(u.f, appendChild(u.f, h, spec.literal(value)));
    }
  }
  const out: Record<string, string> = {};
  for (const [f, s] of edits) { const next = applySplices(f.src, s); if (next !== f.src) out[f.file] = next; }
  return out;
}

// ── structured data (JSON-LD) ───────────────────────────────────────────────
// One `<script type="application/ld+json">` in the PAGE file (Google reads it
// anywhere in the document): in the page's own <head>, else inside its layout
// tag. A post route gets one built from each post's fields instead.

const isJsonLd = (t: Tag) => t.name.toLowerCase() === 'script' && /ld\+json/i.test(attrOf(t, 'type')?.value ?? '');

export interface StructuredDataState { kind: 'page' | 'posts'; value: string; editable: boolean; problem?: string }

export function readStructuredData(sources: Record<string, string | null | undefined>, pageFile: string, posts = false): StructuredDataState {
  const r = buildChain(sources, pageFile);
  if (!('chain' in r)) return { kind: 'page', value: '', editable: false, problem: 'problem' in r ? r.problem : `Can't read ${r.need}` };
  const page = r.chain.page;
  const t = page.tags.find(isJsonLd);
  if (posts) return { kind: 'posts', value: t ? 'on' : '', editable: true };
  const body = t?.close ? page.src.slice(t.openEnd, t.close.start).trim() : '';
  return { kind: 'page', value: body, editable: !t || !attrOf(t, 'set:html') };
}

/** Pretty JSON-LD for a script body (`</` escaped so it can never close the tag). */
export function normalizeJsonLd(text: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e) { throw new SeoEditError(`Structured data is not valid JSON: ${e instanceof Error ? e.message : e}`); }
  if (!parsed || typeof parsed !== 'object') throw new SeoEditError('Structured data must be a JSON object or array');
  return JSON.stringify(parsed, null, 2).replace(/<\//g, '<\\/');
}

export function editStructuredData(sources: Record<string, string | null | undefined>, pageFile: string, input: string, posts = false): Record<string, string> {
  const chain = chainOf(sources, pageFile);
  const page = chain.page;
  const existing = page.tags.find(isJsonLd);
  const clear = input.trim() === '' || (posts && input !== 'on');
  let splice: Splice | null = null;
  if (clear) splice = existing ? removeTag(page, existing) : null;
  else {
    const entry = posts ? entryExpr(chain) : '';
    const tag = posts
      ? `<script type="application/ld+json" set:html={JSON.stringify({ '@context': 'https://schema.org', '@type': 'BlogPosting', headline: ${entry}.title, description: ${entry}.description, image: ${entry}.ogImage, datePublished: ${entry}.date ?? ${entry}.pubDate, dateModified: ${entry}.updatedDate ?? ${entry}.updated, author: ${entry}.author ? { '@type': 'Person', name: typeof ${entry}.author === 'string' ? ${entry}.author : ${entry}.author.name } : undefined })} />`
      : null;
    const json = posts ? '' : normalizeJsonLd(input);
    if (existing) {
      if (posts) return {};
      const indent = /\n([ \t]*)[^\n]*$/.exec(page.src.slice(0, existing.start))?.[1] ?? '';
      splice = { start: existing.openEnd, end: existing.close!.start, text: `\n${json.split('\n').map((l) => indent + '  ' + l).join('\n')}\n${indent}` };
    } else {
      const text = tag ?? `<script type="application/ld+json">\n${json}\n</script>`;
      const own = headTagOf(page);
      const w = wrapperOf(page);
      const host = own >= 0 ? page.tags[own] : w >= 0 && page.tags[w].close ? page.tags[w] : null;
      if (host) splice = appendChild(page, host, text);
      else { const end = page.src.replace(/\s+$/, '').length; splice = { start: end, end, text: `\n${text}` }; }
    }
  }
  if (!splice) return {};
  const next = applySplices(page.src, [splice]);
  return next === page.src ? {} : { [page.file]: next };
}
