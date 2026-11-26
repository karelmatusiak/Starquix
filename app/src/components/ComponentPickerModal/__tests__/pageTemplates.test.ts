import { describe, it, expect } from 'vitest';
import { PAGE_TEMPLATES, resolvePreset } from '../pageTemplates';
import type { ScannedComponent } from '@/hooks/useComponentLibrary';

const comp = (name: string): ScannedComponent => ({
  name,
  path: `src/components/library/${name}.astro`,
  source: 'built-in',
  html: `<section>${name}</section>`,
  category: 'Test',
  props: [],
  slots: [],
  dependencies: [],
});

describe('PAGE_TEMPLATES', () => {
  it('has the original presets plus the Czech small-business sites', () => {
    expect(PAGE_TEMPLATES).toHaveLength(11);
    expect(new Set(PAGE_TEMPLATES.map((p) => p.id)).size).toBe(11);
    for (const p of PAGE_TEMPLATES) expect(p.components.length).toBeGreaterThanOrEqual(2);
  });
});

describe('resolvePreset', () => {
  it('resolves components in preset order and reports missing names', () => {
    const library = [comp('Footer'), comp('Header'), comp('Hero')];
    const { resolved, missing } = resolvePreset(
      { id: 't', name: 'T', components: ['Header', 'Ghost', 'Hero', 'Footer'] },
      library,
    );
    expect(resolved.map((c) => c.name)).toEqual(['Header', 'Hero', 'Footer']);
    expect(missing).toEqual(['Ghost']);
  });
});
