import { localFetch } from '@/utils/sqLocalBase';
import { writeLocalFile } from '@/utils/localElementSource';
import { CONTACT_FUNCTION, fillFirmaMarkers, type Firma } from './ares';

const PATCH_FILES = [
  'src/components/CzNav.astro',
  'src/components/CzHodiny.astro',
  'src/components/CzKontakt.astro',
  'src/components/CzLegalFooter.astro',
  'src/components/CzOchrana.astro',
];

async function readText(file: string): Promise<string | null> {
  const response = await localFetch(`/__sq/local/file?file=${encodeURIComponent(file)}&probe=1`);
  if (!response.ok || response.headers.get('X-Sq-Missing') === '1') return null;
  return response.text();
}

/** Writes firma.json, patches Czech sections already in the project, and adds the contact endpoint. */
export async function saveFirma(firma: Firma): Promise<void> {
  await writeLocalFile('src/data/firma.json', `${JSON.stringify(firma, null, 2)}\n`);
  for (const file of PATCH_FILES) {
    const current = await readText(file);
    if (current === null) continue;
    const next = fillFirmaMarkers(current, firma);
    if (next !== current) await writeLocalFile(file, next);
  }
  await writeLocalFile('functions/api/kontakt.js', CONTACT_FUNCTION);
}
