import { describe, expect, it, vi } from 'vitest';
import { contactWorkerSource, handleKontakt, pagesFunctionSource, sanitizeKontakt } from '../kontaktWorker.mjs';

function post(fields: Record<string, string>): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request('https://web.test/api/kontakt', { method: 'POST', body: form });
}

describe('contact handler', () => {
  it('keeps only an https webhook and a real email', () => {
    expect(sanitizeKontakt({ webhook: 'http://insecure.example/hook', email: 'ne', turnstileSiteKey: ' site ', turnstileSecret: '' })).toEqual({
      webhook: '', email: '', turnstileSiteKey: 'site', turnstileSecret: '',
    });
    expect(sanitizeKontakt({ webhook: 'https://hooks.example/in', email: 'ahoj@example.cz', turnstileSiteKey: '', turnstileSecret: '' }).webhook).toBe('https://hooks.example/in');
  });

  it('says the form is not set up, and posts to the webhook with the recipient', async () => {
    const unconfigured = await handleKontakt(post({ jmeno: 'Ana', email: 'ana@example.cz', zprava: 'Dobrý den' }), { webhook: '', email: 'ja@example.cz', turnstileSecret: '' });
    expect(unconfigured.status).toBe(501);
    expect(await unconfigured.json()).toMatchObject({ ok: false, email: 'ja@example.cz' });

    const fetchImpl = vi.fn(async () => new Response('ok'));
    const sent = await handleKontakt(post({ jmeno: 'Ana', email: 'ana@example.cz', zprava: 'Dobrý den' }), {
      webhook: 'https://hooks.example/in', email: 'ja@example.cz', turnstileSecret: '',
    }, fetchImpl as unknown as typeof fetch);
    expect(sent.ok).toBe(true);
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ name: 'Ana', to: 'ja@example.cz' });
  });

  it('ignores a filled honeypot and embeds the handler in the Worker and the Pages function', async () => {
    const quiet = await handleKontakt(post({ jmeno: 'Bot', email: 'bot@example.cz', zprava: 'x', website: 'spam' }), { webhook: 'https://hooks.example/in', email: '', turnstileSecret: '' });
    expect(await quiet.json()).toEqual({ ok: true });
    const worker = contactWorkerSource({ webhook: 'https://hooks.example/in', email: 'ja@example.cz' });
    expect(worker).toContain("pathname === '/api/kontakt'");
    expect(worker).toContain('https://hooks.example/in');
    expect(worker).not.toContain('turnstileSiteKey');
    expect(pagesFunctionSource(null)).toContain('onRequestPost');
  });
});
