import { describe, it, expect } from 'vitest';
import { slugify, pageHref } from '../slugify';

// Single source of truth for page-name → URL derivation. The editor (LinkBlock
// hrefs) and export (generateAstro routes) previously had divergent copies:
// "Q&A" → editor /qa but exported route /q-a → 404 in the exported site.
// Semantics below are EXACTLY the historical export slugify (the deployed truth).
describe('slugify (shared editor/export page-slug source)', () => {
  it('hyphenates special characters — the Q&A regression case', () => {
    expect(slugify('Q&A')).toBe('q-a');
  });

  it('lowercases and hyphenates spaces', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('collapses runs of separators into one hyphen', () => {
    expect(slugify('My   Cool --- Page!')).toBe('my-cool-page');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugify('---hello---')).toBe('hello');
  });

  it('falls back to "untitled" for empty input', () => {
    expect(slugify('')).toBe('untitled');
  });

  it('falls back to "untitled" for all-special-character input', () => {
    expect(slugify('!!!@@@###')).toBe('untitled');
  });

  it('folds Latin diacritics so a Czech name stays one word', () => {
    expect(slugify('Über Uns')).toBe('uber-uns');
    expect(slugify('Kadeřnictví a kosmetika')).toBe('kadernictvi-a-kosmetika');
    expect(slugify('Příliš žluťoučký')).toBe('prilis-zlutoucky');
  });

  it('keeps near-collisions distinct (Q&A vs QA) — why export semantics won', () => {
    expect(slugify('Q&A')).toBe('q-a');
    expect(slugify('QA')).toBe('qa');
  });
});

describe('pageHref (exported-route path for a page)', () => {
  it('returns / for the default page regardless of name', () => {
    expect(pageHref('default', 'Anything')).toBe('/');
  });

  it('returns / for a page named Home, case-insensitive (index route)', () => {
    expect(pageHref('p-1', 'Home')).toBe('/');
    expect(pageHref('p-1', 'HOME')).toBe('/');
  });

  it('returns /<slug> for regular pages', () => {
    expect(pageHref('p-1', 'About Us')).toBe('/about-us');
    expect(pageHref('p-1', 'Q&A')).toBe('/q-a');
  });

  it('explicit isHome=true wins regardless of name', () => {
    expect(pageHref('p-1', 'Renamed Landing', true)).toBe('/');
  });

  it('explicit isHome=false disables the legacy name-magic', () => {
    expect(pageHref('p-1', 'home', false)).toBe('/home');
    expect(pageHref('default', 'Start', false)).toBe('/start');
  });
});
