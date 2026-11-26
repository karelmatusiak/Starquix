import { describe, it, expect } from 'vitest';
import { getPreviewImage, resolvePreviewImage } from '../previewImages';
import type { ScannedComponent } from '@/hooks/useComponentLibrary';

const comp = (over: Partial<ScannedComponent>): ScannedComponent => ({
  name: 'Header',
  path: 'library/Header.astro',
  source: 'built-in',
  html: '',
  category: 'Header',
  props: [],
  slots: [],
  dependencies: [],
  ...over,
});

describe('getPreviewImage', () => {
  it('resolves a generated PNG for a built-in library name', () => {
    expect(getPreviewImage('Header')).toBeTruthy();
  });

  it('returns undefined for a name with no generated PNG', () => {
    expect(getPreviewImage('Head')).toBeUndefined();
  });
});

describe('resolvePreviewImage', () => {
  it('gives a built-in component its generated PNG', () => {
    expect(resolvePreviewImage(comp({ source: 'built-in' }))).toBe(getPreviewImage('Header'));
  });

  // The bug: the generated PNGs are screenshots of STARQUIX'S OWN library,
  // keyed by bare component name. A local project's `src/components/Header.astro`
  // was borrowing Starquix's marketing-site Header.png.
  it('never gives a user-project component a built-in PNG of the same name', () => {
    const local = comp({ source: 'user-project', path: 'src/components/Header.astro' });
    expect(resolvePreviewImage(local)).toBeUndefined();
  });

  it('still honours a preview the user-project component carries itself', () => {
    const local = comp({
      source: 'user-project',
      path: 'src/components/Header.astro',
      previewImage: '/__sq/local-preview/Header.png',
    });
    expect(resolvePreviewImage(local)).toBe('/__sq/local-preview/Header.png');
  });

  it('falls back to the carried preview when a built-in has no generated PNG', () => {
    const builtIn = comp({ name: 'Head', previewImage: '/fallback.png' });
    expect(resolvePreviewImage(builtIn)).toBe('/fallback.png');
  });

  // Owner 2026-11-08: inserted sections showed grey placeholders ("unfriendly"). A copy of a library section
  // carries its @theme tag, so it shows that section's render; untagged own files still never borrow one.
  it('gives an inserted library section its section\'s render, per theme, whatever its file name', () => {
    const starquixCopy = comp({ source: 'user-project', path: 'src/components/Header.astro', theme: 'starquix', section: 'Header' });
    expect(resolvePreviewImage(starquixCopy)).toBe(getPreviewImage('Header'));
    const classicCopy = comp({ name: 'HeaderClassic', source: 'user-project', path: 'src/components/HeaderClassic.astro', theme: 'classic', section: 'Header' });
    expect(resolvePreviewImage(classicCopy)).toBe(getPreviewImage('classic--Header'));
    expect(getPreviewImage('classic--Header')).toBeTruthy();
    const legacy = comp({ source: 'user-project', path: 'src/components/Header.astro', section: 'Header' }); // untagged = Classic
    expect(resolvePreviewImage(legacy)).toBe(getPreviewImage('classic--Header'));
    const sharedCopy = comp({ name: 'BlogPost', source: 'user-project', path: 'src/components/BlogPost.astro', section: 'BlogPost' });
    expect(resolvePreviewImage(sharedCopy)).toBe(getPreviewImage('BlogPost'));
  });

  it('every built-in section, nav bar and Embed has a generated preview', () => {
    for (const name of ['GlobalNav', 'GlobalNav2', 'Embed', 'Pricing2', 'classic--GlobalNav', 'CzHeroRemeslo', 'CzCenik', 'CzKontakt', 'CzLegalFooter']) {
      expect(getPreviewImage(name), name).toBeTruthy();
    }
  });

  it('leaves a user-project component with no preview at all (grey placeholder)', () => {
    expect(resolvePreviewImage(comp({ name: 'Head', source: 'user-project' }))).toBeUndefined();
  });
});
