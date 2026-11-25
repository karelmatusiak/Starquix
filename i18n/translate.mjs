// Shared by the editor (Vite) and the Electron main process. English text is the
// message id. Czech is the default catalog; a missing entry falls back to English.
// Tests run with VITEST set, so they keep seeing the English ids.

const NBSP = '\u00A0';

/** Non-breaking spaces after one-letter Czech prepositions and between a number and its unit. */
export function czechTypography(input) {
  return input
    .replace(/(\d)\s+(?=(?:%|Kč|MB|GB|kB)\b)/g, `$1${NBSP}`)
    .replace(/(^|[\s„"(\[])([KkSsVvZzOoUuAaIi])\s+(?=\S)/g, `$1$2${NBSP}`);
}

function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (full, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key) || vars[key] == null) return full;
    return String(vars[key]);
  });
}

function defaultLocale() {
  try {
    if (typeof process !== 'undefined' && process.env && (process.env.VITEST || process.env.VITEST_WORKER_ID)) return 'en';
  } catch { /* browser bundle has no process */ }
  return 'cs';
}

/**
 * @param {Record<string, string>} cs Czech catalog keyed by the English source string.
 * @param {Record<string, string>} [en] Optional English overrides. Unused keys fall back to the source string.
 */
export function createT(cs, en = {}) {
  let locale = defaultLocale();

  function lookup(message) {
    if (locale === 'en') return { text: en[message] ?? message, typed: false };
    if (Object.prototype.hasOwnProperty.call(cs, message)) return { text: cs[message], typed: true };
    if (Object.prototype.hasOwnProperty.call(en, message)) return { text: en[message], typed: false };
    return { text: message, typed: false };
  }

  function t(message, vars) {
    if (typeof message !== 'string' || message === '') return message;
    const hit = lookup(message);
    const filled = interpolate(hit.text, vars);
    return hit.typed ? czechTypography(filled) : filled;
  }

  /** Translate a string; leave nodes, numbers and empty values alone. */
  function tx(value) {
    return typeof value === 'string' ? t(value) : value;
  }

  function setLocale(next) { locale = next === 'en' ? 'en' : 'cs'; }
  function getLocale() { return locale; }

  return { t, tx, setLocale, getLocale };
}
