// GitHub device flow (D2): public OAuth App client id, no secret, no server. The token is
// encrypted at rest by the injected `crypto` (Electron safeStorage) — never stored plaintext.
// The "Starquix" OAuth App (Device Flow on); env SQ_GITHUB_CLIENT_ID overrides it (e.g. a test app).
import { t } from '../i18n.mjs';
export const CLIENT_ID = process.env.SQ_GITHUB_CLIENT_ID || 'Ov23ligD51hZTM39yEoI';
const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json' };
const fail = (code, message) => Object.assign(new Error(t(message)), { code });

/** Version author: the GitHub identity when signed in (noreply when the email is private). */
export function commitAuthor(user) {
  if (!user) return { name: t('Starquix'), email: 'noreply@starquix.app' };
  return { name: user.name ?? user.login, email: user.email ?? `${user.id}+${user.login}@users.noreply.github.com` };
}

export function createAuth({ fetch = globalThis.fetch, store, crypto, clientId = CLIENT_ID,
  sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  let pending = null;
  async function start() {
    if (!clientId) throw fail('not-configured', 'GitHub sign-in is not configured in this build');
    cancel();
    const r = await fetch('https://github.com/login/device/code', { method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ client_id: clientId, scope: 'repo workflow' }) }); // workflow: push .github/workflows (Pages)
    const d = await r.json();
    if (!r.ok || !d.device_code) throw fail('unavailable', 'GitHub sign-in unavailable');
    const ticket = pending = { cancelled: false };
    const done = (async () => {
      let interval = d.interval * 1000;
      for (;;) {
        await sleep(interval);
        if (ticket.cancelled) throw fail('cancelled', 'Cancelled');
        const p = await (await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: JSON_HEADERS,
          body: JSON.stringify({ client_id: clientId, device_code: d.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) })).json();
        if (p.access_token) { await store.write(crypto.encrypt(p.access_token)); return; }
        if (p.error === 'authorization_pending') continue;
        if (p.error === 'slow_down') { interval += 5000; continue; }
        throw fail(p.error === 'access_denied' ? 'denied' : 'expired', p.error_description ?? p.error);
      }
    })();
    done.catch(() => {}); // the caller awaits it; never an unhandled rejection
    return { userCode: d.user_code, verificationUri: d.verification_uri, done };
  }
  function cancel() { if (pending) pending.cancelled = true; }
  async function token() { const b = await store.read(); return b ? crypto.decrypt(b) : null; }
  async function user() {
    const t = await token(); if (!t) return null;
    const r = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${t}`, accept: 'application/vnd.github+json' } });
    if (r.status === 401) { await store.clear(); throw fail('signed-out', 'Sign in again'); }
    if (!r.ok) throw fail('unavailable', `GitHub answered ${r.status}`);
    const u = await r.json();
    return { login: u.login, name: u.name, email: u.email, avatarUrl: u.avatar_url, id: u.id };
  }
  return { start, cancel, token, user, signOut: () => store.clear() };
}
