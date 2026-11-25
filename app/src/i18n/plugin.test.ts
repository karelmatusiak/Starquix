import { describe, expect, it } from 'vitest';
import { transformSource } from '../../scripts/i18n-plugin.mjs';

describe('i18n vite plugin', () => {
  it('rewrites visible copy and leaves values and classes alone', () => {
    const source = `
      export function View() {
        const kind = 'pages';
        return <section className={open ? 'bg-bg' : 'hidden'} title="Layers">
          Projects
          <Button label="New Project" value="pages" />
          {busy ? 'Saving…' : 'Save'}
        </section>;
      }
    `;
    const { code, keys } = transformSource(source, 'app/src/Example.tsx');
    expect(code).toContain(`import { t as sqT } from '@/i18n';`);
    expect(code).toContain('title={sqT("Layers")}');
    expect(code).toContain('{sqT("Projects")}');
    expect(code).toContain('label={sqT("New Project")}');
    expect(code).toContain('value="pages"');
    expect(code).toContain("'bg-bg'");
    expect(code).toContain('sqT("Saving…")');
    expect(code).toContain('sqT("Save")');
    expect(keys).toEqual(expect.arrayContaining(['Layers', 'Projects', 'New Project', 'Saving…', 'Save']));
  });
});
