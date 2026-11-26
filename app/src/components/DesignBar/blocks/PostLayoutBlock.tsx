/**
 * Post layout settings (design docs/plans/2026-09-28-post-article-look-design.md, A3):
 * the header variant + which header pieces show, for every post of this
 * collection. Files are truth: the settings ARE the attributes on
 * `<PostLayout …>` in the post route; each change is one whole-file,
 * undoable write (the same primitive as the blog binding).
 */
import { useCallback, useEffect, useState } from 'react';
import { t } from '@/i18n';
import toast from 'react-hot-toast';
import { Row, SegmentedControl } from '@/components/ui';
import { useLocalProjectPath } from '@/hooks/useLocalProjectPath';
import { useUndoContext } from '@/context/UndoContext';
import { fetchLocalPageSource, getLocalPageFile } from '@/utils/localPageSync';
import { commitWholeLocalFile } from '@/components/Editor/localBlogBind';
import { writeLocalFile } from '@/utils/localElementSource';
import { settleAcceptedWrites } from '@/utils/acceptedSource';
import { acquireStructuralWrite, releaseStructuralWrite } from '@/store/structuralWriteGuard';
import {
  POST_TOGGLES, readPostLayoutSettings, writePostLayoutSettings,
  type PostHeader, type PostLayoutSettings, type PostToggle,
} from '@/core/post/postLayoutProps';

const HEADERS: Array<{ value: PostHeader; label: string; title: string }> = [
  { value: 'classic', label: 'Classic', title: 'Title left, wide cover below (Medium-like)' },
  { value: 'centered', label: 'Centered', title: 'Everything centered (Substack-like)' },
  { value: 'cover', label: 'Cover', title: 'Edge-to-edge image first' },
];

const LABELS: Record<PostToggle, string> = {
  showSubtitle: 'Subtitle',
  showAuthor: 'Author',
  showDate: 'Date',
  showReadingTime: 'Reading time',
  showCover: 'Cover image',
};

/**
 * `file` = the post route to edit (default: the page open on the canvas).
 * The post editor passes its collection's route and hears every accepted
 * change through `onChange`, so its writing view re-draws the header.
 */
export function PostLayoutBlock({ file: routeFile, onChange, className = 'px-2 pt-2 pb-3 border-b border-stroke' }: {
  file?: string;
  onChange?: (settings: PostLayoutSettings) => void;
  className?: string;
} = {}) {
  const projectPath = useLocalProjectPath();
  const { pushStructuralUndo } = useUndoContext();
  const [state, setState] = useState<{ file: string; source: string; settings: PostLayoutSettings } | null>(null);

  const load = useCallback(async () => {
    const file = routeFile ?? getLocalPageFile();
    if (!projectPath || !file) { setState(null); return; }
    const source = await fetchLocalPageSource(projectPath, file);
    const settings = source === null ? null : readPostLayoutSettings(source);
    setState(source !== null && settings ? { file, source, settings } : null);
  }, [projectPath, routeFile]);
  useEffect(() => { void load(); }, [load]);

  const apply = async (settings: PostLayoutSettings) => {
    if (!state) return;
    if (writePostLayoutSettings(state.source, settings) === null) { toast('This post page is wired by hand — edit it in Source'); return; }
    setState({ ...state, settings }); // optimistic; the write below is the truth
    // Owner 2026-11-10: waits its write turn (never "Still saving the last
    // change") and re-reads the page once disk caught up, so a write just ahead
    // of it in the queue is never put back.
    await acquireStructuralWrite();
    try {
      await settleAcceptedWrites();
      const before = (projectPath ? await fetchLocalPageSource(projectPath, state.file) : null) ?? state.source;
      const after = writePostLayoutSettings(before, settings);
      if (after === null || after === before) return;
      // From the post editor (explicit route) there is no canvas surface to
      // own the write — the structural writer refuses "another surface file" —
      // so it is a plain file write, like the route scaffold's.
      const r = routeFile
        ? await writeLocalFile(state.file, after).then(() => ({ ok: true as const }), (err: unknown) => {
          toast.error(t("Could not update the post layout — {0}", { 0: err instanceof Error ? err.message : 'the file was not changed' }));
          return { ok: false as const };
        })
        : await commitWholeLocalFile({ file: state.file, before, after, pushUndo: pushStructuralUndo, failure: 'Could not update the post layout' });
      if (r.ok) { setState({ file: state.file, source: after, settings }); onChange?.(settings); }
      else void load();
    } finally {
      releaseStructuralWrite();
    }
  };

  if (!state) return null;
  const { settings } = state;
  return (
    <div data-testid="post-layout-block" className={className}>
      <Row size="sm" hover={false} title="Post header" className="px-1" />
      <SegmentedControl
        options={HEADERS}
        value={settings.header}
        onChange={(value) => void apply({ ...settings, header: value as PostHeader })}
      />
      <div className="mt-2">
        {POST_TOGGLES.map((t) => (
          <Row
            key={t}
            size="sm"
            hover={false}
            title={LABELS[t]}
            className="px-1"
            right={[{ type: 'toggle', value: settings.toggles[t], 'aria-label': LABELS[t],
              onChange: (value) => void apply({ ...settings, toggles: { ...settings.toggles, [t]: value } }) }]}
          />
        ))}
      </div>
    </div>
  );
}
