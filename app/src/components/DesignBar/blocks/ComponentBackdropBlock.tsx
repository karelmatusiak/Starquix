/**
 * Component view, its root selected (owner 2026-10-10): the backdrop the
 * component is shown on. An EDITOR note in the component's own file
 * (`@sq-backdrop #hex`, preview-template/src/plugins/sq-backdrop.js) — read by
 * the component view, never rendered by the site. One journaled write, one ⌘Z.
 */
import { useEffect, useState } from 'react';
import { t } from '@/i18n';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui';
import { useUndoContext } from '@/context/UndoContext';
import { useLocalProjectPath } from '@/hooks/useLocalProjectPath';
import { useLocalScanVersion } from '@/hooks/useLocalPageLayout';
import { readLocalFile, rewriteLocalFile } from '@/utils/localElementSource';
import { HEX, readBackdrop, setBackdrop } from '../../../../../preview-template/src/plugins/sq-backdrop.js';
import { ColorPicker } from '../ColorPicker';
import { ExpandableRow } from '../sections';

export function ComponentBackdropBlock({ file }: { file: string }) {
  const { takeSnapshot, claimSnapshot } = useUndoContext();
  const scanVersion = useLocalScanVersion(useLocalProjectPath());
  const [color, setColor] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    readLocalFile(file).then((src) => { if (!cancelled) setColor(readBackdrop(src)); }).catch(() => {});
    return () => { cancelled = true; };
  }, [file, scanVersion]);

  const write = async (next: string | null) => {
    takeSnapshot();
    try {
      await rewriteLocalFile(file, (src) => setBackdrop(src ?? '', next), claimSnapshot());
      setColor(next);
    } catch (err) {
      toast.error(t("Could not set the backdrop — {0}", { 0: err instanceof Error ? err.message : 'nothing was changed' }));
    }
  };

  return (
    <ExpandableRow title="Backdrop" className="mt-2" defaultExpanded>
      <div className="space-y-1 pr-8 pb-2">
        <ColorPicker
          value={color ? `bg-[${color}]` : ''} placeholder="White"
          onChange={(_cls, hex) => { if (HEX.test(hex)) void write(hex.toLowerCase()); }}
        />
        {color && <Button variant="ghost" size="sm" label="Reset" onClick={() => void write(null)} />}
      </div>
    </ExpandableRow>
  );
}
