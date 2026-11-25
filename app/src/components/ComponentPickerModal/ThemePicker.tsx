// The project's section theme, in the ⌘K tab row (docs/plans/2026-11-08-theme-selector-design.md): pick one theme,
// upload a ZIP (system file chooser — no window on top of ⌘K), delete an upload (confirmed in its row).
import React, { useCallback, useRef, useState } from 'react';
import { ChevronDownIcon, CheckIcon, TrashIcon, UploadIcon } from '@/assets/icons';
import { Button, Menu, MenuItem, Row } from '@/components/ui';
import { useThemesLibrary } from '@/context/ThemesLibraryContext';
import { useOptionalUndoContext } from '@/context/UndoContext';
import { ThemeZipError } from '@/services/ThemeProcessor';
import type { IssueCopy } from '@/utils/operationIssue';
import { t } from '@/i18n';
import { BUILT_IN_THEMES, uploadThemeId } from '@/utils/libraryThemes';

/** Built-in theme names are chrome. An uploaded theme keeps the name the user gave it. */
const themeLabel = (id: string, name: string) => (id === 'starquix' || id === 'classic' ? t(name) : name);

const MAX_ZIP_BYTES = 10 * 1024 * 1024;

/** Upload through the system file chooser; the new theme becomes the project's theme. */
export function useThemeUpload() {
  const { uploadNewTheme, setActiveTheme } = useThemesLibrary();
  const inputRef = useRef<HTMLInputElement>(null);
  const [issue, setIssue] = useState<IssueCopy | null>(null);
  const [busy, setBusy] = useState(false);
  const choose = useCallback(() => inputRef.current?.click(), []);
  const onChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // the same ZIP can be picked again after a fix
    if (!file) return;
    const title = `${file.name} was not added.`;
    if (!file.name.toLowerCase().endsWith('.zip')) return setIssue({ title, detail: 'Choose a ZIP file.' });
    if (file.size > MAX_ZIP_BYTES) return setIssue({ title, detail: 'Choose a ZIP file smaller than 10 MB.' });
    setIssue(null);
    setBusy(true);
    try {
      await setActiveTheme(uploadThemeId(await uploadNewTheme(file.name.replace(/\.zip$/i, ''), file)));
    } catch (err) {
      console.error('Theme upload failed:', err);
      // Only the ZIP checks' own messages are shown; anything else (storage, a broken archive) stays generic.
      setIssue({ title, detail: err instanceof ThemeZipError ? err.message : 'Check the ZIP and try again.' });
    } finally {
      setBusy(false);
    }
  }, [setActiveTheme, uploadNewTheme]);
  const input = (
    <input ref={inputRef} type="file" accept=".zip,application/zip" hidden onChange={onChange}
      data-testid="theme-upload-input" />
  );
  return { input, choose, issue, busy };
}

export const ThemePicker: React.FC<{ onUpload: () => void; uploading: boolean }> = ({ onUpload, uploading }) => {
  const { themes, activeTheme, setActiveTheme, deleteTheme } = useThemesLibrary();
  const [isOpen, setIsOpen] = useState(false);
  const undo = useOptionalUndoContext();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => { setIsOpen(false); }, []);

  const uploads = themes.map((t) => ({ id: uploadThemeId(t._id), name: t.name, themeId: t._id }));
  const active = [...BUILT_IN_THEMES, ...uploads].find((o) => o.id === activeTheme);
  const label = active ? themeLabel(active.id, active.name) : themeLabel(BUILT_IN_THEMES[0].id, BUILT_IN_THEMES[0].name);
  const pick = (theme: string) => {
    setActiveTheme(theme).catch((err) => console.error('Failed to set the theme:', err));
    close();
  };
  // At once — ⌘Z brings the upload back (owner 2026-11-10: delete anything AND undo). Its rows live outside the doc,
  // so the undo entry replays them as a side effect, committed right away (no doc transaction will).
  const remove = (themeId: string) => {
    const forward = () => deleteTheme(themeId);
    const failed = (what: string) => (err: unknown) => console.error(`Failed to ${what} theme:`, err);
    forward().then((restore) => undo?.takeSnapshot({
      reverse: () => { restore().catch(failed('restore')); },
      forward: () => { forward().catch(failed('delete')); },
    }, undefined, true)?.()).catch(failed('delete'));
  };

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        label={label}
        iconRight={<ChevronDownIcon className="w-4 h-4" />}
        loading={uploading}
        aria-label={`Theme: ${label}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title="Theme of the sections you insert"
        onClick={() => (isOpen ? close() : setIsOpen(true))}
      />
      <Menu isOpen={isOpen} onClose={close} triggerRef={triggerRef} placement="bottom-end" width={240}>
        {BUILT_IN_THEMES.map((t) => (
          <MenuItem key={t.id} label={themeLabel(t.id, t.name)} selected={activeTheme === t.id} onSelect={() => pick(t.id)} />
        ))}
        {uploads.length > 0 && <div className="border-t border-stroke my-1" />}
        {uploads.map((u) => (
          // MenuItem plus a hover trash (MenuItem has no action slot).
          <Row
            key={u.id}
            size="sm"
            className="px-3 py-2 text-xs"
            selected={activeTheme === u.id}
            title={u.name}
            onClick={() => pick(u.id)}
            rowProps={{ role: 'menuitem', tabIndex: 0, onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(u.id); } } }}
            right={[
              ...(activeTheme === u.id ? [{ type: 'icon' as const, icon: <CheckIcon /> }] : []),
              { type: 'custom', unboxed: true, showOnHover: true, node: (
                <Button variant="ghost" size="sm" iconOnly title="Delete theme" aria-label={`Delete ${u.name}`}
                  icon={<TrashIcon className="w-4 h-4" />}
                  onClick={(e) => { e.stopPropagation(); remove(u.themeId); }} />
              ) },
            ]}
          />
        ))}
        <div className="border-t border-stroke mt-1 pt-1">
          <MenuItem onSelect={() => { close(); onUpload(); }} label="Upload theme…" icon={<UploadIcon className="w-4 h-4" />} />
        </div>
      </Menu>
    </>
  );
};
