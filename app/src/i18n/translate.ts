// Same rules as ../../i18n/translate.mjs (the Electron main process cannot import
// this TypeScript). Keep the two copies in sync.

const NBSP = '\u00A0';

export function czechTypography(input: string): string {
  return input
    .replace(/(\d)\s+(?=(?:%|Kč|MB|GB|kB)\b)/g, `$1${NBSP}`)
    .replace(/(^|[\s„"(\[])([KkSsVvZzOoUuAaIi])\s+(?=\S)/g, `$1$2${NBSP}`);
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (full, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key) || vars[key] == null) return full;
    return String(vars[key]);
  });
}

function defaultLocale(): 'cs' | 'en' {
  try {
    if (typeof process !== 'undefined' && process.env && (process.env.VITEST || process.env.VITEST_WORKER_ID)) return 'en';
  } catch { /* browser bundle has no process */ }
  return 'cs';
}

export function createT(cs: Record<string, string>, en: Record<string, string> = {}) {
  let locale: 'cs' | 'en' = defaultLocale();

  function lookup(message: string): { text: string; typed: boolean } {
    if (locale === 'en') return { text: en[message] ?? message, typed: false };
    if (Object.prototype.hasOwnProperty.call(cs, message)) return { text: cs[message], typed: true };
    if (Object.prototype.hasOwnProperty.call(en, message)) return { text: en[message], typed: false };
    return { text: message, typed: false };
  }

  function t(message: string, vars?: Record<string, string | number>): string {
    if (typeof message !== 'string' || message === '') return message;
    const hit = lookup(message);
    const filled = interpolate(hit.text, vars);
    return hit.typed ? czechTypography(filled) : filled;
  }

  function tx<T>(value: T): T {
    return (typeof value === 'string' ? t(value) : value) as T;
  }

  function setLocale(next: 'cs' | 'en') { locale = next === 'en' ? 'en' : 'cs'; }
  function getLocale() { return locale; }

  return { t, tx, setLocale, getLocale };
}
