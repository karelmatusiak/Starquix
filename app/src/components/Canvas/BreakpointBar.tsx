import { memo, useRef } from 'react';
import { t } from '@/i18n';
import { useHoverMenu } from './hoverMenu';
import { GridChip } from './GridChip';
import { Button, Menu, MenuItem } from '@/components/ui';
import { ChevronDownIcon } from '@/assets/icons';
import { useYjsValue, useDispatch, useProjectId } from '@/store/hooks';
import { DEVICE_OF, SCREEN_PRESETS, setScreenHeight, useScreenHeight } from './viewportHeightPreferences';
import { selectCurrentBreakpoint, selectCurrentThemeMode } from '@/store/selectors';
import { selectVariableCollections } from '@/store/variableSelectors';
import type { Breakpoint } from '@/store/types';
import { BREAKPOINTS } from '@/store/types';

const BREAKPOINT_LABELS: Record<Breakpoint, string> = {
  base: 'xs',
  sm: 'sm',
  md: 'md',
  lg: 'lg',
  xl: 'xl',
  '2xl': '2xl',
};

const breakpoints: Breakpoint[] = ['base', 'sm', 'md', 'lg', 'xl', '2xl'];

/** Button that opens its Menu on hover (and click); closes on mouse-out of both. */
function HoverMenuButton({
  label,
  detail,
  menuWidth,
  children,
}: {
  label: string;
  detail?: string;
  menuWidth?: number;
  children: React.ReactNode;
}) {
  const { open, show, close, scheduleClose, cancelClose } = useHoverMenu();
  const triggerRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={triggerRef} onMouseEnter={show} onMouseLeave={scheduleClose}>
      <Button
        variant="secondary"
        size="sm"
        onClick={show}
        className="px-3 gap-1.5"
        label={label}
        iconRight={
          <span className="flex items-center gap-1">
            {detail && <span className="text-3xs text-text-muted">{detail}</span>}
            <ChevronDownIcon className="w-4 h-4 text-text-muted" />
          </span>
        }
      />
      <Menu isOpen={open} onClose={close} triggerRef={triggerRef} placement="bottom" offset={4} width={menuWidth}>
        <div onMouseEnter={cancelClose} onMouseLeave={scheduleClose} onClick={close}>
          {children}
        </div>
      </Menu>
    </div>
  );
}

export const BreakpointBar = memo(function BreakpointBar({ children }: { children?: React.ReactNode }) {
  const dispatch = useDispatch();
  const currentBreakpoint = useYjsValue(selectCurrentBreakpoint);
  const currentThemeMode = useYjsValue(selectCurrentThemeMode);
  const collections = useYjsValue(selectVariableCollections);
  const projectId = useProjectId();
  const device = DEVICE_OF[currentBreakpoint];
  const screenH = useScreenHeight(projectId, device);

  // Unique variable-mode names across collections; keyed lowercased to match
  // the [data-mode] selector emitted by cssGenerator.ts. Default = :root.
  const modes: { key: string | null; name: string }[] = [];
  const seen = new Set<string>();
  for (const col of collections) {
    for (const mode of col.modes) {
      const lower = mode.name.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      modes.push({ key: mode.isDefault ? null : lower, name: mode.name });
    }
  }
  const activeMode = modes.find((m) => m.key === currentThemeMode) ?? modes[0];

  return (
    // Never clips: narrower than its chips (the 900px minimum window), the row scrolls; centered while it fits (#37).
    <div className="flex-1 self-stretch min-w-0 flex items-center justify-center-safe gap-1 overflow-x-auto scrollbar-thin *:shrink-0">
      <HoverMenuButton
        label={BREAKPOINT_LABELS[currentBreakpoint]}
        detail={String(BREAKPOINTS[currentBreakpoint])}
        menuWidth={176}
      >
        {breakpoints.map((bp, i) => (
          <MenuItem
            key={bp}
            label={BREAKPOINT_LABELS[bp]}
            caption={String(BREAKPOINTS[bp])}
            shortcut={String(i + 1)}
            selected={bp === currentBreakpoint}
            showCheck={false}
            onSelect={() => dispatch({ type: 'SET_BREAKPOINT', breakpoint: bp })}
          />
        ))}
      </HoverMenuButton>
      {/* Screen height: one per device class (all desktop widths share it). */}
      <HoverMenuButton label={`H ${screenH}`} detail={t(device)} menuWidth={208}>
        {SCREEN_PRESETS[device].map((p) => (
          <MenuItem
            key={p.height}
            label={p.label}
            caption={String(p.height)}
            selected={p.height === screenH}
            showCheck={false}
            onSelect={() => setScreenHeight(projectId, device, p.height)}
          />
        ))}
      </HoverMenuButton>
      {modes.length > 0 && activeMode && (
        <HoverMenuButton label={activeMode.name}>
          {modes.map((m) => (
            <MenuItem
              key={m.key ?? '__default__'}
              label={m.name}
              selected={m === activeMode}
              showCheck={false}
              onSelect={() => dispatch({ type: 'SET_THEME_MODE', mode: m.key })}
            />
          ))}
        </HoverMenuButton>
      )}
      <GridChip projectId={projectId} />
      {children}
    </div>
  );
});
