import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, setLocale, t } from './index';

describe('i18n', () => {
  afterEach(() => setLocale('en'));

  it('keeps English ids while Vitest is running', () => {
    expect(getLocale()).toBe('en');
    expect(t('Projects')).toBe('Projects');
    expect(t('Starquix {0} is available.', { 0: '0.0.2' })).toBe('Starquix 0.0.2 is available.');
  });

  it('uses the Czech catalog by default outside tests and falls back to English', () => {
    setLocale('cs');
    expect(t('Projects')).toBe('Projekty');
    expect(t('Starquix')).toBe('Webdílna');
    expect(t('Classic')).toBe('Klasická');
    expect(t('Starquix {0} is available.', { 0: '0.0.3' })).toBe('Webdílna 0.0.3 je k\u00A0dispozici.');
    expect(t('Webdílna vychází z open-source projektu Starquix (MIT).'))
      .toBe('Webdílna vychází z\u00A0open-source projektu Starquix (MIT).');
    expect(t('This string is not in the catalog yet.')).toBe('This string is not in the catalog yet.');
    expect(t('Copied {0} elements', { 0: 3 })).toMatch(/3/);
  });

  it('puts a non-breaking space after a one-letter Czech preposition', () => {
    setLocale('cs');
    expect(t('Starquix {0} is available.', { 0: '0.0.3' })).toBe('Webdílna 0.0.3 je k\u00A0dispozici.');
  });
});
