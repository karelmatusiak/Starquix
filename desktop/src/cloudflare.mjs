// Cloudflare REST + its sign-in window — docs/plans/2026-10-16-cloudflare-one-click-design.md.
// OAuth Authorization Code + PKCE as a PUBLIC client: client id only, no secret, no server. The tokens are encrypted at
// rest by the injected `crypto` (Electron safeStorage) and never leave main. No retries but one refresh on a 401.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { contactWorkerSource } from '../../app/src/services/kontaktWorker.mjs';
import { abortSafe } from './abort-safe.mjs';
import { t } from './i18n.mjs';

// The owner's "Starquix" Cloudflare OAuth client (public id, PKCE, no secret — ledger 60); env SQ_CLOUDFLARE_CLIENT_ID
// overrides. Private until its client URL is verified and it is made public: only members of the owner's account can sign in.
export const CLOUDFLARE_CLIENT_ID = process.env.SQ_CLOUDFLARE_CLIENT_ID || 'c173698d8022b2811b61c83b6d664730';
/** Registered on that client; never loaded — the sign-in window stops at it (a leaked code is useless without the verifier). */
export const REDIRECT_URI = 'http://127.0.0.1/oauth/cloudflare';
// Scope ids as the client form registers them (live 2026-10-16): Workers → Admin / Edit / Metadata Read =
// workers-scripts.admin / .edit / .metadata_read. The assets upload session refuses Edit (403 "No access to the specified
// resource") and accepts Admin; workers-scripts.write/.read exist in /oauth/scopes but the client form does not offer them.
export const SCOPES = ['account-settings.read', 'workers-scripts.admin', 'workers-scripts.edit', 'workers-scripts.metadata_read', 'zone.read',
  'registrar-domains.read', 'registrar-domains.admin', 'offline_access'];
const SANDBOX_SCOPES = SCOPES.map(s => s.replace('registrar-domains.', 'registrar-sandbox-domains.'));
const OAUTH = 'https://dash.cloudflare.com/oauth2';
const EARLY_MS = 60_000; // ledger 7: refresh a minute before expiry
const GET_MS = 30_000; // a hung read must not hold the project's op lane (the poll is a GET)
const fail = (code, message, extra) => Object.assign(new Error(t(message)), { code }, extra);
// Static assets plus a module: Astro's 404.html answers unknown pages, and the module answers POST /api/kontakt.
const ASSET_CONFIG = { html_handling: 'auto-trailing-slash', not_found_handling: '404-page' };
const COMPATIBILITY_DATE = '2026-09-01';
const seg = v => encodeURIComponent(v);
const send = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const suffix = () => randomUUID().slice(0, 4);
/** What "Live" compares (ledger 20/61): the page as uploaded vs as served. */
export const pageHash = bytes => createHash('sha256').update(bytes).digest('hex');

const FOLD = { ß: 'ss', æ: 'ae', ø: 'o', œ: 'oe', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };
/** A Worker name = its workers.dev DNS label: [a-z0-9-], no edge dashes, ≤ 58 chars (room for "-xxxx"), never empty. */
export function siteSlug(name) {
  const s = String(name).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[ßæøœłđðþı]/g, c => FOLD[c])
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 58).replace(/-+$/, '');
  return s || 'starquix-site';
}
/** Ledger 16/17: the slug, or slug-xxxx — never a name the account already has (a PUT would overwrite that Worker). */
export function freeName(taken, slug) {
  for (let i = 0; i < 5; i++) { const name = i ? `${slug}-${suffix()}` : slug; if (!taken.has(name)) return name; }
  throw fail('cloudflare', 'No free Worker name');
}

/** The code on our redirect: undefined = not the redirect (keep browsing); null = denied / no or a foreign state / no code. */
export function codeFromRedirect(url, state) {
  let u; try { u = new URL(url); } catch { return undefined; }
  const ours = new URL(REDIRECT_URI);
  if (u.protocol !== ours.protocol || u.hostname !== ours.hostname || u.pathname !== ours.pathname) return undefined; // any loopback port
  if (!state || u.searchParams.get('state') !== state) return null; // fail closed (ledger 3)
  return u.searchParams.get('code') || null;
}

/** `windows.open(url, { onNavigate })` resolves when the window closes; `windows.clear()` signs the window out (main.mjs). */
export function createCloudflare({ fetch: rawFetch = globalThis.fetch, store, crypto, windows, clientId = CLOUDFLARE_CLIENT_ID,
  api = 'https://api.cloudflare.com/client/v4', oauth = OAUTH, sandbox = false, now = Date.now }) {
  const fetch = abortSafe(rawFetch); // the read and Live deadlines reach undici only once fetch() has returned
  const scopes = sandbox ? SANDBOX_SCOPES : SCOPES;
  /** { access, refresh, expiresAt, accounts: [{ id, name }], account: id | null } — null when absent or unreadable. */
  async function load() {
    const b = await store.read(); if (!b) return null;
    try { return JSON.parse(crypto.decrypt(b)); } catch { return null; }
  }
  const save = blob => store.write(crypto.encrypt(JSON.stringify(blob)));
  const connected = async () => !!(await load());

  async function tokens(params, refused) {
    const r = await fetch(`${oauth}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok || !b.access_token) throw fail(refused(r.status), 'Cloudflare refused the sign-in', { status: r.status });
    // RFC 6749 §6: a refresh answer may omit refresh_token — the one we sent stays valid then.
    return { access: b.access_token, refresh: b.refresh_token ?? params.refresh_token ?? null, expiresAt: now() + (b.expires_in ?? 3600) * 1000 };
  }
  // Refresh tokens are one-time (rotated): one refresh at a time, and a caller holding an already-replaced token joins it.
  let refreshing = null;
  async function fresh(stale) {
    const blob = await load();
    if (!blob) throw fail('cloudflare-signed-out', 'Connect Cloudflare');
    if (stale ? blob.access !== stale : blob.expiresAt - EARLY_MS > now()) return blob;
    if (!blob.refresh) { await store.clear(); throw fail('cloudflare-signed-out', 'Connect Cloudflare again'); }
    refreshing ??= (async () => {
      const current = await load(); // another caller may have refreshed between our read and this flight
      if (current && current.refresh !== blob.refresh) return current;
      try {
        const next = { ...blob, ...await tokens({ grant_type: 'refresh_token', refresh_token: blob.refresh, client_id: clientId },
          status => (status === 400 || status === 401 ? 'cloudflare-signed-out' : 'cloudflare')) };
        await save(next); return next;
      } catch (e) { if (e.code === 'cloudflare-signed-out') await store.clear(); throw e; } // ledger 8 (offline keeps it)
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  /** Bearer call; `allow` = statuses answered instead of thrown; `bearer` = another credential (the upload jwt, no refresh). */
  async function call(pathname, init = {}, { allow = [], bearer } = {}) {
    let blob = bearer ? null : await fresh();
    for (let retried = false; ; retried = true) {
      const r = await fetch(`${api}${pathname}`, { signal: init.method ? undefined : AbortSignal.timeout(GET_MS), ...init,
        headers: { authorization: `Bearer ${bearer ?? blob.access}`, ...init.headers } });
      const body = await r.json().catch(() => ({}));
      if (r.ok || allow.includes(r.status)) return { status: r.status, body };
      if (r.status === 401 && !bearer && !retried) { blob = await fresh(blob.access); continue; } // ledger 7
      if (r.status === 401 && !bearer) throw fail('cloudflare-signed-out', 'Connect Cloudflare again');
      if (r.status === 429) throw fail('rate-limited', 'Cloudflare is busy');
      // Never the body (OperationNotice rule); `errors` stays in main for the Registrar mapping (encodeError never forwards it).
      throw fail('cloudflare', `Cloudflare answered ${r.status}`, { status: r.status, errors: body.errors ?? [] });
    }
  }
  const listAccounts = async access => ((await call('/accounts?per_page=50', {}, { bearer: access })).body.result ?? [])
    .map(a => ({ id: a.id, name: a.name }));

  /** One authorize round in the window → { code, verifier } | { error, description } (our state only) | {} (closed / foreign). */
  async function authorize(scope) {
    const verifier = randomBytes(32).toString('base64url'); const state = randomUUID();
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI, scope: scope.join(' '),
      state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    let got = {};
    await windows.open(`${oauth}/auth?${q}`, { onNavigate: url => {
      const code = codeFromRedirect(url, state);
      if (code === undefined) return false; // the login / consent pages
      const p = new URL(url).searchParams;
      got = code ? { code, verifier } : p.get('state') === state && p.get('error') ? { error: p.get('error'), description: p.get('error_description') } : {};
      return true; // our redirect: main stops it there and closes the window
    } });
    return got;
  }
  async function connect() {
    if (!clientId) throw fail('not-configured', 'Cloudflare sign-in is not configured in this build');
    let r = await authorize(scopes);
    // A client registered without offline_access (the dashboard form does not list it) refuses the WHOLE request:
    // once more without it — signed in, just no refresh token (live check 2).
    if (r.error === 'invalid_scope' && scopes.includes('offline_access')) r = await authorize(scopes.filter(s => s !== 'offline_access'));
    if (r.error && r.error !== 'access_denied') { // never a silent cancel: the reason goes to main's log, the user gets a curated notice
      console.error('[cloudflare sign-in]', r.error, r.description ?? '');
      throw fail('cloudflare', 'Cloudflare refused the sign-in request', { oauthError: r.error });
    }
    if (!r.code) throw fail('cancelled', 'Cancelled'); // closed, denied or a foreign state (ledger 2/3)
    const t = await tokens({ grant_type: 'authorization_code', code: r.code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: r.verifier },
      () => 'cloudflare'); // ledger 4: an expired code is not a sign-out
    const accounts = await listAccounts(t.access);
    if (!accounts.length) throw fail('no-account', 'No Cloudflare account was allowed'); // ledger 9
    await save({ ...t, accounts, account: accounts.length === 1 ? accounts[0].id : null }); // ledger 10/11
  }
  const accounts = async () => (await load())?.accounts ?? [];
  async function account() {
    const blob = await load();
    return blob?.accounts.find(a => a.id === blob.account) ?? null;
  }
  async function chooseAccount(id) {
    const blob = await load();
    if (!blob) throw fail('cloudflare-signed-out', 'Connect Cloudflare');
    if (!blob.accounts.some(a => a.id === id)) throw fail('invalid', 'Unknown Cloudflare account');
    await save({ ...blob, account: id });
  }
  // ── Workers static assets (C2) ──
  const scripts = async a => ((await call(`/accounts/${seg(a)}/workers/scripts`)).body.result ?? []).map(w => ({ name: w.id, tag: w.tag }));
  /** files: [{ path: '/index.html', bytes, type }] → manifest → buckets (upload jwt) → Worker with assets + /api/kontakt. */
  async function upload(a, name, files, contact = null) {
    const byHash = new Map(); const manifest = {};
    const base64 = f => Buffer.from(f.bytes).toString('base64'); // per bucket, never the whole site at once
    for (const f of files) {
      const hash = createHash('sha256').update(base64(f) + extname(f.path).slice(1)).digest('hex').slice(0, 32);
      manifest[f.path] = { hash, size: f.bytes.length }; byHash.set(hash, f);
    }
    const session = (await call(`/accounts/${seg(a)}/workers/scripts/${seg(name)}/assets-upload-session`, send('POST', { manifest }))).body.result;
    let done = session.buckets?.length ? null : session.jwt; // nothing new: the session jwt already completes
    for (const bucket of session.buckets ?? []) {
      const form = new FormData();
      for (const hash of bucket) form.append(hash, new File([base64(byHash.get(hash))], hash, { type: byHash.get(hash).type }));
      const { body } = await call(`/accounts/${seg(a)}/workers/assets/upload?base64=true`, { method: 'POST', body: form }, { bearer: session.jwt });
      done = body.result?.jwt ?? done; // only the last bucket answers the completion token
    }
    if (!done) throw fail('cloudflare', 'Cloudflare did not complete the upload');
    const form = new FormData();
    form.set('metadata', JSON.stringify({
      main_module: 'worker.js',
      assets: { jwt: done, config: ASSET_CONFIG },
      bindings: [{ type: 'assets', name: 'ASSETS' }],
      compatibility_date: COMPATIBILITY_DATE,
    }));
    form.set('worker.js', new File([contactWorkerSource(contact)], 'worker.js', { type: 'application/javascript+module' }));
    return (await call(`/accounts/${seg(a)}/workers/scripts/${seg(name)}`, { method: 'PUT', body: form })).body.result?.tag ?? null;
  }
  const enableWorkersDev = (a, name) => call(`/accounts/${seg(a)}/workers/scripts/${seg(name)}/subdomain`, send('POST', { enabled: true, previews_enabled: false }));
  /** The account's <sub>.workers.dev; null = none yet (a new account, ledger 19): only a not-found answer (404 / code
   *  10007, as wrangler reads it) — an empty answer must never lead to createSubdomain (an account-wide rename). */
  async function subdomain(a) {
    try {
      const { status, body } = await call(`/accounts/${seg(a)}/workers/subdomain`, {}, { allow: [404] });
      if (status === 404) return null;
      if (!body.result?.subdomain) throw fail('cloudflare', 'Cloudflare answered without a workers.dev subdomain', { status });
      return body.result.subdomain;
    } catch (e) { if (e.errors?.some(x => x.code === 10007)) return null; throw e; }
  }
  /** Globally unique: a refused name (taken) → slug-xxxx, three tries. Never from the account name (it may be an email). */
  async function createSubdomain(a, slug) {
    let last;
    for (let i = 0; i < 3; i++) {
      const want = i ? `${slug}-${suffix()}` : slug;
      try { await call(`/accounts/${seg(a)}/workers/subdomain`, send('PUT', { subdomain: want })); return want; }
      catch (e) { if (e.code !== 'cloudflare' || e.status >= 500) throw e; last = e; }
    }
    throw last;
  }
  /** Ledger 20/61: "Live" = the address serves the exact page we uploaded (redirects followed, body hash). A Cloudflare
   *  404 (route off, domain not on the Worker), another site, a TLS or DNS failure = not yet. */
  const reachable = (url, hash) => fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5000) })
    .then(async r => r.ok && pageHash(Buffer.from(await r.arrayBuffer())) === hash, () => false);
  // ── Registrar + custom domains (ledger 50–59) ──
  const registrar = a => `/accounts/${seg(a)}/${sandbox ? 'registrar-sandbox' : 'registrar'}`;
  /** A search row: buy (standard, registrable) · taken · dashboard (premium / not via the API) · unavailable · owned (zone in the account). */
  const rowOf = d => (d.registrable && d.tier !== 'premium'
    ? { name: d.name, kind: 'buy', price: String(d.pricing.registration_cost), renewal: String(d.pricing.renewal_cost), currency: String(d.pricing.currency) }
    : { name: d.name, kind: d.reason === 'domain_unavailable' ? 'taken'
      : d.tier === 'premium' || ['domain_premium', 'extension_not_supported_via_api'].includes(d.reason) ? 'dashboard' : 'unavailable' });
  const check = async (a, d) => (await call(`${registrar(a)}/domain-check`, send('POST', { domains: [d] }))).body.result?.domains?.find(x => x.name === d) ?? null;
  const zone = async (a, d) => (await call(`/zones?${new URLSearchParams({ name: d, 'account.id': a })}`)).body.result?.[0] ?? null;
  /** Ledger 50/64: suggestions (cached) + the typed name checked in real time + "already yours" first. */
  async function search(a, q) {
    const exact = q.includes('.') && !q.includes(' '); // keywords ("acme corp") are only searched
    const [found, checked, owned] = await Promise.all([
      call(`${registrar(a)}/domain-search?${new URLSearchParams({ q, limit: '6' })}`).then(r => r.body.result?.domains ?? []),
      exact ? check(a, q) : null, exact ? zone(a, q) : null]);
    // A zone added by hand but never activated (nameservers not switched) would stay "Setting up…" forever: say so instead.
    const mine = owned && { name: q, kind: owned.status === 'active' ? 'owned' : 'inactive' };
    return [...(mine ? [mine] : checked ? [rowOf(checked)] : []), ...found.filter(d => d.name !== q).map(rowOf)];
  }
  /** C8: the charge is bound to the price the user saw — re-checked here, never re-quoted silently. Returns the workflow state. */
  async function buy(a, d, quote, autoRenew) {
    const live = await check(a, d); const row = live && rowOf(live);
    if (row?.kind !== 'buy') {
      // Review 3b: registered a moment ago but the answer was lost (offline / 5xx) → it is THIS account's: its state, no 2nd POST.
      const mine = await registration(a, d);
      if (mine) return mine.state;
      throw fail('domain-taken', 'That domain is not available');
    }
    const { price, currency } = row;
    if (Number(price) !== Number(quote.price) || currency !== quote.currency) throw fail('price-changed', 'The price changed', { price, currency });
    try {
      return (await call(`${registrar(a)}/registrations`, send('POST', { domain_name: d, years: 1, auto_renew: !!autoRenew }))).body.result?.state ?? 'in_progress';
    } catch (e) {
      if (e.code !== 'cloudflare' || e.status >= 500) throw e;
      // Ledger 57: Cloudflare's text decides the curated notice (only the contact message is documented — INFERRED otherwise).
      const text = (e.errors ?? []).map(x => x.message).join(' ');
      const code = /registrant contact|address book|agreement/i.test(text) ? 'no-contact' : /payment|billing/i.test(text) ? 'no-payment' : 'registrar-refused';
      throw fail(code, 'Cloudflare did not complete the purchase', { status: e.status });
    }
  }
  async function registration(a, d) {
    const { status, body } = await call(`${registrar(a)}/registrations/${seg(d)}/registration-status`, {}, { allow: [404] });
    const r = status === 404 ? null : body.result;
    return r ? { state: r.state, action: r.context?.action ?? null, sentTo: r.context?.confirmation_sent_to ?? null } : null;
  }
  /** Ledger 53/58/59: the zone must be active first; apex + www point at the Worker (Cloudflare adds DNS + the certificate). */
  async function attach(a, worker, d) {
    const z = await zone(a, d);
    if (z?.status !== 'active') return 'pending';
    const put = hostname => call(`/accounts/${seg(a)}/workers/domains`, send('PUT', { hostname, service: worker, zone_id: z.id }));
    try { await put(d); } catch (e) {
      const text = (e.errors ?? []).map(x => x.message).join(' ');
      if (e.code === 'cloudflare' && (e.status === 409 || /already (exists|has)|dns record|conflict/i.test(text))) throw fail('domain-conflict', 'The domain already points somewhere else');
      throw e;
    }
    await put(`www.${d}`).catch(() => {}); // the apex is the site; www is a convenience
    return 'attached';
  }
  const attached = async (a, worker, d) => ((await call(`/accounts/${seg(a)}/workers/domains?${new URLSearchParams({ hostname: d, service: worker })}`))
    .body.result ?? []).some(x => x.hostname === d && x.service === worker);
  /** Unpublish (ledger U2/U6): this Worker's custom-domain bindings first (best effort — deleting the Worker takes the site
   *  offline anyway), then the Worker; already gone = done. The domain registration is never touched (U7). */
  async function unpublish(a, worker) {
    const bound = (await call(`/accounts/${seg(a)}/workers/domains?${new URLSearchParams({ service: worker })}`).catch(() => null))?.body.result ?? [];
    for (const d of bound.filter(x => x.service === worker)) await call(`/accounts/${seg(a)}/workers/domains/${seg(d.id)}`, { method: 'DELETE' }).catch(() => {});
    await call(`/accounts/${seg(a)}/workers/scripts/${seg(worker)}?force=true`, { method: 'DELETE' }, { allow: [404] });
  }
  async function signOut() {
    const blob = await load();
    if (blob?.refresh) await fetch(`${oauth}/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: blob.refresh, client_id: clientId }) }).catch(() => {}); // ledger 14: best effort
    await store.clear(); await windows.clear();
  }
  return { connected, connect, accounts, account, chooseAccount, call, signOut,
    scripts, upload, enableWorkersDev, subdomain, createSubdomain, reachable, search, buy, registration, attach, attached, unpublish };
}
