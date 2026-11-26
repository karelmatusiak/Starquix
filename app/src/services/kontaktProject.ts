import { localFetch } from '@/utils/sqLocalBase';
import { writeLocalFile } from '@/utils/localElementSource';
import { pagesFunctionSource, sanitizeKontakt, type KontaktConfig } from './kontaktWorker.mjs';

async function readText(file: string): Promise<string | null> {
  const response = await localFetch(`/__sq/local/file?file=${encodeURIComponent(file)}&probe=1`);
  if (!response.ok || response.headers.get('X-Sq-Missing') === '1') return null;
  return response.text();
}

function patchTurnstile(source: string, siteKey: string): string {
  return source.replace(/data-sq-turnstile=(['"])[^'"]*\1/, `data-sq-turnstile='${siteKey.replace(/'/g, '')}'`);
}

export async function loadKontakt(): Promise<KontaktConfig | null> {
  const text = await readText('src/data/kontakt.json');
  if (!text) return null;
  try { return sanitizeKontakt(JSON.parse(text)); } catch { return null; }
}

/** Saves the form settings and the Pages function. One-click publish reads the same file into the Worker. */
export async function saveKontakt(raw: KontaktConfig): Promise<KontaktConfig> {
  const config = sanitizeKontakt(raw);
  await writeLocalFile('src/data/kontakt.json', `${JSON.stringify(config, null, 2)}\n`);
  await writeLocalFile('functions/api/kontakt.js', pagesFunctionSource(config));
  const form = await readText('src/components/CzKontakt.astro');
  if (form) {
    const next = patchTurnstile(form, config.turnstileSiteKey);
    if (next !== form) await writeLocalFile('src/components/CzKontakt.astro', next);
  }
  return config;
}
