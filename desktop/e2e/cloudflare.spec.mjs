// Publish → Cloudflare through the real editor: the REAL local Astro build of the release fixture, uploaded to a local
// fake Cloudflare API (SQ_CLOUDFLARE_TEST_API switches main to a signed-in stub account; never packaged), then Get a
// domain → Buy → the domain is the site — docs/plans/2026-10-16-cloudflare-one-click-design.md (C1–C3).
import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BOOT, preview, importFixture, fail, logs, launch, setupEnv, git } from './helpers.mjs';

test.afterEach(async ({}, info) => { await fs.writeFile(info.outputPath('console.log'), logs.splice(0).join('\n')); });

/** The calls Publish and Get a domain make, answered like Cloudflare; what arrives is kept for the assertions. */
async function fakeCloudflare() {
  const A = '/accounts/e2e-account';
  const got = { manifest: null, files: new Map(), metadata: null, registrations: [], attached: [], workers: new Map(), site: {}, deleted: [], ids: 0 };
  const DOMAIN = { name: 'bakery-e2e.com', registrable: true, tier: 'standard', pricing: { currency: 'USD', registration_cost: '10.44', renewal_cost: '10.44' } };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const send = (result, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: status < 400, errors: status < 400 ? [] : [{ code: 10000, message: 'stub' }], messages: [], result })); };
    const url = new URL(req.url, 'http://stub');
    const form = () => new Request(url, { method: req.method, headers: req.headers, body }).formData(); // undici parses the multipart
    const route = `${req.method} ${url.pathname}`;
    if (url.pathname.startsWith('/__site/')) { // what a deployed host serves: the uploaded bytes, only on hosts Cloudflare would route
      const [, , host, ...rest] = url.pathname.split('/'); const p = `/${rest.join('/')}`;
      const routed = [...got.workers.keys()].some(w => host === `${w}.e2e.workers.dev`) || got.attached.some(d => d.hostname === host);
      const file = routed && (got.site[p] ?? got.site[p.endsWith('/') ? `${p}index.html` : `${p}/index.html`]);
      if (!file) { res.writeHead(404); return res.end('There is nothing here yet'); }
      res.writeHead(200, { 'content-type': file.type }); return res.end(Buffer.from(file.base64, 'base64'));
    }
    if (route === `POST ${A}/workers/assets/upload`) {
      if (req.headers.authorization !== 'Bearer upload-jwt' || url.searchParams.get('base64') !== 'true') return send(null, 401);
      for (const [hash, file] of (await form()).entries()) got.files.set(hash, { type: file.type, base64: await file.text() });
      return send({ jwt: 'completion-jwt' }, 201);
    }
    if (req.headers.authorization !== 'Bearer e2e') return send(null, 401);
    if (route === `GET ${A}/workers/scripts`) return send([...got.workers].map(([id, tag]) => ({ id, tag })));
    let m = route.match(new RegExp(`^POST ${A}/workers/scripts/([\\w-]+)/assets-upload-session$`));
    if (m) { got.manifest = JSON.parse(body).manifest; return send({ jwt: 'upload-jwt', buckets: [Object.values(got.manifest).map(f => f.hash)] }); }
    m = route.match(new RegExp(`^PUT ${A}/workers/scripts/([\\w-]+)$`));
    if (m) {
      got.metadata = JSON.parse((await form()).get('metadata')); got.workers.set(m[1], 'tag-1');
      got.site = Object.fromEntries(Object.entries(got.manifest).map(([p, f]) => [p, got.files.get(f.hash)])); // this version goes live
      return send({ id: m[1], tag: 'tag-1' });
    }
    if (route === `GET ${A}/workers/subdomain`) return send({ subdomain: 'e2e' });
    if (/^POST .*\/workers\/scripts\/[\w-]+\/subdomain$/.test(route)) return send({ enabled: true });
    if (route === `GET ${A}/registrar/domain-search`) return send({ domains: [DOMAIN] });
    if (route === `POST ${A}/registrar/domain-check`) return send({ domains: [got.registrations.length ? { name: DOMAIN.name, registrable: false, reason: 'domain_unavailable' } : DOMAIN] });
    if (route === `POST ${A}/registrar/registrations`) { got.registrations.push(JSON.parse(body)); return send({ domain_name: DOMAIN.name, state: 'succeeded', completed: true }, 201); }
    if (route === `GET ${A}/registrar/registrations/${DOMAIN.name}/registration-status`) return send({ state: 'succeeded', completed: true, context: {} });
    if (route === 'GET /zones') return send(got.registrations.length && url.searchParams.get('name') === DOMAIN.name ? [{ id: 'z1', name: DOMAIN.name, status: 'active' }] : []);
    if (route === `PUT ${A}/workers/domains`) { const d = { id: `d${++got.ids}`, ...JSON.parse(body) }; got.attached.push(d); return send(d); }
    if (route === `GET ${A}/workers/domains`) return send(got.attached.filter(d => ['hostname', 'service'].every(k => !url.searchParams.has(k) || d[k] === url.searchParams.get(k))));
    m = route.match(new RegExp(`^DELETE ${A}/workers/domains/(d\\d+)$`));
    if (m) { got.deleted.push(m[1]); got.attached = got.attached.filter(d => d.id !== m[1]); return send(null); }
    m = route.match(new RegExp(`^DELETE ${A}/workers/scripts/([\\w-]+)$`));
    if (m) { got.deleted.push(`${m[1]}?${url.searchParams}`); got.workers.delete(m[1]); return send(null); }
    return send({ message: `unexpected ${route}` }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, got, close: () => new Promise(resolve => server.close(resolve)) };
}

test('C1/C3: nothing published → Publish to Cloudflare (one click) → built locally, uploaded, live; Get a domain → Buy → the domain is the site', async ({}, info) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-cloudflare-e2e-'));
  const api = await fakeCloudflare();
  let app;
  try {
    let page; ({ app, page } = await launch({ ...setupEnv(temp), SQ_CLOUDFLARE_TEST_API: api.url }));
    const id = await importFixture(page, 'Cloudflare E2E');
    await expect(preview(page).getByRole('heading', { name: 'Release fixture' })).toBeVisible({ timeout: BOOT });

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByTitle('Publish', { exact: true }).click();
    // The Publish window opens on the destination list: Cloudflare is picked, one click (docs/plans/2026-10-20-publish-sheet-design.md).
    await expect(page.getByRole('radiogroup', { name: 'Where your site lives' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Cloudflare' })).toBeChecked();
    await page.getByRole('button', { name: 'Publish to Cloudflare' }).click();
    await expect(page.getByTestId('publish-state').getByRole('textbox')).toHaveValue(/cloudflare-e2e\.e2e\.workers\.dev/, { timeout: 120_000 }); // the Address field (Figma 2026-10-21)
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await expect(page.getByText('Everything is published')).toBeVisible(); // ledger 41: the build left the folder clean
    expect(await app.evaluate(({ app: electronApp }) => electronApp.userAgentFallback)).not.toMatch(/Electron\//); // ledger 12: popups too

    // What reached "Cloudflare": Astro's dist only, typed for serving, plus the contact Worker.
    const paths = Object.keys(api.got.manifest);
    expect(paths).toContain('/index.html');
    expect(paths.some(p => /node_modules|\/\.sq\/|\.astro\/|astro\.config/.test(p))).toBe(false);
    const index = api.got.files.get(api.got.manifest['/index.html'].hash);
    expect(index.type).toBe('text/html; charset=utf-8');
    expect(Buffer.from(index.base64, 'base64').toString()).toContain('Release fixture');
    expect(api.got.files.size).toBe(new Set(Object.values(api.got.manifest).map(f => f.hash)).size);
    expect(api.got.metadata).toEqual({
      main_module: 'worker.js',
      assets: { jwt: 'completion-jwt', config: { html_handling: 'auto-trailing-slash', not_found_handling: '404-page' } },
      bindings: [{ type: 'assets', name: 'ASSETS' }],
      compatibility_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    const files = path.join(temp, 'projects', id);
    const cfg = async key => (await git('-C', files, 'config', key)).trim(); // repo-local, never pushed
    expect(await cfg('starquix.host')).toBe('cloudflare');
    expect(await cfg('starquix.cloudflareAccount')).toBe('e2e-account');
    expect(await cfg('starquix.cloudflareWorker')).toBe('cloudflare-e2e');
    await expect(fs.access(path.join(files, 'dist'))).rejects.toThrow(); // built in temp, never into the project

    // Click 2: our search + price + Buy → registered on the account → attached → HTTPS → the domain is the address.
    await page.getByRole('button', { name: 'Get a domain' }).click();
    await page.getByLabel('Domain name').fill('bakery-e2e');
    await page.getByLabel('Domain name').press('Enter');
    await expect(page.getByText('$10.44/year')).toBeVisible();
    await page.getByRole('button', { name: 'Buy $10.44' }).click();
    await expect(page.getByTestId('publish-state').getByRole('textbox')).toHaveValue(/bakery-e2e\.com/, { timeout: 30_000 });
    expect(api.got.registrations).toEqual([{ domain_name: 'bakery-e2e.com', years: 1, auto_renew: false }]); // C8/C9
    expect(api.got.attached.map(d => d.hostname)).toEqual(['bakery-e2e.com', 'www.bakery-e2e.com']);
    expect(await cfg('starquix.cloudflareDomain')).toBe('bakery-e2e.com');

    // Unpublish (ledger U2–U4): acts at once, no confirm (2026-11-11, delete-then-undo); the Worker + its domain bindings
    // leave, the domain stays registered; Publish again brings the same address (and the domain) back.
    await page.getByRole('button', { name: 'Unpublish' }).click();
    await expect(page.getByTestId('publish-state').getByRole('textbox')).toHaveValue('cloudflare-e2e.e2e.workers.dev', { timeout: 30_000 });
    await expect(page.getByTestId('publish-state')).toContainText('Offline'); // the old address + its helper (Figma 2026-10-21)
    expect(api.got.deleted).toEqual(['d1', 'd2', 'cloudflare-e2e?force=true']);
    expect(api.got.registrations).toHaveLength(1); // never touched
    await page.getByRole('button', { name: 'Publish to Cloudflare' }).click();
    await expect(page.getByTestId('publish-state').getByRole('textbox')).toHaveValue(/bakery-e2e\.com/, { timeout: 120_000 }); // same Worker, domain re-attached
    expect(await cfg('starquix.cloudflareWorker')).toBe('cloudflare-e2e');
  } catch (error) {
    await fail(app, temp, info, error);
  } finally {
    await app?.close();
    await api.close();
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 10 });
  }
});
