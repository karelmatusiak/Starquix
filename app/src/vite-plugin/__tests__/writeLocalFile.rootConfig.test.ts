// task-248 P2: the SEO site settings own a line of astro.config (site, sitemap) and package.json.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeLocalFile } from '../../../../preview-template/src/plugins/sq-project-fs.js';

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sq-rootcfg-')); mkdirSync(join(root, 'src')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('writeLocalFile root config allowlist', () => {
  it.each(['astro.config.mjs', 'astro.config.ts', 'package.json'])('writes %s at the project root', async (file) => {
    await writeLocalFile(root, file, 'x\n');
    expect(readFileSync(join(root, file), 'utf8')).toBe('x\n');
  });
  it.each(['tsconfig.json', 'nested/package.json', '../package.json', '.env', 'src/../.env', 'functions/api/other.js'])('still refuses %s', async (file) => {
    await expect(writeLocalFile(root, file, 'x')).rejects.toThrow(/outside/);
  });
  it('writes the generated contact endpoint and nothing else under functions/', async () => {
    await writeLocalFile(root, 'functions/api/kontakt.js', 'export {}\n');
    expect(readFileSync(join(root, 'functions/api/kontakt.js'), 'utf8')).toBe('export {}\n');
  });
});
