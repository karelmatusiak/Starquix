// The measured user journeys, in order, on ONE app session (each may rely on the
// previous one's state). A journey = { name, run(ctx), before?, after?, setup? }:
// only run() is traced; before/after settle state outside the measured window;
// setup replaces run when SQ_JOURNEYS skips it. run() must END when the user can
// see the result (an assertion on the canvas/UI), never on a fixed sleep — except
// the idle journeys, whose fixed window IS the measurement (per-process CPU time).
// ctx: { page, preview(), select(el), sleep(ms), fixture, BOOT, projectDir() }.
// Use-case catalog (which wiki use case each journey covers): docs/plans/2026-10-04-desktop-perf-climb.md.
import fs from 'node:fs/promises';
import path from 'node:path';
const fixtureHeading = ctx => ctx.preview().getByRole('heading', { name: 'Release fixture', exact: true });
const untilStyle = (locator, prop, value) => locator.evaluate((el, [p, v]) =>
  new Promise(r => { const t = () => getComputedStyle(el)[p] === v ? r() : setTimeout(t, 10); t(); }), [prop, value]);

async function importFixture(ctx) {
  const { page } = ctx;
  await page.getByRole('button', { name: 'Import project', exact: true }).click();
  await page.getByTestId('import-folder-input').setInputFiles(ctx.fixture);
  await page.getByLabel('Project name', { exact: true }).fill('Profile fixture');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await fixtureHeading(ctx).waitFor({ timeout: ctx.BOOT });
  await untilStyle(page.locator('iframe[data-viewport]').first(), 'opacity', '1');
}

// ── Use-case journeys. Helpers first. ──
const until = async (fn, timeout = 15_000, label = 'condition') => {
  const end = Date.now() + timeout;
  for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error(`timeout: ${label}`); await new Promise(r => setTimeout(r, 20)); }
};
const pageSource = ctx => fs.readFile(path.join(ctx.projectDir(), 'src/pages/index.astro'), 'utf8');
const onDisk = (ctx, test, label) => until(async () => test(await pageSource(ctx)), 15_000, `disk: ${label}`);
const occurrences = (s, text) => s.split(text).length - 1;
const text = (ctx, t) => ctx.preview().getByText(t, { exact: true });
const second = ctx => text(ctx, 'Second editable paragraph');
const linkOrder = ctx => ctx.preview().locator('main a').evaluateAll(as => as.map(a => a.textContent.trim()));
const designTag = (ctx, tag) => ctx.page.getByTestId('design-bar').getByText(tag, { exact: true }).waitFor();
const layerRows = (ctx, tag) => ctx.page.getByTestId('layer-item').filter({ hasText: new RegExp(`^\\s*${tag}\\s*$`) });
async function pick(ctx, locator, tag) { await ctx.page.keyboard.press('Escape'); await ctx.select(locator); await designTag(ctx, tag); }
async function goHome(ctx) { // the home page at 100 %, idle (a page switch resets the view)
  await ctx.page.keyboard.press('Escape');
  await ctx.page.locator('input[value="/"]').click();
  await text(ctx, 'First editable paragraph').waitFor({ timeout: 30_000 });
  await untilStyle(ctx.page.locator('iframe[data-viewport]').first(), 'opacity', '1');
}
async function resetView(ctx) {
  await ctx.page.locator('input[value="/nested/about"]').click();
  await ctx.preview().getByRole('heading', { name: 'Nested about', exact: true }).waitFor({ timeout: 30_000 });
  await goHome(ctx);
}
/** A real pointer drag (dnd-kit and the canvas flow drag ignore synthetic dragTo). */
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(from.x, from.y + (to.y > from.y ? 10 : -10), { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 15 }); await page.mouse.up();
}
const center = b => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
async function pickBreakpoint(ctx, from, to, width) {
  await ctx.page.getByRole('button', { name: new RegExp(`^${from}\\s*\\d+$`) }).hover(); // hover opens; a click would toggle it shut
  await ctx.page.getByRole('menuitem').filter({ hasText: new RegExp(`^${to}`) }).click();
  await until(() => ctx.preview().locator('html').evaluate(() => innerWidth).then(w => w === width).catch(() => false), 10_000, `width ${width}`);
}
const zoomLabel = ctx => ctx.page.getByRole('button', { name: 'Zoom options' }).textContent().then(t => t.trim());
const frameBox = ctx => ctx.page.locator('iframe[data-viewport]').first().boundingBox();
// The variables table replaces the (still mounted, hidden) canvas: read every frame.
const cssVar = (ctx, name) => Promise.all(ctx.page.frames().slice(1).map(f =>
  f.evaluate(n => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name).catch(() => '')));
const postBody = ctx => ctx.page.locator('.sq-post-prose');
async function openPost(ctx) {
  await ctx.page.getByRole('tab', { name: 'Content', exact: true }).click();
  await ctx.page.getByText('hello.mdx', { exact: true }).click();
  await postBody(ctx).getByText('Dynamic markdown body preserved.').waitFor({ timeout: 15_000 });
}
const duplicate = async ctx => { await ctx.page.keyboard.press('ControlOrMeta+d'); await second(ctx).nth(1).waitFor({ timeout: 15_000 }); };
const remove = async ctx => { await ctx.page.keyboard.press('Backspace'); await second(ctx).nth(1).waitFor({ state: 'detached', timeout: 15_000 }); };
const undo = async ctx => { await ctx.page.keyboard.press('ControlOrMeta+z'); await second(ctx).nth(1).waitFor({ timeout: 15_000 }); };
const twoOnDisk = ctx => onDisk(ctx, s => occurrences(s, 'Second editable paragraph') === 2, 'two copies');
const oneOnDisk = ctx => onDisk(ctx, s => occurrences(s, 'Second editable paragraph') === 1, 'one copy');

// Continuous canvas gestures: what matters is frame cadence during the gesture (profile.mjs
// records editor rAF intervals per step). Each ends on the canvas settle signal, so the
// post-gesture React flush is inside the measured window. ~60 Hz event streams, like a trackpad.
const settled = ctx => ctx.page.evaluate(() => new Promise(r => window.addEventListener('sq:canvas-transform-settled', () => r(), { once: true })));
/** A point inside the visible canvas over the frame (a tall frame's center is off-screen). */
const gesturePoint = async ctx => { const b = await frameBox(ctx); const h = await ctx.page.evaluate(() => innerHeight);
  return { x: Math.round(b.x + b.width / 2), y: Math.round(Math.min(Math.max(b.y + 150, 120), h - 120)) }; };
const canvasIdle = async ctx => { await ctx.page.keyboard.press('Escape'); await untilStyle(ctx.page.locator('iframe[data-viewport]').first(), 'opacity', '1'); };
// Nobody touches the app for 8 s: polling or a hot loop shows as CPU (SQ_NO_TRACE=1 drops the tracer's own cost).
const idle = ctx => ctx.sleep(8000);
const gestures = [
  // canvas zoom on the native touchpad pinch path (Chromium's synthesizer, like a real trackpad): in 2×, back out.
  { name: 'pinch-zoom', before: canvasIdle, run: async ctx => {
    const b = await gesturePoint(ctx); const done = settled(ctx);
    for (const scaleFactor of [2, 0.5]) await ctx.cdp.send('Input.synthesizePinchGesture', { x: b.x, y: b.y, scaleFactor, relativeSpeed: 800, gestureSourceType: 'mouse' });
    await done;
  } },
  // two-finger pan on the native scroll path: down 1200 px and back.
  { name: 'trackpad-pan', before: canvasIdle, run: async ctx => {
    const b = await gesturePoint(ctx); const done = settled(ctx);
    for (const yDistance of [-1200, 1200]) await ctx.cdp.send('Input.synthesizeScrollGesture', { x: b.x, y: b.y, yDistance, speed: 1500, gestureSourceType: 'mouse' });
    await done;
  } },
  // hover across the page: the bridge highlights the element under the pointer.
  { name: 'hover-sweep', before: canvasIdle, run: async ctx => {
    // Only the visible part of the frame (a page-tall frame extends far below the window).
    const b = await frameBox(ctx); const h = await ctx.page.evaluate(() => innerHeight);
    const top = Math.max(b.y + 20, 80), bottom = Math.min(b.y + b.height - 20, h - 80);
    for (let i = 0; i <= 60; i++) { await ctx.page.mouse.move(b.x + b.width / 2, top + (bottom - top) * (i / 60)); await ctx.sleep(16); }
  } },
];

const useCases = [
  // selection-and-layers UC5 / design-bar "Multi-select": Cmd+click a second Layers row.
  { name: 'multi-select', before: async ctx => { await goHome(ctx); await pick(ctx, text(ctx, 'First editable paragraph'), 'P'); },
    run: async ctx => {
      await layerRows(ctx, 'p').nth(1).click({ modifiers: ['ControlOrMeta'] });
      await ctx.page.getByTestId('multi-select-panel').getByText(/^2 elements selected/).waitFor();
    }, after: ctx => ctx.page.keyboard.press('Escape') },
  // selection-and-layers UC8 (keyboard): Cmd+D duplicates the selection.
  { name: 'duplicate', before: async ctx => { await goHome(ctx); await pick(ctx, second(ctx), 'P'); },
    run: duplicate, after: twoOnDisk,
    setup: async ctx => { await goHome(ctx); await pick(ctx, second(ctx), 'P'); await duplicate(ctx); await twoOnDisk(ctx); } },
  // selection-and-layers UC8: Delete/Backspace removes the selection (the copy made above).
  { name: 'delete', before: ctx => pick(ctx, second(ctx).nth(1), 'P'), run: remove, after: oneOnDisk,
    setup: async ctx => { await pick(ctx, second(ctx).nth(1), 'P'); await remove(ctx); await oneOnDisk(ctx); } },
  // undo-redo UC1/UC2/UC8: the deleted copy comes back, then goes again.
  { name: 'undo', run: undo, after: twoOnDisk, setup: async ctx => { await undo(ctx); await twoOnDisk(ctx); } },
  { name: 'redo', run: async ctx => {
    await ctx.page.keyboard.press('ControlOrMeta+Shift+z');
    await second(ctx).nth(1).waitFor({ state: 'detached', timeout: 15_000 });
  }, after: oneOnDisk },
  // drag-and-drop UC5b / selection-and-layers UC7: drag the last link row above the first.
  { name: 'reorder-layers', before: goHome, run: async ctx => {
    const rows = layerRows(ctx, 'a');
    const from = center(await rows.nth(2).boundingBox()), to = await rows.nth(0).boundingBox();
    await drag(ctx.page, from, { x: from.x, y: to.y + 3 });
    await until(async () => (await linkOrder(ctx))[0] === 'Release widget', 10_000, 'canvas order');
  }, after: ctx => onDisk(ctx, s => s.indexOf('Release widget') < s.indexOf('Nested about'), 'reorder') },
  // drag-and-drop UC2 ("reshuffling"): flow-drag the selected link back below "Hello post".
  { name: 'reorder-canvas', before: async ctx => { await goHome(ctx); await pick(ctx, text(ctx, 'Release widget'), 'A'); },
    run: async ctx => {
      const from = await text(ctx, 'Release widget').boundingBox(), to = await text(ctx, 'Hello post').boundingBox();
      await drag(ctx.page, { x: from.x + 20, y: from.y + from.height / 2 }, { x: to.x + 20, y: to.y + to.height - 2 });
      await until(async () => (await linkOrder(ctx)).at(-1) === 'Release widget', 10_000, 'canvas order');
    }, after: ctx => onDisk(ctx, s => s.indexOf('Hello post') < s.indexOf('Release widget'), 'reorder') },
  // draw-mode UC1: Frame tool, drag a rect inside <main> → a dashed div appended there, auto-selected.
  { name: 'draw-frame', before: goHome, run: async ctx => {
    const { page } = ctx;
    await page.getByTestId('frames-button').click();
    await page.getByTitle('Frame (A)', { exact: true }).click();
    const main = await ctx.preview().locator('main').boundingBox(), link = await text(ctx, 'Nested about').boundingBox();
    const x = main.x + main.width - 120, y = link.y;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + 40, y + 30, { steps: 5 }); await page.mouse.move(x + 80, y + 60, { steps: 5 }); await page.mouse.up();
    await ctx.preview().locator('main > div.border-dashed').waitFor({ timeout: 15_000 });
  }, after: ctx => onDisk(ctx, s => s.includes('border-dashed'), 'drawn div') },
  // drag-and-drop UC1 / components UC1b+UC5: ⌘K picker → Hero → its markup on the canvas.
  { name: 'insert-component', before: goHome, run: async ctx => {
    const { page } = ctx;
    await page.getByTestId('add-component-button').click();
    await page.getByPlaceholder('Search components...').fill('Hero');
    // Hover mounts the card's Add overlay under the pointer; click that button, not the card.
    const card = page.getByTestId('template-item').filter({ has: page.getByText('Hero', { exact: true }) }).first();
    await card.hover(); await card.getByRole('button', { name: 'Add', exact: true }).click();
    await ctx.preview().getByRole('heading', { name: /Čerstvý chleba/ }).first().waitFor({ timeout: 30_000 });
  }, after: ctx => onDisk(ctx, s => s.includes('<Hero'), 'Hero') },
  // images UC2: Fill block → Upload image → the canvas shows the new file, the source references it.
  // Runs AFTER the structural journeys on purpose: duplicate/delete/undo/redo/reorder/draw/insert leave
  // retained registrations on reused coordinate keys, which once made the upload hit the wrong element
  // (fixed 1b1cb29e). The disk check names the <img> itself, so a wrong-element write fails here.
  { name: 'image-replace', before: async ctx => {
    await goHome(ctx); await ctx.select(ctx.preview().getByRole('img', { name: 'Release image', exact: true }));
    await ctx.page.getByRole('button', { name: 'Edit image Fill', exact: true }).waitFor();
    // Electron opens a native dialog for <input type=file>: keep the app's click, mark the input, feed it.
    await ctx.page.evaluate(() => { HTMLInputElement.prototype.click = function () { if (this.type === 'file') this.dataset.e2ePicked = '1'; }; });
  }, run: async ctx => {
    const { page } = ctx;
    await page.getByRole('button', { name: 'Edit image Fill', exact: true }).click();
    await page.getByRole('button', { name: 'Upload image', exact: true }).click();
    await page.locator('input[type=file][data-e2e-picked]').setInputFiles(path.join(ctx.fixture, 'public/replacement.png'));
    const img = ctx.preview().getByRole('img', { name: 'Release image', exact: true });
    // Ends when the new image is PAINTED (the upload answers only once it is served — 79152490).
    await until(() => img.evaluate(i => i.getAttribute('src') === '/uploads/replacement.png' && i.complete && i.naturalWidth > 0).catch(() => false), 15_000, 'canvas image painted');
    await onDisk(ctx, s => /<img\b[^>]*\sSRC="\/uploads\/replacement\.png"/.test(s), 'img SRC');
  }, after: ctx => ctx.page.keyboard.press('Escape') },
  // canvas UC3 / design-bar UC4: xs → md resizes the one frame.
  { name: 'breakpoint', before: goHome, run: ctx => pickBreakpoint(ctx, 'xs', 'md', 768), after: ctx => pickBreakpoint(ctx, 'md', 'xs', 375) },
  // canvas UC2: ⌘+ steps the zoom ladder; the chip and the frame follow.
  { name: 'zoom', before: async ctx => { // zoom keys ignore focused inputs (goHome leaves focus on the page row)
    await goHome(ctx); await ctx.page.mouse.move(10, 500); await ctx.page.evaluate(() => document.activeElement?.blur());
  }, run: async ctx => {
    const w0 = (await frameBox(ctx)).width;
    await ctx.page.keyboard.press('ControlOrMeta+Equal');
    await until(async () => await zoomLabel(ctx) === '125%' && (await frameBox(ctx)).width > w0 * 1.2, 5_000, 'zoom 125%');
  } },
  // canvas UC1: wheel over the frame pans (10 notches = 400 px), never scrolls the page inside.
  { name: 'pan', run: async ctx => {
    const b = await frameBox(ctx);
    await ctx.page.mouse.move(b.x + 100, Math.max(b.y, 0) + 100);
    for (let i = 0; i < 10; i++) await ctx.page.mouse.wheel(0, 40);
    await until(async () => (await frameBox(ctx)).y <= b.y - 300, 5_000, 'panned');
  }, after: resetView },
  // variables UC2 + UC7: edit a color value → the canvas document's custom property changes.
  { name: 'variable-edit', before: async ctx => {
    const { page } = ctx;
    await page.getByTitle('Add collection', { exact: true }).click(); // opens the new collection's table
    await page.getByRole('button', { name: 'Add variable' }).click();
    await page.getByText('Color', { exact: true }).last().click();
    await page.locator('input[value="#000000"]').first().waitFor();
  }, run: async ctx => {
    const hex = ctx.page.locator('input[value="#000000"]').first();
    await hex.fill('#ff3366'); await hex.press('Enter');
    await until(async () => (await cssVar(ctx, '--color-1')).includes('#ff3366'), 5_000, '--color-1 on canvas');
  }, after: async ctx => { // leaving the Components (assets) tab closes the table
    await ctx.page.getByRole('tab', { name: 'Components', exact: true }).click();
    await ctx.page.getByRole('tab', { name: 'File', exact: true }).click();
    await goHome(ctx);
  } },
  // pages UC1: + in the Pages panel → a new route row (and file).
  { name: 'add-page', run: async ctx => {
    await ctx.page.getByTestId('add-page-btn').click();
    await ctx.page.locator('input[value="/new-page"]').waitFor({ timeout: 15_000 });
  }, after: ctx => until(() => fs.access(path.join(ctx.projectDir(), 'src/pages/new-page.astro')).then(() => true, () => false), 15_000, 'page file') },
  // blog UC4 (open): Content → posts → hello.mdx opens the post editor.
  { name: 'post-open', run: openPost, setup: openPost },
  // blog UC4 (write): a new paragraph typed at the end of the body reaches the .mdx file.
  { name: 'post-type', before: async ctx => {
    // Settle: the editor may still re-render the loaded body; wait for a 500 ms DOM-quiet window.
    await postBody(ctx).evaluate(el => new Promise(r => { let t = setTimeout(done, 500); const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, 500); });
      function done() { mo.disconnect(); r(); } mo.observe(el, { subtree: true, childList: true, characterData: true }); }));
    // Caret at the end of the last paragraph (End does not move it on macOS), verified.
    const last = postBody(ctx).locator('p').last();
    await until(async () => {
      const end = await last.evaluate(p => { const r = document.createRange(); r.selectNodeContents(p); const rs = r.getClientRects(); const b = rs[rs.length - 1]; return { x: b.right - 1, y: b.top + b.height / 2 }; });
      await ctx.page.mouse.click(end.x, end.y);
      return last.evaluate(p => { const s = getSelection(); return p.contains(s.anchorNode) && s.isCollapsed && s.anchorOffset === s.anchorNode.textContent.length; });
    }, 5_000, 'caret at end');
  }, run: async ctx => {
    await ctx.page.keyboard.press('Enter');
    await ctx.page.keyboard.type('Profiled post paragraph', { delay: 40 });
    const file = path.join(ctx.projectDir(), 'src/content/posts/hello.mdx');
    await until(async () => /preserved\.\n\nProfiled post paragraph\n/.test(await fs.readFile(file, 'utf8')), 15_000, 'post on disk');
  }, after: async ctx => { await ctx.page.getByRole('tab', { name: 'File', exact: true }).click(); await goHome(ctx); } },
  // export-deploy UC1: Settings → Export project → a complete zip in Downloads.
  { name: 'export', run: async ctx => {
    const dir = path.resolve(ctx.projectDir(), '../../downloads'); await fs.mkdir(dir, { recursive: true });
    const before = new Set(await fs.readdir(dir));
    await ctx.page.getByRole('button', { name: 'Settings', exact: true }).click();
    await ctx.page.getByTitle('Export project', { exact: true }).click();
    let size = -1; // a finished download is renamed from its .crdownload: settle on stable bytes
    await until(async () => {
      const f = (await fs.readdir(dir)).find(n => !before.has(n) && n.endsWith('.zip')); if (!f) return false;
      const s = (await fs.stat(path.join(dir, f))).size; const stable = s > 0 && s === size; size = s; return stable;
    }, 60_000, 'zip');
  }, after: ctx => ctx.page.keyboard.press('Escape') },
  // export-deploy UC3 (the Publish window): Settings → Publish → its first step; then the Versions tab → the history.
  { name: 'publish-open', run: async ctx => {
    await ctx.page.getByRole('button', { name: 'Settings', exact: true }).click();
    await ctx.page.getByRole('button', { name: 'Publish', exact: true }).click();
    await ctx.page.getByRole('heading', { name: 'Where should your site live?', exact: true }).waitFor({ timeout: 15_000 });
  } },
  { name: 'versions-open', run: async ctx => {
    await ctx.page.getByRole('tab', { name: 'Versions', exact: true }).click();
    await ctx.page.getByRole('region', { name: 'History' }).waitFor({ timeout: 15_000 });
  } },
  { name: 'versions-idle', run: idle, after: async ctx => { // Escape closes the window
    await ctx.page.keyboard.press('Escape');
    await ctx.page.getByRole('tab', { name: 'Versions', exact: true }).waitFor({ state: 'hidden' });
  } },
];

export const journeys = [
  // before = a user's think time on the Projects page (the spare runner is ready by then, as in real use)
  { name: 'open', run: importFixture, setup: importFixture, before: ctx => ctx.sleep(3000), after: ctx => ctx.sleep(2000) },
  { name: 'select', run: async ctx => {
    await ctx.select(fixtureHeading(ctx));
    await ctx.page.getByTestId('design-bar').getByText('H1', { exact: true }).waitFor();
  } },
  { name: 'type', run: async ctx => {
    const { page } = ctx;
    await page.keyboard.press('Enter');
    await ctx.preview().locator('[contenteditable="plaintext-only"]').waitFor(); await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Profiled heading text', { delay: 40 });
    await page.keyboard.press('Escape');
    await ctx.preview().getByRole('heading', { name: 'Profiled heading text', exact: true }).waitFor({ timeout: 15_000 });
  }, after: ctx => ctx.sleep(1000) },
  { name: 'class-edit', run: async ctx => {
    await ctx.page.getByTitle('Align center', { exact: true }).click();
    await untilStyle(ctx.preview().getByRole('heading', { name: 'Profiled heading text', exact: true }), 'textAlign', 'center');
  }, after: ctx => ctx.sleep(6000) }, // the deferred class write lands outside the gesture
  { name: 'page-switch', run: async ctx => {
    await ctx.page.locator('input[value="/nested/about"]').click();
    await ctx.preview().getByRole('heading', { name: 'Nested about', exact: true }).waitFor({ timeout: 30_000 });
  } },
  { name: 'reopen', run: async ctx => {
    await ctx.page.reload();
    await ctx.preview().getByRole('heading', { level: 1 }).first().waitFor({ timeout: ctx.BOOT });
  } },
  { name: 'idle', before: async ctx => { await canvasIdle(ctx); await ctx.sleep(2000); }, run: idle }, // the canvas just opened, settled
  ...useCases,
  ...gestures,
  // The daily flow: back to Projects, think, open the project from its card (instance stops on
  // unmount by law; the spare runner should serve the boot).
  { name: 'open-existing', before: async ctx => {
    await ctx.page.keyboard.press('Escape');
    await ctx.page.getByTitle('Back to projects', { exact: true }).click();
    await ctx.page.getByRole('heading', { name: 'Projects', exact: true }).waitFor({ timeout: 30_000 });
    await ctx.sleep(6000); // think time; also lets the replenished spare finish warming
  }, run: async ctx => {
    await ctx.page.getByRole('link').filter({ hasText: 'Profile fixture' }).first().click();
    // Any level-1 heading (as reopen): `type` renamed 'Release fixture', so its name never comes back.
    await ctx.preview().getByRole('heading', { level: 1 }).first().waitFor({ timeout: ctx.BOOT });
    await untilStyle(ctx.page.locator('iframe[data-viewport]').first(), 'opacity', '1');
  } },
];
