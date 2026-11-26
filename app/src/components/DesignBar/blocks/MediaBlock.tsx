import { MEDIA_COUNT_ICONS } from '@/assets/icons/mediaCountIcons';
import { t } from '@/i18n';
import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import toast from 'react-hot-toast';
import { Button, Row } from '@/components/ui';
import { WidthModes } from '@/components/PostEditor/WidthControl';
import { parseMediaItems, editMediaItem } from '@/components/PostEditor/componentMedia';
import { uploadPostMediaFile } from '@/utils/imageUpload';
import { ALLOWED_IMAGE_TYPES, ALLOWED_VIDEO_TYPES } from '@/utils/imageValidation';
import { setCount, setWidth, getWidth, getProp, setProp } from '@/core/postmedia/invocation';
import { useInvocation } from './useInvocation';
import { MEDIA_MANIFEST } from '@/core/manifest/mediaManifest';
import type { Manifest } from '@/core/manifest/types';
import { ComponentSettingsBlock, type PropValue } from './ComponentSettingsBlock';
import type { MediaSelection } from '../mediaUnit';

/**
 * task-206 D4: the ONE panel a Media (system component) selection shows.
 * Count 1/2/3 · width 8/12/full (the SAME WidthModes as the post editor, D3)
 * · gap/padding/margin/radius. Every edit rewrites the <Media/> invocation in
 * the post .mdx through saveMediaEdit (D5).
 * No write target (no rehype stamps in the rendered body) → read-only.
 * The write itself is runtime-agnostic: saveMediaEdit → contentOps.updatePost
 * (local HMR channel, WC container FS, or the ls tier).
 *
 * task-207: the style knobs are now generic PROPS driven by Media's manifest
 * (D10) and rendered by ComponentSettingsBlock. Count and width stay bespoke
 * on purpose — count rides the `items` ARRAY contract and width rides a class
 * TOKEN inside a class string; neither is a plain attribute, so wrapping them
 * in setProp would be DRY theatre over two different problems.
 */
interface MediaBlockProps {
  selection: MediaSelection;
  /** The post whose rendered route the canvas shows (goToPostTarget). */
  postTarget: { collection: string; slug: string } | null;
  /** For slot uploads — routes local vs WC exactly like Canvas.uploadPostMedia. */
  projectId?: string | null;
  /** Component viewer (master view): no invocation exists, so the knobs drive
   *  the DEMO preview live over SET_MEDIA_DEMO instead of writing a file. */
  demo?: boolean;
  /** task-207 Task 7 / D11: Media's manifest parsed from the USER's own
   *  `sq/Media.astro` frontmatter, which the local scan already carries.
   *  The owner passes it because it already holds the library — a second
   *  `useComponentLibrary()` here would mean a second scan fetch per
   *  selection. Omitted (WC: no local scan) → the inlined MEDIA_MANIFEST. */
  manifest?: Manifest;
}

/** Slot pickers accept exactly what upload validation accepts. */
const SLOT_ACCEPT = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES].join(',');

/** Must match SqComponentView's demo stubProps (items = [null, null]) —
 *  the mount-time sendDemo below re-asserts it so the panel is the truth. */
const MEDIA_DEMO_COUNT = 2;

export const MediaBlock: FC<MediaBlockProps> = ({
  selection, postTarget, projectId = null, demo = false, manifest = MEDIA_MANIFEST,
}) => {
  const write = selection.write;
  const readOnly = !demo && (write === null || postTarget === null);
  const { src, save } = useInvocation({ postTarget, bodyLine: write?.bodyLine });
  const [demoCount, setDemoCount] = useState(MEDIA_DEMO_COUNT);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceSlotRef = useRef<number>(0);

  const sendDemo = useCallback((payload: { count?: number; vars?: Record<string, number | null> }) => {
    window.postMessage({ type: 'SET_MEDIA_DEMO_TO_IFRAME', payload }, '*');
  }, []);

  // Demo mount: assert the panel's count onto the preview, so the two can't
  // silently desync if the viewer's stub shape changes.
  useEffect(() => {
    if (demo) sendDemo({ count: MEDIA_DEMO_COUNT });
  }, [demo, sendDemo]);


  const items = src ? parseMediaItems(src) : null;
  const count = demo ? demoCount : (items?.length || 1);

  /** Current attr values, read with the same grammar setProp writes. */
  const values = useMemo(() => Object.fromEntries(
    manifest.props.map((p) => [p.name, getProp(src, p.name)]),
  ), [src, manifest]);

  const handlePropChange = useCallback((prop: string, value: PropValue) => {
    if (demo) {
      // The viewer has no invocation — the knobs drive the demo render instead.
      sendDemo({ vars: { [prop]: typeof value === 'number' ? value : null } });
      return;
    }
    save((s) => setProp(s, prop, value));
  }, [demo, sendDemo, save]);

  const handleFilePicked = useCallback(async (file: File) => {
    if (!projectId) return;
    const slot = replaceSlotRef.current;
    try {
      const uploaded = await uploadPostMediaFile(projectId, file);
      save((s) => editMediaItem(s, slot, uploaded));
    } catch {
      toast.error(t("Upload failed"));
    }
  }, [projectId, save]);

  return (
    <div className="pb-2">
      {/* key: a new selection must not inherit the previous one's uncommitted
          field drafts. */}
      <ComponentSettingsBlock
        key={demo ? 'demo' : String(write?.bodyLine ?? 'none')}
        name="Media"
        manifest={manifest}
        values={values}
        readOnly={readOnly}
        onChange={handlePropChange}
      >
      {readOnly && (
        <div className="px-2 py-1 text-2xs text-text-secondary">
          Open the post to edit this media
        </div>
      )}
      <div className="px-2 py-1 flex items-center gap-1">
        {[1, 2, 3].map((n) => (
          <Button
            key={n}
            size="sm"
            variant="ghost"
            active={!readOnly && count === n}
            disabled={readOnly}
            iconOnly
            title={`${n} item${n > 1 ? 's' : ''}`}
            aria-label={`${n} item${n > 1 ? 's' : ''}`}
            icon={(() => { const Icon = MEDIA_COUNT_ICONS[n - 1]; return <Icon className="w-4 h-4" />; })()}
            onClick={() => {
              if (demo) { setDemoCount(n); sendDemo({ count: n }); return; }
              save((s) => setCount(s, n));
            }}
          />
        ))}
        {/* Width is the post grid's contract — meaningless in the viewer's
            bare page, so demo mode hides it rather than lying. */}
        {!demo && (
          <>
            <div className="w-2" />
            <WidthModes span={getWidth(src)} onChange={(mode) => { if (!readOnly) save((s) => setWidth(s, mode)); }} />
          </>
        )}
      </div>
      </ComponentSettingsBlock>
      {items && !readOnly && (
        <div className="px-2 py-1">
          {items.map((item, i) => (
            <Row
              key={i}
              size="sm"
              hover={false}
              title={`Slot ${i + 1}`}
              caption={item ? item.split('/').pop() : 'Empty'}
              right={[{
                type: 'custom',
                unboxed: true,
                node: (
                  <Button
                    size="sm"
                    variant="ghost"
                    label="Replace"
                    aria-label={`Replace slot ${i + 1}`}
                    onClick={() => {
                      replaceSlotRef.current = i;
                      fileInputRef.current?.click();
                    }}
                  />
                ),
              }]}
            />
          ))}
          {/* ui-lint-line: hidden file input is the native picker, not chrome */}
          <input
            ref={fileInputRef}
            type="file"
            accept={SLOT_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void handleFilePicked(file);
            }}
          />
        </div>
      )}
    </div>
  );
};

export default MediaBlock;
