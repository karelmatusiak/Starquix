// Pure + dependency-light: used by the on-open route upgrade (files-truth
// driver) and by ensurePostRoute.
import { detectPageLayout } from '@/utils/detectPageLayout';

const indent = (s: string, n: number) => s.split('\n').map((l) => `${' '.repeat(n)}${l}`).join('\n');

/**
 * The route shape this module wrote BEFORE PostLayout — kept only to
 * recognise an untouched one and upgrade it (edited routes are never touched).
 * The fingerprint stays lang="en": that is what those old files contain.
 * New post layouts come from postLayoutSource and use the project language.
 */
export function legacyPostRouteSource(collection: string, layout: { name: string; importPath: string } | null): string {
  const frontmatter = [
    "import { getCollection } from 'astro:content';",
    ...(layout ? [`import ${layout.name} from '${layout.importPath}';`] : []),
    'export async function getStaticPaths() {',
    `  const posts = await getCollection('${collection}');`,
    '  return posts.map((post) => ({ params: { slug: post.slug }, props: { post } }));',
    '}',
    'const { post } = Astro.props;',
    'const { Content } = await post.render();',
  ].join('\n');
  const article = '<article class="prose mx-auto p-8">\n  <h1>{post.data.title}</h1>\n  <Content />\n</article>';
  const body = layout
    ? `<${layout.name}>\n${indent(article, 2)}\n</${layout.name}>`
    : `<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>{post.data.title}</title>\n  </head>\n  <body>\n${indent(article, 4)}\n  </body>\n</html>`;
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

/** An untouched legacy route → the site layout it wrapped (null = none); undefined = not ours / edited. */
export function legacyRouteLayout(collection: string, source: string): { name: string; importPath: string } | null | undefined {
  const layout = detectPageLayout(source);
  return source === legacyPostRouteSource(collection, layout) ? layout : undefined;
}

