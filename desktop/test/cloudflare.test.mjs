// Cloudflare REST + sign-in (docs/plans/2026-10-16-cloudflare-one-click-design.md). Ledger numbers in the names.
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { codeFromRedirect, createCloudflare, REDIRECT_URI, SCOPES } from '../src/cloudflare.mjs';
import { uncaughtDuring } from './helpers/uncaught.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const OAUTH = 'https://dash.cloudflare.com/oauth2';
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const cf = (result, status = 200) => json({ success: status < 400, errors: status < 400 ? [] : [{ code: 10000, message: 'raw body' }], result }, status);
const SIGNED_IN = { access: 'tok', refresh: 'ref', expiresAt: Date.now() + 3_600_000, accounts: [{ id: 'a1', name: 'Mine' }], account: 'a1' };
const memory = (blob = SIGNED_IN) => {
  let b = blob ? `enc:${JSON.stringify(blob)}` : null;
  return { store: { read: async () => b, write: async v => { b = v; }, clear: async () => { b = null; } },
    crypto: { encrypt: s => `enc:${s}`, decrypt: v => { if (!v.startsWith('enc:')) throw new Error('bad'); return v.slice(4); } },
    blob: () => (b ? JSON.parse(b.slice(4)) : null), raw: () => b };
};
/** A windows stub: `visits` are the URLs the window "navigates" to (a function gets the authorize URL's params). */
function windowsThat(...visits) {
  const opened = []; let cleared = 0;
  return { opened, cleared: () => cleared, windows: {
    open: async (url, { onNavigate } = {}) => {
      opened.push(url);
      for (const v of visits) {
        const next = typeof v === 'function' ? v(new URL(url).searchParams) : v;
        if (onNavigate?.(next)) break;
      }
    },
    clear: async () => { cleared += 1; },
  } };
}
function client(routes, { blob = SIGNED_IN, windows = windowsThat().windows, clientId = 'cid', now } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace(API, '').replace(OAUTH, 'oauth')}`;
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body)
      : typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ key, init, body });
    const r = routes[key] ?? routes[key.split('?')[0]];
    if (!r) throw new Error(`unexpected ${key}`);
    return typeof r === 'function' ? r({ init, body, calls }) : r;
  };
  const m = memory(blob);
  return { c: createCloudflare({ fetch, store: m.store, crypto: m.crypto, windows, clientId, now }), calls, m };
}
const TOKENS = (access = 'new', refresh = 'ref2') => json({ access_token: access, refresh_token: refresh, expires_in: 3600, token_type: 'bearer' });

it('1/3. codeFromRedirect: not our redirect → undefined; ours → the code; denied / no or foreign state / no code → null', () => {
  expect(codeFromRedirect('https://dash.cloudflare.com/login', 's')).toBe(undefined);
  expect(codeFromRedirect('not a url', 's')).toBe(undefined);
  expect(codeFromRedirect(`${REDIRECT_URI}x?code=c&state=s`, 's')).toBe(undefined); // a lookalike path is not ours
  expect(codeFromRedirect('http://127.0.0.1.evil.com/oauth/cloudflare?code=c&state=s', 's')).toBe(undefined);
  expect(codeFromRedirect(`${REDIRECT_URI}?code=c&state=s`, 's')).toBe('c');
  expect(codeFromRedirect(`http://127.0.0.1:8976/oauth/cloudflare?code=c&state=s`, 's')).toBe('c'); // loopback: any port (RFC 8252)
  expect(codeFromRedirect(`${REDIRECT_URI}?code=c`, 's')).toBe(null);
  expect(codeFromRedirect(`${REDIRECT_URI}?code=c&state=evil`, 's')).toBe(null);
  expect(codeFromRedirect(`${REDIRECT_URI}?error=access_denied&state=s`, 's')).toBe(null);
  expect(codeFromRedirect(`${REDIRECT_URI}?state=s`, 's')).toBe(null);
});

it('1. connect: authorize URL with PKCE S256 + state + scopes; the code is exchanged without a secret; tokens + the one account saved encrypted', async () => {
  const w = windowsThat('https://dash.cloudflare.com/login', p => `${REDIRECT_URI}?code=the-code&state=${p.get('state')}`);
  const { c, calls, m } = client({
    'POST oauth/token': TOKENS('acc1', 'ref1'),
    'GET /accounts': ({ init }) => { expect(init.headers.authorization).toBe('Bearer acc1'); return cf([{ id: 'a1', name: 'Mine', type: 'standard' }]); },
  }, { blob: null, windows: w.windows });
  await c.connect();
  const url = new URL(w.opened[0]);
  expect(`${url.origin}${url.pathname}`).toBe(`${OAUTH}/auth`);
  const q = url.searchParams;
  expect(q.get('response_type')).toBe('code');
  expect(q.get('client_id')).toBe('cid');
  expect(q.get('redirect_uri')).toBe(REDIRECT_URI);
  expect(q.get('scope')).toBe(SCOPES.join(' '));
  expect(q.get('code_challenge_method')).toBe('S256');
  expect(q.get('state')).toMatch(/^[0-9a-f-]{36}$/);
  const exchange = calls.find(x => x.key === 'POST oauth/token').body;
  expect(exchange).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', redirect_uri: REDIRECT_URI, client_id: 'cid' });
  expect(exchange.client_secret).toBeUndefined();
  expect(createHash('sha256').update(exchange.code_verifier).digest('base64url')).toBe(q.get('code_challenge'));
  expect(exchange.code_verifier.length).toBeGreaterThanOrEqual(43);
  expect(m.raw().startsWith('enc:')).toBe(true);
  expect(m.blob()).toMatchObject({ access: 'acc1', refresh: 'ref1', accounts: [{ id: 'a1', name: 'Mine' }], account: 'a1' });
  expect(await c.connected()).toBe(true);
  expect(await c.account()).toEqual({ id: 'a1', name: 'Mine' });
});

it('2/3. window closed, denied or a foreign state → cancelled, nothing saved, no exchange', async () => {
  for (const visits of [[], [`${REDIRECT_URI}?error=access_denied&state=x`], [`${REDIRECT_URI}?code=c&state=forged`]]) {
    const { c, calls, m } = client({}, { blob: null, windows: windowsThat(...visits).windows });
    await expect(c.connect()).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toEqual([]);
    expect(m.raw()).toBe(null);
  }
});

it('4/6. a refused code exchange → cloudflare (no body); no client id → not-configured before any window', async () => {
  const w = windowsThat(p => `${REDIRECT_URI}?code=c&state=${p.get('state')}`);
  const { c, m } = client({ 'POST oauth/token': json({ error: 'invalid_grant', error_description: 'raw body' }, 400) }, { blob: null, windows: w.windows });
  const e = await c.connect().then(() => null, x => x);
  expect(e).toMatchObject({ code: 'cloudflare', status: 400 });
  expect(e.message).not.toContain('raw body');
  expect(m.raw()).toBe(null);
  const none = windowsThat();
  const { c: unset } = client({}, { blob: null, windows: none.windows, clientId: '' });
  await expect(unset.connect()).rejects.toMatchObject({ code: 'not-configured' });
  expect(none.opened).toEqual([]);
});

it('9/11. no account allowed → no-account, nothing saved; several → none chosen until chooseAccount (unknown id refused)', async () => {
  const w = () => windowsThat(p => `${REDIRECT_URI}?code=c&state=${p.get('state')}`).windows;
  const { c: zero, m: m0 } = client({ 'POST oauth/token': TOKENS(), 'GET /accounts': cf([]) }, { blob: null, windows: w() });
  await expect(zero.connect()).rejects.toMatchObject({ code: 'no-account' });
  expect(m0.raw()).toBe(null);
  const two = [{ id: 'a1', name: 'Mine' }, { id: 'a2', name: 'Work' }];
  const { c, m } = client({ 'POST oauth/token': TOKENS(), 'GET /accounts': cf(two) }, { blob: null, windows: w() });
  await c.connect();
  expect(await c.account()).toBe(null);
  expect(await c.accounts()).toEqual(two);
  await expect(c.chooseAccount('a9')).rejects.toMatchObject({ code: 'invalid' });
  await c.chooseAccount('a2');
  expect(await c.account()).toEqual({ id: 'a2', name: 'Work' });
  expect(m.blob().account).toBe('a2');
});

it('every call carries the bearer token; 429 / other → their codes with status, never the body; offline passes through', async () => {
  const { c, calls } = client({ 'GET /accounts/a1/workers/scripts': cf([]) });
  await c.call('/accounts/a1/workers/scripts');
  expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer tok' });
  for (const [status, code] of [[429, 'rate-limited'], [403, 'cloudflare'], [500, 'cloudflare']]) {
    const { c: f } = client({ 'GET /x': cf(null, status) });
    const e = await f.call('/x').then(() => null, x => x);
    expect(e).toMatchObject({ code });
    expect(e.message).not.toContain('raw body');
    if (code === 'cloudflare') expect(e.status).toBe(status);
  }
  const offline = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const { c: off } = client({ 'GET /x': () => { throw offline; } });
  await expect(off.call('/x')).rejects.toBe(offline);
  const { c: out, calls: none } = client({}, { blob: null });
  await expect(out.call('/x')).rejects.toMatchObject({ code: 'cloudflare-signed-out' });
  expect(none).toEqual([]);
});

it('7. an expiring token is refreshed first (60 s early); the rotated refresh token is stored; parallel calls share ONE refresh', async () => {
  let t = 1_000_000;
  const { c, calls, m } = client({
    'POST oauth/token': TOKENS('acc2', 'ref2'),
    'GET /x': ({ init }) => cf({ auth: init.headers.authorization }),
  }, { blob: { ...SIGNED_IN, expiresAt: t + 30_000 }, now: () => t });
  const [a, b] = await Promise.all([c.call('/x'), c.call('/x')]);
  expect([a.body.result.auth, b.body.result.auth]).toEqual(['Bearer acc2', 'Bearer acc2']);
  expect(calls.filter(x => x.key === 'POST oauth/token')).toHaveLength(1);
  expect(calls.find(x => x.key === 'POST oauth/token').body).toEqual({ grant_type: 'refresh_token', refresh_token: 'ref', client_id: 'cid' });
  expect(m.blob()).toMatchObject({ access: 'acc2', refresh: 'ref2', expiresAt: t + 3_600_000, account: 'a1' });
  t += 10_000; // still fresh: no second refresh
  await c.call('/x');
  expect(calls.filter(x => x.key === 'POST oauth/token')).toHaveLength(1);
});

it('7/8. a 401 refreshes once and retries; a refused refresh signs out (blob cleared); a 401 after the refresh → signed out', async () => {
  let n = 0;
  const { c, calls } = client({
    'POST oauth/token': TOKENS('acc2', 'ref2'),
    'GET /x': ({ init }) => (init.headers.authorization === 'Bearer acc2' ? cf({ ok: ++n }) : cf(null, 401)),
  });
  expect((await c.call('/x')).body.result).toEqual({ ok: 1 });
  expect(calls.map(x => x.key)).toEqual(['GET /x', 'POST oauth/token', 'GET /x']);

  const { c: dead, m } = client({ 'POST oauth/token': json({ error: 'invalid_grant' }, 400), 'GET /x': cf(null, 401) });
  await expect(dead.call('/x')).rejects.toMatchObject({ code: 'cloudflare-signed-out' });
  expect(m.raw()).toBe(null);
  expect(await dead.connected()).toBe(false);

  const { c: still } = client({ 'POST oauth/token': TOKENS('acc2'), 'GET /x': cf(null, 401) });
  await expect(still.call('/x')).rejects.toMatchObject({ code: 'cloudflare-signed-out' });
});

it('8. a refresh that fails on the network keeps the sign-in (offline is not signed out)', async () => {
  const offline = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const { c, m } = client({ 'POST oauth/token': () => { throw offline; } }, { blob: { ...SIGNED_IN, expiresAt: 0 } });
  await expect(c.call('/x')).rejects.toBe(offline);
  expect(m.blob().refresh).toBe('ref');
});

it('an unreadable blob = signed out', async () => {
  const { c, m } = client({});
  await m.store.write('garbage');
  expect(await c.connected()).toBe(false);
  expect(await c.account()).toBe(null);
});

it('14. signOut revokes the refresh token (best effort), clears the blob and the window partition', async () => {
  const w = windowsThat();
  const { c, calls, m } = client({ 'POST oauth/revoke': () => { throw new TypeError('fetch failed'); } }, { windows: w.windows });
  await c.signOut();
  expect(calls[0]).toMatchObject({ key: 'POST oauth/revoke', body: { token: 'ref', client_id: 'cid' } });
  expect(m.raw()).toBe(null);
  expect(w.cleared()).toBe(1);
  const { c: out } = client({}, { blob: null, windows: w.windows });
  await out.signOut(); // nothing to revoke
  expect(w.cleared()).toBe(2);
});

// ── Workers static assets (ledger 16–20, C2) ─────────────────────────────────────────────────────────────────────────
const sha = (bytes, ext) => createHash('sha256').update(Buffer.from(bytes).toString('base64') + ext).digest('hex').slice(0, 32);
const FILES = [
  { path: '/index.html', bytes: Buffer.from('<h1>Hi</h1>'), type: 'text/html' },
  { path: '/_astro/a.css', bytes: Buffer.from('h1{}'), type: 'text/css' },
  { path: '/logo.png', bytes: Buffer.from([1, 2, 3]), type: 'image/png' },
];

it('16. siteSlug: a worker name / DNS label — accents folded, emoji dropped, ≤ 58 chars (room for -xxxx), never empty', async () => {
  const { siteSlug } = await import('../src/cloudflare.mjs');
  expect(siteSlug('My Site')).toBe('my-site');
  expect(siteSlug('Café Ünïcode!!')).toBe('cafe-unicode');
  expect(siteSlug('🚀🚀')).toBe('starquix-site');
  expect(siteSlug('--a.b_c--')).toBe('a-b-c');
  expect(siteSlug('Ølsen & Æble')).toBe('olsen-aeble');
  expect(siteSlug('Straße')).toBe('strasse');
  const long = siteSlug(`${'x'.repeat(57)} y z`);
  expect(long.length).toBeLessThanOrEqual(58);
  expect(long.endsWith('-')).toBe(false);
});

it('16/17. freeName: the slug when free, else slug-xxxx — never a name already in the account', async () => {
  const { freeName } = await import('../src/cloudflare.mjs');
  expect(freeName(new Set(), 'my-site')).toBe('my-site');
  const taken = new Set(['my-site']);
  const n = freeName(taken, 'my-site');
  expect(n).toMatch(/^my-site-[a-z0-9]{4}$/);
  expect(n.length).toBeLessThanOrEqual(63);
});

it('18. scripts: the account\'s Worker names with their immutable tags', async () => {
  const { c } = client({ 'GET /accounts/a1/workers/scripts': cf([{ id: 'my-site', tag: 't1', has_assets: true }, { id: 'api', tag: 't2' }]) });
  expect(await c.scripts('a1')).toEqual([{ name: 'my-site', tag: 't1' }, { name: 'api', tag: 't2' }]);
});

it('C2. upload: manifest (32-hex sha256 of base64+ext, size) → buckets with the UPLOAD jwt as base64 parts typed for serving → Worker with assets and /api/kontakt', async () => {
  const uploads = [];
  let worker = null;
  const { c, calls } = client({
    'POST /accounts/a1/workers/scripts/my-site/assets-upload-session': ({ body }) => {
      expect(body).toEqual({ manifest: {
        '/index.html': { hash: sha(FILES[0].bytes, 'html'), size: 11 },
        '/_astro/a.css': { hash: sha(FILES[1].bytes, 'css'), size: 4 },
        '/logo.png': { hash: sha(FILES[2].bytes, 'png'), size: 3 },
      } });
      return cf({ jwt: 'upload-jwt', buckets: [[sha(FILES[0].bytes, 'html'), sha(FILES[1].bytes, 'css')], [sha(FILES[2].bytes, 'png')]] });
    },
    'POST /accounts/a1/workers/assets/upload?base64=true': async ({ init }) => {
      expect(init.headers.authorization).toBe('Bearer upload-jwt');
      const parts = [];
      for (const [hash, file] of init.body.entries()) parts.push({ hash, type: file.type, text: await file.text() });
      uploads.push(parts);
      return uploads.length === 2 ? cf({ jwt: 'completion-jwt' }, 201) : cf({}, 202);
    },
    'PUT /accounts/a1/workers/scripts/my-site': ({ init }) => {
      expect(init.headers.authorization).toBe('Bearer tok');
      expect([...init.body.keys()]).toEqual(['metadata', 'worker.js']);
      expect(JSON.parse(init.body.get('metadata'))).toEqual({
        main_module: 'worker.js',
        assets: { jwt: 'completion-jwt', config: { html_handling: 'auto-trailing-slash', not_found_handling: '404-page' } },
        bindings: [{ type: 'assets', name: 'ASSETS' }],
        compatibility_date: '2026-09-01',
      });
      worker = init.body.get('worker.js');
      return cf({ id: 'my-site', tag: 'tag-1' });
    },
  });
  expect(await c.upload('a1', 'my-site', FILES)).toBe('tag-1');
  expect(await worker.text()).toContain("pathname === '/api/kontakt'");
  expect(uploads).toEqual([
    [{ hash: sha(FILES[0].bytes, 'html'), type: 'text/html', text: FILES[0].bytes.toString('base64') },
      { hash: sha(FILES[1].bytes, 'css'), type: 'text/css', text: FILES[1].bytes.toString('base64') }],
    [{ hash: sha(FILES[2].bytes, 'png'), type: 'image/png', text: FILES[2].bytes.toString('base64') }],
  ]);
  expect(calls.map(x => x.key.split('?')[0])).toEqual(['POST /accounts/a1/workers/scripts/my-site/assets-upload-session',
    'POST /accounts/a1/workers/assets/upload', 'POST /accounts/a1/workers/assets/upload', 'PUT /accounts/a1/workers/scripts/my-site']);
});

it('30. upload: nothing new to upload (empty buckets) → the session jwt is the completion token; a refused bucket never PUTs', async () => {
  const { c, calls } = client({
    'POST /accounts/a1/workers/scripts/my-site/assets-upload-session': cf({ jwt: 'done-jwt', buckets: [] }),
    'PUT /accounts/a1/workers/scripts/my-site': ({ init }) => { expect(JSON.parse(init.body.get('metadata')).assets.jwt).toBe('done-jwt'); return cf({ tag: 't' }); },
  });
  expect(await c.upload('a1', 'my-site', FILES)).toBe('t');
  expect(calls).toHaveLength(2);
  const { c: refused, calls: none } = client({
    'POST /accounts/a1/workers/scripts/my-site/assets-upload-session': cf({ jwt: 'u', buckets: [[sha(FILES[0].bytes, 'html')]] }),
    'POST /accounts/a1/workers/assets/upload?base64=true': cf(null, 401), // an expired upload jwt is not a sign-out (ledger 31)
  });
  await expect(refused.upload('a1', 'my-site', FILES)).rejects.toMatchObject({ code: 'cloudflare', status: 401 });
  expect(none.some(x => x.key.startsWith('PUT'))).toBe(false);
});

it('19/20. workers.dev: the account subdomain (none → null), created as <slug> then -xxxx on refusal; a Worker\'s route enabled', async () => {
  const { c } = client({ 'GET /accounts/a1/workers/subdomain': cf({ subdomain: 'oleg' }) });
  expect(await c.subdomain('a1')).toBe('oleg');
  const { c: none } = client({ 'GET /accounts/a1/workers/subdomain': cf(null, 404) });
  expect(await none.subdomain('a1')).toBe(null);
  const tried = [];
  const { c: create } = client({ 'PUT /accounts/a1/workers/subdomain': ({ body }) => { tried.push(body.subdomain); return tried.length < 2 ? cf(null, 409) : cf({ subdomain: body.subdomain }); } });
  expect(await create.createSubdomain('a1', 'my-site')).toBe(tried[1]);
  expect(tried[0]).toBe('my-site');
  expect(tried[1]).toMatch(/^my-site-[a-z0-9]{4}$/);
  const { c: on, calls } = client({ 'POST /accounts/a1/workers/scripts/my-site/subdomain': cf({ enabled: true }) });
  await on.enableWorkersDev('a1', 'my-site');
  expect(calls[0].body).toEqual({ enabled: true, previews_enabled: false });
});

it('20/61. reachable = the address serves the exact page we uploaded (GET, redirects followed, body hash); a Cloudflare 404, another site, a TLS/DNS failure = not yet', async () => {
  const page = Buffer.from('<h1>Ours</h1>');
  const hash = createHash('sha256').update(page).digest('hex');
  const at = [];
  const probe = answer => async (url, init) => {
    at.push([url, init.method ?? 'GET', init.redirect]);
    if (answer instanceof Error) throw answer;
    return { ok: answer.status < 300, status: answer.status, arrayBuffer: async () => answer.body };
  };
  for (const [answer, want] of [[{ status: 200, body: page }, true], [{ status: 200, body: Buffer.from('<h1>Parked</h1>') }, false],
    [{ status: 404, body: page }, false], [{ status: 522, body: Buffer.from('') }, false], [new TypeError('fetch failed'), false]]) {
    const m = memory();
    const c = createCloudflare({ fetch: probe(answer), store: m.store, crypto: m.crypto, windows: windowsThat().windows, clientId: 'cid' });
    expect(await c.reachable('https://my-site.oleg.workers.dev/', hash)).toBe(want);
  }
  expect(at[0]).toEqual(['https://my-site.oleg.workers.dev/', 'GET', 'follow']);
});

// ── Registrar + custom domains (ledger 50–59, 61–62, 64, C8) ───────────────────────────────────────────────────────────
const price = (cost, renew = cost) => ({ currency: 'USD', registration_cost: cost, renewal_cost: renew });
const REG = '/accounts/a1/registrar';

it('50/51. search: the exact name (real-time check) first, then suggestions; owned / buy / taken / dashboard / unavailable rows', async () => {
  const { c, calls } = client({
    [`GET ${REG}/domain-search`]: cf({ domains: [
      { name: 'bakery.com', registrable: true, tier: 'standard', pricing: price('10.44') }, // the exact one again: deduped
      { name: 'bakery.dev', registrable: true, tier: 'standard', pricing: price('12.20', '14.00') },
      { name: 'bakery.ai', registrable: false, tier: 'premium', reason: 'domain_premium', pricing: price('900.00') },
      { name: 'bakery.uk', registrable: false, reason: 'extension_not_supported_via_api' },
      { name: 'bakery.xyz', registrable: false, reason: 'extension_disallows_registration' },
      { name: 'bakery.net', registrable: false, reason: 'domain_unavailable' },
    ] }),
    [`POST ${REG}/domain-check`]: ({ body }) => { expect(body).toEqual({ domains: ['bakery.com'] }); return cf({ domains: [{ name: 'bakery.com', registrable: true, tier: 'standard', pricing: price('10.44') }] }); },
    'GET /zones': cf([]),
  });
  expect(await c.search('a1', 'bakery.com')).toEqual([
    { name: 'bakery.com', kind: 'buy', price: '10.44', renewal: '10.44', currency: 'USD' },
    { name: 'bakery.dev', kind: 'buy', price: '12.20', renewal: '14.00', currency: 'USD' },
    { name: 'bakery.ai', kind: 'dashboard' },
    { name: 'bakery.uk', kind: 'dashboard' },
    { name: 'bakery.xyz', kind: 'unavailable' },
    { name: 'bakery.net', kind: 'taken' },
  ]);
  expect(calls[0].key).toBe(`GET ${REG}/domain-search?q=bakery.com&limit=6`);
  expect(calls.find(x => x.key.startsWith('GET /zones')).key).toBe('GET /zones?name=bakery.com&account.id=a1');
});

it('64. search: a domain already in the account → "owned" (Use it, no charge); a word without a dot is never checked/zoned', async () => {
  const { c } = client({
    [`GET ${REG}/domain-search`]: cf({ domains: [{ name: 'bakery.com', registrable: false, reason: 'domain_unavailable' }] }),
    [`POST ${REG}/domain-check`]: cf({ domains: [{ name: 'bakery.com', registrable: false, reason: 'domain_unavailable' }] }),
    'GET /zones': cf([{ id: 'z1', name: 'bakery.com', status: 'active' }]),
  });
  expect(await c.search('a1', 'bakery.com')).toEqual([{ name: 'bakery.com', kind: 'owned' }]);
  for (const q of ['bakery', 'my bakery.com']) {
    const { c: word, calls } = client({ [`GET ${REG}/domain-search`]: cf({ domains: [] }) });
    expect(await word.search('a1', q)).toEqual([]);
    expect(calls.map(x => x.key.split('?')[0])).toEqual([`GET ${REG}/domain-search`]);
  }
});

it('52/C8. buy re-checks: price changed → price-changed (+ the new price), taken → domain-taken — never a registration', async () => {
  for (const [check, code, extra] of [
    [{ name: 'bakery.com', registrable: true, tier: 'standard', pricing: price('11.00') }, 'price-changed', { price: '11.00', currency: 'USD' }],
    [{ name: 'bakery.com', registrable: true, tier: 'standard', pricing: { ...price('10.44'), currency: 'EUR' } }, 'price-changed', { price: '10.44', currency: 'EUR' }],
    [{ name: 'bakery.com', registrable: false, reason: 'domain_unavailable' }, 'domain-taken', {}],
    [{ name: 'bakery.com', registrable: false, tier: 'premium', reason: 'domain_premium' }, 'domain-taken', {}],
  ]) {
    const { c, calls } = client({ [`POST ${REG}/domain-check`]: cf({ domains: [check] }),
      [`GET ${REG}/registrations/bakery.com/registration-status`]: cf(null, 404) }); // not this account's (review 3b)
    await expect(c.buy('a1', 'bakery.com', { price: '10.44', currency: 'USD' }, false)).rejects.toMatchObject({ code, ...extra });
    expect(calls.some(x => x.key === `POST ${REG}/registrations`)).toBe(false);
  }
});

it('52–54. buy: same price → register { domain_name, years: 1, auto_renew } → 201 succeeded / 202 in progress', async () => {
  for (const [status, state] of [[201, 'succeeded'], [202, 'in_progress']]) {
    const { c, calls } = client({
      [`POST ${REG}/domain-check`]: cf({ domains: [{ name: 'bakery.com', registrable: true, tier: 'standard', pricing: price('10.44') }] }),
      [`POST ${REG}/registrations`]: cf({ domain_name: 'bakery.com', state, completed: state === 'succeeded' }, status),
    });
    expect(await c.buy('a1', 'bakery.com', { price: '10.44', currency: 'USD' }, true)).toBe(state);
    expect(calls.find(x => x.key.endsWith('/registrations')).body).toEqual({ domain_name: 'bakery.com', years: 1, auto_renew: true });
  }
});

it('57. buy refused: no contact / no payment / anything else → their codes, never the body', async () => {
  const refuse = message => json({ success: false, errors: [{ code: 10000, message }], result: null }, 400);
  for (const [message, code] of [
    ['No registrant contact provided and no default address book entry found for this account.', 'no-contact'],
    ['You must accept the Domain Registration Agreement', 'no-contact'],
    ['No valid default payment method on the billing profile', 'no-payment'],
    ['Something else entirely', 'registrar-refused'],
  ]) {
    const { c } = client({
      [`POST ${REG}/domain-check`]: cf({ domains: [{ name: 'bakery.com', registrable: true, tier: 'standard', pricing: price('10.44') }] }),
      [`POST ${REG}/registrations`]: refuse(message),
    });
    const e = await c.buy('a1', 'bakery.com', { price: '10.44', currency: 'USD' }, false).then(() => null, x => x);
    expect(e).toMatchObject({ code });
    expect(e.message).not.toContain(message);
  }
});

it('54–56. registration: the workflow state, the action and the masked address it was sent to; unknown → null', async () => {
  const { c } = client({ [`GET ${REG}/registrations/bakery.com/registration-status`]: cf({ state: 'action_required', completed: false,
    context: { action: 'registrant_email_confirmation_pending', confirmation_sent_to: 'a***@example.com', domain_name: 'bakery.com' } }) });
  expect(await c.registration('a1', 'bakery.com')).toEqual({ state: 'action_required', action: 'registrant_email_confirmation_pending', sentTo: 'a***@example.com' });
  const { c: gone } = client({ [`GET ${REG}/registrations/bakery.com/registration-status`]: cf(null, 404) });
  expect(await gone.registration('a1', 'bakery.com')).toBe(null);
});

it('53/58/59. attach: zone not active yet → pending (no PUT); active → apex + www on the Worker (www failing is ignored); records → domain-conflict', async () => {
  const { c: early, calls: none } = client({ 'GET /zones': cf([{ id: 'z1', name: 'bakery.com', status: 'pending' }]) });
  expect(await early.attach('a1', 'my-site', 'bakery.com')).toBe('pending');
  expect(none.some(x => x.key.startsWith('PUT'))).toBe(false);
  const { c: missing } = client({ 'GET /zones': cf([]) });
  expect(await missing.attach('a1', 'my-site', 'bakery.com')).toBe('pending');

  const puts = [];
  const { c } = client({
    'GET /zones': cf([{ id: 'z1', name: 'bakery.com', status: 'active' }]),
    'PUT /accounts/a1/workers/domains': ({ body }) => { puts.push(body); return body.hostname.startsWith('www.') ? cf(null, 409) : cf({ id: 'd1', ...body }); },
  });
  expect(await c.attach('a1', 'my-site', 'bakery.com')).toBe('attached');
  expect(puts).toEqual([{ hostname: 'bakery.com', service: 'my-site', zone_id: 'z1' }, { hostname: 'www.bakery.com', service: 'my-site', zone_id: 'z1' }]);

  const { c: taken } = client({ 'GET /zones': cf([{ id: 'z1', status: 'active' }]), 'PUT /accounts/a1/workers/domains': cf(null, 409) });
  await expect(taken.attach('a1', 'my-site', 'bakery.com')).rejects.toMatchObject({ code: 'domain-conflict' });
});

it('61/62. attached: true only when the hostname serves THIS Worker', async () => {
  const { c, calls } = client({ 'GET /accounts/a1/workers/domains': cf([{ hostname: 'bakery.com', service: 'my-site' }]) });
  expect(await c.attached('a1', 'my-site', 'bakery.com')).toBe(true);
  expect(calls[0].key).toBe('GET /accounts/a1/workers/domains?hostname=bakery.com&service=my-site');
  const { c: other } = client({ 'GET /accounts/a1/workers/domains': cf([{ hostname: 'bakery.com', service: 'someone-else' }]) });
  expect(await other.attached('a1', 'my-site', 'bakery.com')).toBe(false);
});

it('live check 6: the sandbox uses the Registrar sandbox paths and scopes', async () => {
  const m = memory(); const seen = [];
  const c = createCloudflare({ fetch: async url => { seen.push(url); return cf({ domains: [] }); }, store: m.store, crypto: m.crypto,
    windows: windowsThat().windows, clientId: 'cid', sandbox: true });
  await c.search('a1', 'bakery');
  expect(seen[0]).toBe(`${API}/accounts/a1/registrar-sandbox/domain-search?q=bakery&limit=6`);
});

// ── Final review (2026-10-16): each failed before its fix ─────────────────────────────────────────────────────────────
it('review 4. a refresh answer without a refresh_token keeps the stored one (RFC 6749 §6 lets the server omit it)', async () => {
  const { c, m } = client({ 'POST oauth/token': json({ access_token: 'acc2', expires_in: 3600 }), 'GET /x': cf({}) }, { blob: { ...SIGNED_IN, expiresAt: 0 } });
  await c.call('/x');
  expect(m.blob()).toMatchObject({ access: 'acc2', refresh: 'ref' });
});

it('review 10. a caller holding an expired blob never refreshes with an already-rotated token: the flight re-reads the store first', async () => {
  const m = memory({ ...SIGNED_IN, expiresAt: 0 });
  let reads = 0; const calls = [];
  const store = { ...m.store, read: async () => { reads += 1; const b = await m.store.read();
    if (reads === 2) await m.store.write(`enc:${JSON.stringify({ ...SIGNED_IN, access: 'fresh', refresh: 'rotated', expiresAt: Date.now() + 3_600_000 })}`); // another caller saved meanwhile
    return reads === 2 ? m.store.read() : b; } };
  const fetch = async (url, init = {}) => { calls.push(`${init.method ?? 'GET'} ${url.replace(OAUTH, 'oauth').replace(API, '')}`); return cf({ auth: init.headers?.authorization }); };
  const c = createCloudflare({ fetch, store, crypto: m.crypto, windows: windowsThat().windows, clientId: 'cid' });
  expect((await c.call('/x')).body.result.auth).toBe('Bearer fresh');
  expect(calls).toEqual(['GET /x']); // no POST oauth/token with the used refresh token
});

it('review 3b. bought but the answer was lost: the re-check says taken, yet THIS account has its registration → its state, not "taken"', async () => {
  const taken = cf({ domains: [{ name: 'bakery.com', registrable: false, reason: 'domain_unavailable' }] });
  const { c } = client({ [`POST ${REG}/domain-check`]: taken,
    [`GET ${REG}/registrations/bakery.com/registration-status`]: cf({ state: 'succeeded', completed: true, context: {} }) });
  expect(await c.buy('a1', 'bakery.com', { price: '10.44', currency: 'USD' }, false)).toBe('succeeded');
  const { c: theirs, calls } = client({ [`POST ${REG}/domain-check`]: taken, [`GET ${REG}/registrations/bakery.com/registration-status`]: cf(null, 404) });
  await expect(theirs.buy('a1', 'bakery.com', { price: '10.44', currency: 'USD' }, false)).rejects.toMatchObject({ code: 'domain-taken' });
  expect(calls.some(x => x.key.endsWith('/registrations'))).toBe(false); // never a second POST
});

it('review 7. an attach refused for another reason ("does not exist") is not a DNS conflict', async () => {
  const { c } = client({ 'GET /zones': cf([{ id: 'z1', status: 'active' }]),
    'PUT /accounts/a1/workers/domains': json({ success: false, errors: [{ code: 10007, message: 'This Worker does not exist on your account.' }], result: null }, 404) });
  await expect(c.attach('a1', 'my-site', 'bakery.com')).rejects.toMatchObject({ code: 'cloudflare', status: 404 });
  const { c: dns } = client({ 'GET /zones': cf([{ id: 'z1', status: 'active' }]),
    'PUT /accounts/a1/workers/domains': json({ success: false, errors: [{ code: 100117, message: 'Hostname already has externally managed DNS records' }], result: null }, 400) });
  await expect(dns.attach('a1', 'my-site', 'bakery.com')).rejects.toMatchObject({ code: 'domain-conflict' });
});

it('review 8. workers.dev "none" only on a not-found answer (404 or code 10007); an empty 200 never leads to an account-wide rename', async () => {
  const { c } = client({ 'GET /accounts/a1/workers/subdomain': json({ success: false, errors: [{ code: 10007, message: 'not found' }], result: null }, 400) });
  expect(await c.subdomain('a1')).toBe(null);
  const { c: empty } = client({ 'GET /accounts/a1/workers/subdomain': cf({}) });
  await expect(empty.subdomain('a1')).rejects.toMatchObject({ code: 'cloudflare' });
});

it('review 13/5. prices arrive as strings whatever Cloudflare sends; a zone in the account that is not active yet is "inactive", never "Use it"', async () => {
  const { c } = client({
    [`GET ${REG}/domain-search`]: cf({ domains: [{ name: 'bakery.dev', registrable: true, tier: 'standard', pricing: { currency: 'USD', registration_cost: 12.2, renewal_cost: 14 } }] }),
    [`POST ${REG}/domain-check`]: cf({ domains: [{ name: 'bakery.com', registrable: false, reason: 'domain_unavailable' }] }),
    'GET /zones': cf([{ id: 'z1', name: 'bakery.com', status: 'pending' }]),
  });
  expect(await c.search('a1', 'bakery.com')).toEqual([{ name: 'bakery.com', kind: 'inactive' },
    { name: 'bakery.dev', kind: 'buy', price: '12.2', renewal: '14', currency: 'USD' }]);
});

// Owner's client form (2026-10-16) lists no "offline access": a client without it gets invalid_scope for the whole request.
it('live 2. invalid_scope with offline_access requested → one retry without it (signed in, no refresh token); other OAuth errors are not a silent cancel', async () => {
  const asked = [];
  const w = windowsThat(p => { asked.push(p.get('scope')); return p.get('scope').includes('offline_access')
    ? `${REDIRECT_URI}?error=invalid_scope&error_description=raw&state=${p.get('state')}` : `${REDIRECT_URI}?code=c&state=${p.get('state')}`; });
  const { c, m } = client({ 'POST oauth/token': json({ access_token: 'acc', expires_in: 3600 }), 'GET /accounts': cf([{ id: 'a1', name: 'Mine' }]) },
    { blob: null, windows: w.windows });
  await c.connect();
  expect(asked).toEqual([SCOPES.join(' '), SCOPES.filter(s => s !== 'offline_access').join(' ')]);
  expect(m.blob()).toMatchObject({ access: 'acc', refresh: null, account: 'a1' });

  const refused = windowsThat(p => `${REDIRECT_URI}?error=unauthorized_client&error_description=raw&state=${p.get('state')}`);
  const { c: bad } = client({}, { blob: null, windows: refused.windows });
  const e = await bad.connect().then(() => null, x => x);
  expect(e).toMatchObject({ code: 'cloudflare', oauthError: 'unauthorized_client' });
  expect(e.message).not.toContain('raw');
  const denied = windowsThat(p => `${REDIRECT_URI}?error=access_denied&state=${p.get('state')}`);
  const { c: no } = client({}, { blob: null, windows: denied.windows });
  await expect(no.connect()).rejects.toMatchObject({ code: 'cancelled' }); // the user's Deny stays a choice
});

it('live 2. the scope ids are the ones the owner\'s client accepts (probed on /oauth2/auth 2026-10-16) — one unknown id breaks every sign-in', () => {
  expect(SCOPES).toEqual(['account-settings.read', 'workers-scripts.admin', 'workers-scripts.edit', 'workers-scripts.metadata_read', 'zone.read',
    'registrar-domains.read', 'registrar-domains.admin', 'offline_access']);
});

// ── Unpublish (ledger U2/U5/U6) ───────────────────────────────────────────────────────────────────────────────────────
it('U2/U6. unpublish: the Worker\'s custom-domain bindings (best effort), then the Worker (force) — already gone is fine', async () => {
  const { c, calls } = client({
    'GET /accounts/a1/workers/domains': cf([{ id: 'd1', hostname: 'bakery.com', service: 'my-site' }, { id: 'd2', hostname: 'www.bakery.com', service: 'my-site' }]),
    'DELETE /accounts/a1/workers/domains/d1': cf(null),
    'DELETE /accounts/a1/workers/domains/d2': cf(null, 403), // not allowed / already moved: the Worker delete still takes the site offline
    'DELETE /accounts/a1/workers/scripts/my-site': cf(null),
  });
  await c.unpublish('a1', 'my-site');
  expect(calls.map(x => x.key)).toEqual(['GET /accounts/a1/workers/domains?service=my-site', 'DELETE /accounts/a1/workers/domains/d1',
    'DELETE /accounts/a1/workers/domains/d2', 'DELETE /accounts/a1/workers/scripts/my-site?force=true']);
  const { c: gone } = client({ 'GET /accounts/a1/workers/domains': cf([]), 'DELETE /accounts/a1/workers/scripts/my-site': cf(null, 404) });
  await expect(gone.unpublish('a1', 'my-site')).resolves.toBeUndefined();
});

it('U5. unpublish refused (the Worker delete) → its code; nothing is claimed offline', async () => {
  const { c } = client({ 'GET /accounts/a1/workers/domains': cf([]), 'DELETE /accounts/a1/workers/scripts/my-site': cf(null, 403) });
  await expect(c.unpublish('a1', 'my-site')).rejects.toMatchObject({ code: 'cloudflare', status: 403 });
});

it('a read gives up after 30 s (a hung GET must not hold the project lane — encodeError: offline); writes are never cut', async () => {
  const { c, calls } = client({ [`GET /accounts/a1/workers/scripts`]: cf([]), [`POST /accounts/a1/workers/scripts/w/subdomain`]: cf({}) });
  await c.scripts('a1'); await c.enableWorkersDev('a1', 'w');
  expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  expect(calls[1].init.signal).toBeUndefined();
});

// 2026-11-09 main-process dialog `assert(controller != null)`: undici's fetch arms its abort listener before its own
// controller exists, so a deadline firing after fetch()'s setup threw synchronously is an uncaught AssertionError.
it('a read or a Live probe whose fetch() setup threw is never aborted by its deadline afterwards', async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(1)); // the 30 s / 5 s deadlines, compressed
  const m = memory(); let threw = 0;
  // undici asserts the dispatcher after arming its abort listener: the real fetch() throws synchronously
  const throwing = (url, init) => { try { return fetch(url, { ...init, dispatcher: 0 }); } catch (e) { threw += 1; throw e; } };
  const c = createCloudflare({ fetch: throwing, store: m.store, crypto: m.crypto, windows: windowsThat().windows, clientId: 'cid' });
  try {
    expect(await uncaughtDuring(async () => {
      await Promise.allSettled([c.scripts('a1'), (async () => c.reachable('http://127.0.0.1:65000/', 'h'))()]);
      await new Promise(r => setTimeout(r, 20)); // both deadlines fire
    })).toEqual([]);
    expect(threw).toBe(2); // both setups really threw
  } finally { vi.restoreAllMocks(); }
});
