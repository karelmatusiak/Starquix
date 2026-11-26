import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '@/db';
import { projectFsRuntime } from '@/test/projectFsRuntime';
import { contentOps, setLocalContentSource } from '@/core/collections/content-ops';
import { setActiveSaveProjectId } from '@/services/pendingProjectMutations';
import { flushDurableSourceWrites } from '../sourceMaterialization';
import { getDurableProjectState } from '../store';

const post = 'src/content/posts/hello.mdx';
const second = 'src/content/posts/nested/second.md';
const other = 'src/content/news/other.md';
const config = 'src/content.config.ts';
const original = '---\r\ntitle: "Hello" # retained\r\ncustom: untouched\r\n---\r\n<Thing />\r\n';
const originalConfig = "import { defineCollection, z } from 'astro:content';\n// Keep this custom configuration.\nconst posts = defineCollection({ schema: z.object({\n  title: z.string(),\n}) });\nexport const collections = { posts };\n";
const secondSource = '---\ntitle: Second\nrank: 5 # existing value\n---\nSecond body\n';
let projectId: string;
let runtime: ReturnType<typeof projectFsRuntime>;
let dispatched: number;
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); await db.delete(); await db.open();
  projectId = `browser_collection_${crypto.randomUUID()}`;
  setActiveSaveProjectId(projectId); setLocalContentSource(`wc://${projectId}`); dispatched = 0;
  runtime = projectFsRuntime(projectId, { [post]: original, [second]: secondSource, [other]: secondSource, [config]: originalConfig }, {
    beforeCommand: async () => { dispatched++; expect(await db.durableEdits.count()).toBeGreaterThan(0); },
    loseAcknowledgement: () => true,
  });
});
afterEach(() => { runtime.close(); setLocalContentSource(null); setActiveSaveProjectId(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['add', 'remove'] as const)('rejects collection field %s without changing posts, schema, or publishing success when storage refuses', async action => {
  vi.spyOn(db.durableEditCheckpoints, 'add').mockRejectedValue(new Error('quota'));
  let changed = 0; const listener = () => { changed++; }; window.addEventListener('sq:content-changed', listener);
  try {
    await expect(action === 'add' ? contentOps.addLocalCollectionField('posts', 'rank', 0)
      : contentOps.removeLocalCollectionField('posts', 'rank')).rejects.toThrow('quota');
    expect(runtime.read(post)).toBe(original); expect(runtime.read(second)).toBe(secondSource);
    expect(runtime.read(config)).toBe(originalConfig); expect(changed).toBe(0);
    expect(await db.durableEdits.count()).toBe(0);
  } finally { window.removeEventListener('sq:content-changed', listener); }
});

it('accepts all post patches and the selected schema in one revision before source dispatch', async () => {
  await contentOps.addLocalCollectionField('posts', 'rank', 0);
  const rows = await db.durableEdits.toArray();
  expect(rows).toHaveLength(1); expect(rows[0].commands).toHaveLength(1);
  expect(rows[0].commands[0]).toEqual({ kind: 'file-batch', payload: { files: [
    { file: post, beforeSource: original, afterSource: '---\r\ntitle: "Hello" # retained\r\ncustom: untouched\r\nrank: 0\r\n---\r\n<Thing />\r\n' },
    { file: config, beforeSource: originalConfig, afterSource: originalConfig.replace('  title: z.string(),', '  title: z.string(),\n  rank: z.string().optional(),') },
  ] } });
  expect(runtime.read(post)).toBe(original); expect(runtime.read(config)).toBe(originalConfig); expect(dispatched).toBe(0);
  expect(runtime.read(second)).toBe(secondSource); expect(runtime.read(other)).toBe(secondSource);
});

it('prepares removal against accepted post and schema bytes before the first operation materializes', async () => {
  await contentOps.addLocalCollectionField('posts', 'rank', 0);
  await contentOps.removeLocalCollectionField('posts', 'rank');
  const rows = await db.durableEdits.orderBy('[projectId+revision]').toArray();
  expect(rows).toHaveLength(2);
  const removal = rows[1].commands[0];
  expect(removal).toMatchObject({ kind: 'file-batch' });
  if (removal.kind !== 'file-batch') throw new Error('Expected file batch');
  expect(removal.payload.files.map(file => file.file).sort()).toEqual([post, second, config].sort());
  expect(removal.payload.files.find(file => file.file === post)?.afterSource).toBe(original);
  expect(removal.payload.files.find(file => file.file === config)?.beforeSource).toContain('rank: z.string().optional()');
  expect(removal.payload.files.find(file => file.file === config)?.afterSource).toBe(originalConfig);
  expect((await contentOps.fetchCollections()).find(collection => collection.name === 'posts')?.posts.every(entry => !('rank' in entry.frontmatter))).toBe(true);
  expect(runtime.read(second)).toBe(secondSource);
  await flushDurableSourceWrites(projectId);
  expect(runtime.read(post)).toBe(original); expect(runtime.read(config)).toBe(originalConfig);
  expect(runtime.read(second)).toBe('---\ntitle: Second\n---\nSecond body\n');
  expect(runtime.read(other)).toBe(secondSource);
});

it('restores grouped collection acceptance after reload and reconciles a lost ACK without repeating source writes', async () => {
  await contentOps.addLocalCollectionField('posts', 'draft', false, 'boolean');
  db.close(); await db.open(); runtime.restart();
  const pending = (await contentOps.fetchCollections()).find(collection => collection.name === 'posts');
  expect(pending?.posts.every(entry => entry.frontmatter.draft === false)).toBe(true);
  expect(runtime.read(post)).toBe(original);
  await flushDurableSourceWrites(projectId);
  expect(runtime.read(post)).toContain('draft: false\r\n');
  expect(runtime.read(config)).toContain('draft: z.boolean().optional(),');
  expect(dispatched).toBe(1);
  db.close(); await db.open(); runtime.restart(); await flushDurableSourceWrites(projectId);
  expect(dispatched).toBe(1);
  expect(await getDurableProjectState(projectId)).toMatchObject({ acceptedRevision: 1, materializedRevision: 1 });
});

it('preserves local ownership when a caller requests generated content config', async () => {
  await contentOps.writeContentConfig([]);
  expect(runtime.read(config)).toBe(originalConfig);
  expect(await db.durableEdits.count()).toBe(0);
});

// Agent multiplayer (owner 2026-11-08, ledger B5a): a newer outside rewrite of
// the schema leaves the whole field change unapplied — schema and posts stay
// consistent — and the queue moves on.
it('keeps a multi-file field change atomic when a newer outside schema edit wins its config', async () => {
  await contentOps.addLocalCollectionField('posts', 'draft', false, 'boolean');
  const outside = join(runtime.root, config);
  writeFileSync(outside, '// external schema edit\n');
  // Linux mtime can sit a few ms behind Date.now(), which made this write look older than the edit.
  const later = new Date(Date.now() + 1000);
  utimesSync(outside, later, later);
  await flushDurableSourceWrites(projectId);
  expect(runtime.read(post)).toBe(original); expect(runtime.read(second)).toBe(secondSource);
  expect(runtime.read(config)).toBe('// external schema edit\n'); expect(dispatched).toBe(0);
  expect(await db.durableEdits.count()).toBe(1);
  expect(await getDurableProjectState(projectId)).toMatchObject({ acceptedRevision: 1, materializedRevision: 1 });
});

it('uses only the selected Astro config and preserves a second legacy config', async () => {
  const legacyConfig = 'src/content/config.ts';
  writeFileSync(join(runtime.root, legacyConfig), '// legacy config owned by the project\n');
  await contentOps.addLocalCollectionField('posts', 'draft', false, 'boolean');
  await flushDurableSourceWrites(projectId);
  expect(runtime.read(config)).toContain('draft: z.boolean().optional(),');
  expect(runtime.read(legacyConfig)).toBe('// legacy config owned by the project\n');
});

it.each([null, 'src/content/config.ts'] as const)('accepts fields with the existing config owner %s without generating a new config', async configFile => {
  runtime.close();
  runtime = projectFsRuntime(projectId, { [post]: original, ...(configFile ? { [configFile]: originalConfig } : {}) });
  await contentOps.addLocalCollectionField('posts', 'draft', false, 'boolean');
  const command = (await db.durableEdits.toArray())[0].commands[0];
  if (command.kind !== 'file-batch') throw new Error('Expected file batch');
  expect(command.payload.files.map(file => file.file)).toEqual(configFile ? [post, configFile] : [post]);
  await flushDurableSourceWrites(projectId);
  expect(runtime.read(post)).toContain('draft: false\r\n');
  if (configFile) expect(runtime.read(configFile)).toContain('draft: z.boolean().optional(),');
  expect(() => runtime.read(config)).toThrow();
});
