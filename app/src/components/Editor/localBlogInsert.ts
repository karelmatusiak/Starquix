/**
 * task-240 Phase 4: what a ⌘K BlogSlot insert does AFTER the tag landed on
 * the page (design U1/U2/U3): exactly one collection → bind to it; none →
 * scaffold one, then bind; several → leave unbound (the user picks in Blog
 * Settings). Never a prompt; a failure toasts once and leaves the slot bare.
 */
import toast from 'react-hot-toast';
import { t } from '@/i18n';
import { contentOps } from '@/core/collections/content-ops';
import { fetchLocalPageSource } from '@/utils/localPageSync';
import { sortFor, UNBOUND } from '@/utils/blogBinding';
import type { PushStructuralUndo } from '@/store/structuralUndo';
import { bindLocalBlogSlot } from './localBlogBind';
import { scaffoldBlogCollection } from './localBlogScaffold';

export async function bindInsertedBlogSlot({ pageFile, localProjectPath, pushUndo }: {
  pageFile: string; localProjectPath: string; pushUndo?: PushStructuralUndo;
}): Promise<void> {
  let collections: Awaited<ReturnType<typeof contentOps.fetchCollections>>;
  try { collections = await contentOps.fetchCollections(); } catch { return; }
  if (collections.length > 1) return;
  let name: string;
  if (collections.length === 1) {
    name = collections[0].name;
  } else {
    const source = await fetchLocalPageSource(localProjectPath, pageFile);
    if (source === null) return;
    const r = await scaffoldBlogCollection({ pageFile, pageSource: source });
    if (!r.ok) { toast.error(t("Could not set up a blog collection — {0}", { 0: r.reason })); return; }
    name = r.collection;
    // The schema comes from the files the scaffold just wrote (one source).
    collections = await contentOps.fetchCollections().catch(() => []);
  }
  const schema = collections.find((c) => c.name === name)?.inferredFields ?? [];
  await bindLocalBlogSlot({ pageFile, localProjectPath, pushUndo, binding: { ...UNBOUND, collection: name, sort: sortFor(schema, null) } });
}
