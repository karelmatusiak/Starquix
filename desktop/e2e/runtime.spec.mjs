import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BOOT, preview, alive, survivors, importFixture, fail, select, logs, launch, exportZip, running, setupEnv, fixture } from './helpers.mjs';
test.afterEach(async ({}, info) => { await fs.writeFile(info.outputPath('console.log'), logs.splice(0).join('\n')); });


test('Electron edits real source, survives child crash, quit and reopen', async ({}, info) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-electron-'));
  const env = setupEnv(temp);
  let app;
  try {
    let page; ({ app, page } = await launch(env));
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible({ timeout: 60_000 });
    const versions = await app.evaluate(() => process.versions);
    expect(versions.electron).toBeTruthy();
    await info.attach('versions.json', { body: JSON.stringify(versions), contentType: 'application/json' });
    const id = await importFixture(page, 'Desktop edit fixture'); const editorUrl = page.url();
    const heading = preview(page).getByRole('heading', { name: 'Release fixture', exact: true });
    await expect(heading).toBeVisible({ timeout: BOOT }); await select(page, heading);
    await expect(page.getByTestId('design-bar').getByText('H1', { exact: true })).toBeVisible();
    await page.keyboard.press('Enter');
    await preview(page).locator('[contenteditable="plaintext-only"]').fill('Desktop durable source');
    await page.keyboard.press('Escape');
    await page.getByTitle('Align center', { exact: true }).click();
    const edited = preview(page).getByRole('heading', { name: 'Desktop durable source' });
    await expect(edited).toHaveCSS('text-align', 'center');
    const file = path.join(temp, 'projects', id, 'src/pages/index.astro');
    // Text writes immediately; the class write is deferred (5 s) by design.
    await expect.poll(() => fs.readFile(file, 'utf8'), { timeout: 15_000 }).toMatch(/<h1[^>]*class="[^"]*text-center[^"]*"[^>]*>Desktop durable source<\/h1>/);
    // Reload: a new lease reopens disk through the real driver.
    await page.reload();
    await expect(edited).toBeVisible({ timeout: BOOT });
    await expect.poll(() => running(page).then(s => s?.pid), { timeout: BOOT }).toBeTruthy();
    const childState = await running(page);
    expect(childState.childElectron).toBe(versions.electron);
    expect(childState.childNode).toBe(versions.node);
    const pid = childState.pid;
    process.kill(pid, 'SIGKILL');
    await expect.poll(() => running(page).then(s => !!s?.pid && s.pid !== pid), { timeout: BOOT }).toBe(true);
    await expect(edited).toBeVisible({ timeout: BOOT });
    const finalPid = (await running(page)).pid;
    expect(alive(pid)).toBe(false);
    await info.attach('pids.json', { body: JSON.stringify({ killed: pid, replacement: finalPid }), contentType: 'application/json' });
    await app.close(); app = null;
    await expect.poll(() => alive(finalPid), { timeout: 10_000 }).toBe(false);
    expect(await survivors(temp)).toEqual([]);
    ({ app, page } = await launch(env));
    await page.goto(editorUrl);
    const reopened = preview(page).getByRole('heading', { name: 'Desktop durable source' });
    await expect(reopened).toBeVisible({ timeout: BOOT });
    await expect(reopened).toHaveCSS('text-align', 'center');
    await info.attach('source.astro', { body: await fs.readFile(file), contentType: 'text/plain' });
  } catch (error) { await fail(app, temp, info, error); }
  finally { await app?.close(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 10 }); }
});

test('new project: library insert reaches disk and the immediate ZIP', async ({}, info) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-electron-new-'));
  const env = setupEnv(temp);
  let app;
  try {
    let page; ({ app, page } = await launch(env));
    await page.getByRole('button', { name: 'New Project', exact: true }).click();
    await page.getByRole('link').filter({ hasText: 'New Project' }).first().click();
    await expect(page).toHaveURL(/\/editor\/browser_/, { timeout: BOOT }); // a cold dev editor compiles the route first
    const id = new URL(page.url()).pathname.split('/').pop();
    // Empty scaffold: the frame stays transparent until it has content; wait for the first scan.
    await expect(page.getByText('No elements on page', { exact: true })).toBeVisible({ timeout: BOOT });
    // A new project starts on the Starquix theme (⌘K theme picker); its Hero heading:
    const heading = preview(page).getByRole('heading', { name: 'Chléb z\u00A0pece', exact: true }).first();
    // The editor refuses a structural write until its first rescan ("retry in a moment"): pick again if refused.
    for (let attempt = 0; attempt < 3 && !await heading.isVisible(); attempt++) {
      await page.getByTestId('add-component-button').click();
      await page.getByPlaceholder('Search components...').fill('Hero');
      // Hover mounts the card's Add overlay under the pointer; click that button, not the card.
      const card = page.getByTestId('template-item').filter({ has: page.getByText('Hero', { exact: true }) }).first();
      await card.hover(); await card.getByRole('button', { name: 'Add', exact: true }).click();
      await heading.waitFor({ timeout: 15_000 }).catch(() => {});
    }
    await expect(heading).toBeVisible();
    const page_ = path.join(temp, 'projects', id, 'src/pages/index.astro');
    await expect.poll(() => fs.readFile(page_, 'utf8'), { timeout: 15_000 }).toContain('<Hero');
    await fs.access(path.join(temp, 'projects', id, 'src/components/Hero.astro'));
    const zip = await exportZip(page, temp, info, 'desktop-new.zip');
    expect(await zip.file('src/pages/index.astro').async('string')).toContain('<Hero');
    expect(await zip.file('src/components/Hero.astro').async('string')).toContain('Chléb z\u00A0pece');
  } catch (error) { await fail(app, temp, info, error); }
  finally { await app?.close(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 10 }); }
});

test('uploaded image reaches immediate ZIP and survives app reopen', async ({}, info) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-electron-media-'));
  const env = setupEnv(temp);
  let app;
  try {
    let page; ({ app, page } = await launch(env));
    const id = await importFixture(page, 'Desktop media fixture'); const editorUrl = page.url();
    const target = preview(page).getByRole('img', { name: 'Release image', exact: true });
    await expect(target).toBeVisible({ timeout: BOOT }); await select(page, target);
    // Electron opens a native dialog for <input type=file> (no Playwright filechooser):
    // keep the app's own click (it arms the replace handler), mark the input, feed it.
    await page.evaluate(() => { HTMLInputElement.prototype.click = function () { if (this.type === 'file') this.dataset.e2ePicked = '1'; }; });
    await page.getByRole('button', { name: 'Edit image Fill', exact: true }).click();
    await page.getByRole('button', { name: 'Upload image', exact: true }).click();
    await page.locator('input[type=file][data-e2e-picked]').setInputFiles(path.join(fixture, 'public/replacement.png'));
    // No extra save wait: the export barrier must include the upload.
    const zip = await exportZip(page, temp, info, 'desktop-media.zip');
    const source = await zip.file('src/pages/index.astro').async('string');
    const imagePath = source.match(/<img\b[^>]*\sSRC="([^"]+)"/)?.[1];
    expect(imagePath).toBeTruthy(); expect(imagePath).not.toBe('/original.png');
    const original = await fs.readFile(path.join(fixture, 'public/replacement.png'));
    expect(await zip.file(`public${imagePath}`).async('nodebuffer')).toEqual(original);
    expect(await fs.readFile(path.join(temp, 'projects', id, `public${imagePath}`))).toEqual(original);
    await app.close(); ({ app, page } = await launch(env));
    await page.goto(editorUrl);
    await expect(preview(page).getByRole('img', { name: 'Release image', exact: true })).toHaveAttribute('src', imagePath, { timeout: BOOT });
  } catch (error) { await fail(app, temp, info, error); }
  finally { await app?.close(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 10 }); }
});
