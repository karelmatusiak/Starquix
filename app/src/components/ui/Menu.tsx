/**
 * Menu = Popover + MenuItem rows. THE dropdown-menu primitive — replaces every
 * hand-rolled absolutely-positioned menu list.
 *
 * @example
 * <Menu isOpen={open} onClose={close} triggerRef={btnRef}>
 *   <MenuItem label="Rename" icon={<PencilIcon />} onSelect={rename} />
 *   <MenuItem label="Delete" danger onSelect={del} />
 * </Menu>
 */
import React from 'react';
import { tx } from '@/i18n';
import { Popover, type PopoverProps } from './Popover';
import { cx } from './cx';
import { Row } from './Row';
import type { SlotSpec } from './Slot';
import { CheckIcon } from '@/assets/icons';

export type MenuProps = PopoverProps;

/** Popover pre-configured for menus (py-1 list padding). */
export function Menu(props: MenuProps) {
  const { className, ...rest } = props as PopoverProps & { className?: string };
  return <Popover {...(rest as PopoverProps)} className={cx('py-1', className)} />;
}

export interface MenuItemProps {
  label: React.ReactNode;
  onSelect?: (e: React.MouseEvent) => void;
  /** Leading slot: icon node or typed slot spec */
  icon?: React.ReactNode | SlotSpec;
  /** Optional subtitle under the label (Row's caption slot) */
  caption?: string;
  /** Right-aligned hint (e.g. keyboard shortcut) */
  shortcut?: string;
  /** Currently-selected option (selected bg/text via Row) */
  selected?: boolean;
  /** Checkmark for the selected row (default true); set false to rely on bg/text alone */
  showCheck?: boolean;
  danger?: boolean;
  disabled?: boolean;
  className?: string;
  title?: string;
}

function isSlotSpec(v: unknown): v is SlotSpec {
  return !!v && typeof v === 'object' && 'type' in (v as object) && typeof (v as { type?: unknown }).type === 'string';
}

export function MenuItem({
  label,
  onSelect,
  icon,
  caption,
  shortcut,
  selected = false,
  showCheck = true,
  danger = false,
  disabled = false,
  className = '',
  title,
}: MenuItemProps) {
  const iconSpec: SlotSpec | undefined = icon == null ? undefined : isSlotSpec(icon) ? icon : { type: 'icon', icon };

  return (
    <Row
      size="sm"
      selected={selected}
      disabled={disabled}
      onClick={onSelect}
      left={iconSpec ? [iconSpec] : undefined}
      // pr-4: in a fit-content menu the longest label would otherwise touch its shortcut
      title={<span className={cx(danger && 'text-error', shortcut && 'pr-4') || undefined}>{typeof label === 'string' ? tx(label) : label}</span>}
      caption={caption ? tx(caption) : caption}
      rightText={shortcut}
      right={selected && showCheck ? [{ type: 'icon', icon: <CheckIcon /> }] : undefined}
      className={cx('px-3 py-2 text-xs', danger && 'text-error hover:bg-error-subtle', className)}
      rowProps={{
        role: 'menuitem',
        title: tx(title),
        tabIndex: disabled ? -1 : 0,
        'aria-disabled': disabled || undefined,
        onKeyDown: (e) => {
          if (disabled) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect?.(e as unknown as React.MouseEvent);
          }
        },
      }}
    />
  );
}
