// Editor-side i18n. The English source string is the key; `cs.json` is the
// Czech catalog and the default locale. A missing Czech entry falls back to
// English (then to an optional English override). Vitest forces English so
// existing assertions keep matching the source text.
import cs from './cs.json';
import { createT } from './translate';

const catalogs = createT(cs as Record<string, string>);

export const t = catalogs.t;
export const tx = catalogs.tx;
export const setLocale = catalogs.setLocale;
export const getLocale = catalogs.getLocale;

export type Translate = typeof t;
