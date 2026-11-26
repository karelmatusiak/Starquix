// Generates ⌘K picker preview PNGs for preview-template library components + layouts.
// Run from app/: `npm run previews:generate`. See docs/plans/2026-07-08-cmdk-auto-previews-design.md
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE = join(APP, '..', 'preview-template');
const OUT = join(APP, 'src', 'assets', 'images', 'editor-components', 'generated');
const PAGES = join(TEMPLATE, 'src', 'pages');
const PORT = 4991; // ponytail: not 4321 — a squatter there poisons scans (see memory)

// No _-prefix on route dirs — Astro excludes _-prefixed pages from routing.
// data-sq-preview marks a successful render: an SSR error serves only the
// vite client script (no marker), which then paints the error overlay.
// mockPost feeds BlogCard's post prop; the posts/pagination slot fills feed
// BlogSlot. Components without those props/slots ignore them.
const componentRoute = `---
import '../../styles/global.css';
import BlogCard from '../../components/library/BlogCard.astro';
import BlogPaginationNumbered from '../../components/library/BlogPaginationNumbered.astro';
export function getStaticPaths() {
  return Object.keys(import.meta.glob('../../components/library/*.astro'))
    .map((p) => ({ params: { name: p.split('/').pop().replace('.astro', '') } }));
}
const mods = import.meta.glob('../../components/library/*.astro', { eager: true });
const C = mods[\`../../components/library/\${Astro.params.name}.astro\`].default;
const mockPost = { data: {
  thumbnail: 'image',
  title: 'Post title',
  description: 'A short description of what this post is about.',
  date: 'Jul 8, 2026',
} };
// Card components rendered full-width blow up (aspect-video fills the whole
// viewport) — box them at a realistic card width instead.
const CARD_WIDTH = { BlogCard: '420px' };
const cardWidth = CARD_WIDTH[Astro.params.name];
---
<html><head><meta charset="utf-8" /></head><body data-sq-preview>
  <div style={cardWidth ? \`max-width: \${cardWidth}; margin: 24px auto\` : undefined}>
    <C post={mockPost}>
      <Fragment slot="posts">
        <BlogCard post={mockPost} />
        <BlogCard post={mockPost} />
        <BlogCard post={mockPost} />
      </Fragment>
      <Fragment slot="pagination"><BlogPaginationNumbered /></Fragment>
    </C>
  </div>
</body></html>
`;

// Page-template components (@page-template marker, e.g. BlogPost) render a
// full HTML document via Layout — like layouts, they get a slot placeholder
// instead of the <html> wrapper.
const pageTemplateRoute = `---
export function getStaticPaths() {
  return Object.keys(import.meta.glob('../../components/library/*.astro'))
    .map((p) => ({ params: { name: p.split('/').pop().replace('.astro', '') } }));
}
const mods = import.meta.glob('../../components/library/*.astro', { eager: true });
const C = mods[\`../../components/library/\${Astro.params.name}.astro\`].default;
---
<C title="Blog post"><main data-sq-preview style="min-height: 480px; margin: 32px; border: 3px dashed #cbd5e1; border-radius: 12px; display: flex; align-items: center; justify-content: center; color: #94a3b8; font-family: sans-serif; font-size: 28px">Post content</main></C>
`;

// Sections in a library sub-folder: Classic's frozen copies (library/classic/, saved as classic--<Name>.png — see
// previewImages.ts) and the Starquix nav bars (library/navigation/).
const folderRoute = (folder) => `---
import '../../styles/global.css';
export function getStaticPaths() {
  return Object.keys(import.meta.glob('../../components/library/${folder}/*.astro'))
    .map((p) => ({ params: { name: p.split('/').pop().replace('.astro', '') } }));
}
const mods = import.meta.glob('../../components/library/${folder}/*.astro', { eager: true });
const C = mods[\`../../components/library/${folder}/\${Astro.params.name}.astro\`].default;
---
<html><head><meta charset="utf-8" /></head><body data-sq-preview><div><C /></div></body></html>
`;

const layoutRoute = `---
export function getStaticPaths() {
  return Object.keys(import.meta.glob('../../layouts/*.astro'))
    .map((p) => ({ params: { name: p.split('/').pop().replace('.astro', '') } }));
}
const mods = import.meta.glob('../../layouts/*.astro', { eager: true });
const L = mods[\`../../layouts/\${Astro.params.name}.astro\`].default;
---
<L><main data-sq-preview style="min-height: 480px; margin: 32px; border: 3px dashed #cbd5e1; border-radius: 12px; display: flex; align-items: center; justify-content: center; color: #94a3b8; font-family: sans-serif; font-size: 28px">Page content</main></L>
`;

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('astro dev did not start in 60s')), 60_000);
    child.stdout.on('data', (buf) => {
      const m = String(buf).match(/(http:\/\/localhost:\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', (code) => reject(new Error(`astro dev exited early (${code})`)));
  });
}

const listNames = (dir) =>
  readdirSync(join(TEMPLATE, 'src', dir))
    .filter((f) => f.endsWith('.astro'))
    .map((f) => f.replace('.astro', ''));

const isPageTemplate = (name) =>
  readFileSync(join(TEMPLATE, 'src', 'components', 'library', `${name}.astro`), 'utf8')
    .includes('@page-template');

const targets = [
  ...listNames('components/library')
    .map((n) => ({ name: n, route: isPageTemplate(n) ? 'sq-preview-page' : 'sq-preview' })),
  ...listNames('components/library/classic').map((n) => ({ name: n, route: 'sq-preview-classic', file: `classic--${n}` })),
  ...listNames('components/library/navigation').map((n) => ({ name: n, route: 'sq-preview-nav' })),
  ...listNames('components/library/cz').map((n) => ({ name: n, route: 'sq-preview-cz' })),
  ...listNames('layouts').map((n) => ({ name: n, route: 'sq-preview-layout' })),
];

// One table for setup AND cleanup: a route missing from cleanup would leave [name].astro in preview-template/src/pages.
const ROUTES = {
  'sq-preview': componentRoute,
  'sq-preview-page': pageTemplateRoute,
  'sq-preview-layout': layoutRoute,
  'sq-preview-classic': folderRoute('classic'),
  'sq-preview-nav': folderRoute('navigation'),
  'sq-preview-cz': folderRoute('cz'),
};
for (const [dir, content] of Object.entries(ROUTES)) {
  mkdirSync(join(PAGES, dir), { recursive: true });
  writeFileSync(join(PAGES, dir, '[name].astro'), content);
}
rmSync(OUT, { recursive: true, force: true }); // script owns this dir — no stale PNGs
mkdirSync(OUT, { recursive: true });

const server = spawn(join(TEMPLATE, 'node_modules', '.bin', 'astro'), ['dev', '--port', String(PORT)], {
  cwd: TEMPLATE,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let browser;
const skipped = [];
try {
  const base = await waitForServer(server);
  const chrome = '/opt/google/chrome/chrome';
  browser = await chromium.launch(existsSync(chrome) ? { executablePath: chrome } : {});
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 0.5,
  });

  for (const { name, route, file } of targets) {
    const resp = await page.goto(`${base}/${route}/${name}`, { waitUntil: 'networkidle' });
    if (!resp?.ok()) { skipped.push(`${name} (HTTP ${resp?.status()})`); continue; }
    const rendered = await page.evaluate(() => !!document.querySelector('[data-sq-preview]'));
    if (!rendered) { skipped.push(`${name} (render error)`); continue; }
    await page.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
    await page.evaluate(() => document.fonts.ready);
    const height = await page.evaluate(
      () => document.body.firstElementChild?.getBoundingClientRect().height ?? 0,
    );
    if (height < 8) { skipped.push(`${name} (blank)`); continue; }
    await page.screenshot({ path: join(OUT, `${file ?? name}.png`) });
    console.log(`✓ ${file ?? name}`);
  }
} finally {
  await browser?.close();
  server.kill();
  for (const dir of Object.keys(ROUTES)) {
    rmSync(join(PAGES, dir), { recursive: true, force: true });
  }
}
if (skipped.length) console.log(`skipped (text fallback in picker): ${skipped.join(', ')}`);
console.log(`done: ${targets.length - skipped.length}/${targets.length} previews in ${OUT}`);
