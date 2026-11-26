// One contact handler for the one-click Cloudflare Worker and for Cloudflare Pages.
// The browser saves the settings; publish embeds them in the Worker. Nothing here
// reads the disk.

function httpsOnly(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function emailOf(value) {
  const email = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

/** Drop anything that is not an https webhook, an email address, or a Turnstile key. */
export function sanitizeKontakt(raw) {
  return {
    webhook: httpsOnly(raw?.webhook),
    email: emailOf(raw?.email),
    turnstileSiteKey: String(raw?.turnstileSiteKey || '').trim().slice(0, 200),
    turnstileSecret: String(raw?.turnstileSecret || '').trim().slice(0, 200),
  };
}

/** POST /api/kontakt. Honeypot first, then Turnstile when a secret is set, then the webhook. */
export async function handleKontakt(request, config, fetchImpl = globalThis.fetch) {
  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'Použijte formulář na webu.' }, { status: 405 });
  }
  const form = await request.formData();
  if (String(form.get('website') || '').trim()) return Response.json({ ok: true });
  const name = String(form.get('jmeno') || '').trim();
  const email = String(form.get('email') || '').trim();
  const message = String(form.get('zprava') || '').trim();
  if (!name || !emailOf(email) || !message || message.length > 5000) {
    return Response.json({ ok: false, error: 'Neplatná zpráva' }, { status: 400 });
  }
  if (config.turnstileSecret) {
    const token = String(form.get('cf-turnstile-response') || '');
    const check = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: config.turnstileSecret, response: token }),
    });
    const verdict = await check.json();
    if (!verdict.success) return Response.json({ ok: false, error: 'Ověření selhalo' }, { status: 400 });
  }
  if (!config.webhook) {
    return Response.json({
      ok: false,
      error: 'Formulář ještě nemá kam zprávy posílat.',
      email: config.email || '',
    }, { status: 501 });
  }
  const sent = await fetchImpl(config.webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, message, to: config.email || '', at: new Date().toISOString() }),
  });
  if (!sent.ok) return Response.json({ ok: false, error: 'Odeslání se nezdařilo' }, { status: 502 });
  return Response.json({ ok: true });
}

function embedded(config) {
  const safe = sanitizeKontakt(config);
  return `const CONFIG = ${JSON.stringify({ webhook: safe.webhook, email: safe.email, turnstileSecret: safe.turnstileSecret })};\n${handleKontakt.toString()}\n`;
}

/** Static assets stay on ASSETS. POST /api/kontakt runs the handler with the saved settings. */
export function contactWorkerSource(config) {
  return `${embedded(config)}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/kontakt') return handleKontakt(request, CONFIG);
    return env.ASSETS.fetch(request);
  },
};
`;
}

/** The same handler as a Pages Function, for a project published from the repo. */
export function pagesFunctionSource(config) {
  return `${embedded(config)}
export async function onRequestPost(context) {
  return handleKontakt(context.request, CONFIG);
}
`;
}
