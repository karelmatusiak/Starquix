// Electron main-process catalog. Same file the editor bundles (`app/src/i18n/cs.json`).
import { readFileSync } from 'node:fs';
import { createT } from '../../i18n/translate.mjs';

const cs = JSON.parse(readFileSync(new URL('../../app/src/i18n/cs.json', import.meta.url), 'utf8'));
export const { t, tx, setLocale, getLocale } = createT(cs);
