/**
 * SegmentedControl - button group for mutually exclusive options; segments may
 * carry a dropdown for overflow options. (Ported from DesignBar/shared.)
 */
import React, { useState, useRef, useCallback, useMemo } from 'react';
import { tx } from '@/i18n';
import { Popover } from './Popover';
import { MenuItem } from './Menu';
import { ChevronDownIcon } from '@/assets/icons';
import { cx } from './cx';

export interface SegmentDropdownOption {
  value: string;
  label: string;
  title?: string;
}

export interface SegmentOption {
  value: string;
  label?: string;
  icon?: React.ReactNode;
  title?: string;
  /** If provided, this segment becomes a dropdown trigger */
  dropdown?: SegmentDropdownOption[];
}

export interface SegmentedControlProps {
  options: SegmentOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  /** Show chevron on dropdown segments (default: true) */
  showChevron?: boolean;
  /** md 28px (panels); lg 32px — next to a window's `Field size="lg"` */
  size?: 'md' | 'lg';
  /** Several elements selected and their values differ: no segment is active. */
  mixed?: boolean;
}

export const SegmentedControl: React.FC<SegmentedControlProps> = ({
  options,
  value,
  onChange,
  className = '',
  showChevron = true,
  size = 'md',
  mixed = false,
}) => {
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const valueToSegment = useMemo(() => {
    const map = new Map<string, string>();
    options.forEach((opt) => {
      map.set(opt.value, opt.value);
      opt.dropdown?.forEach((sub) => map.set(sub.value, opt.value));
    });
    return map;
  }, [options]);

  const activeSegment = mixed ? undefined : valueToSegment.get(value) || value;

  const getDropdownLabel = useCallback(
    (option: SegmentOption): string | undefined => {
      if (!option.dropdown) return option.label;
      const selected = mixed ? undefined : option.dropdown.find((sub) => sub.value === value);
      return selected ? selected.label : option.label;
    },
    [value, mixed],
  );

  const handleSegmentClick = useCallback(
    (option: SegmentOption) => {
      if (option.dropdown) {
        setOpenDropdown((prev) => (prev === option.value ? null : option.value));
      } else {
        onChange(option.value);
        setOpenDropdown(null);
      }
    },
    [onChange],
  );

  const setTriggerRef = useCallback((optValue: string, el: HTMLButtonElement | null) => {
    if (el) triggerRefs.current.set(optValue, el);
    else triggerRefs.current.delete(optValue);
  }, []);

  return (
    // An input: the track paints the input fill (half a step above the surface in Dark — owner 2026-10-22); the picked
    // segment wears the Figma Segmented page's Buttons/Secondary fill so it stays visible on it.
    <div className={cx('flex overflow-hidden rounded-inner gap-px p-0.5 bg-input-fill', className)}>
      {options.map((option) => {
        const isActive = activeSegment === option.value;
        const hasDropdown = !!option.dropdown;
        const displayLabel = hasDropdown ? getDropdownLabel(option) : option.label;

        return (
          <React.Fragment key={option.value}>
            <button
              ref={(el) => setTriggerRef(option.value, el)}
              type="button"
              aria-pressed={isActive}
              className={cx(
                'flex-1 min-w-0 px-2 text-xs border-none outline-none cursor-pointer transition-colors flex items-center justify-center gap-1 rounded-inner',
                size === 'lg' ? 'h-7' : 'h-6',
                isActive ? 'bg-btn-secondary-fill-default text-btn-secondary-text-default' : 'bg-transparent text-text-secondary hover:text-text',
              )}
              onClick={() => handleSegmentClick(option)}
              title={tx(option.title || displayLabel || option.value)}
            >
              {option.icon}
              {displayLabel && <span className="truncate">{tx(displayLabel)}</span>}
              {hasDropdown && showChevron && (
                <ChevronDownIcon
                  className={cx('w-4 h-4 shrink-0 transition-transform', openDropdown === option.value && 'rotate-180')}
                />
              )}
            </button>

            {hasDropdown && (
              <Popover
                isOpen={openDropdown === option.value}
                onClose={() => setOpenDropdown(null)}
                triggerRef={{ current: triggerRefs.current.get(option.value) || null }}
                placement="bottom-end"
                width="auto"
                className="py-1"
              >
                {option.dropdown!.map((subOption) => (
                  <MenuItem
                    key={subOption.value}
                    label={tx(subOption.label)}
                    title={tx(subOption.title || subOption.label)}
                    selected={!mixed && value === subOption.value}
                    onSelect={() => {
                      onChange(subOption.value);
                      setOpenDropdown(null);
                    }}
                  />
                ))}
              </Popover>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default SegmentedControl;
