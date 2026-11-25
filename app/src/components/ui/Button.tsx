/**
 * Button - THE button. Any clickable chrome action is a Button (raw <button>
 * in components/** is a lint error outside ui/).
 *
 * Content modes: label / icon+label / label+iconRight / icon-only (square,
 * requires aria-label). `children` is a legacy alias for `label`.
 *
 * @example
 * <Button variant="primary" label="Save" onClick={save} />
 * <Button variant="ghost" icon={<PlusIcon className="w-4 h-4" />} aria-label="Add page" iconOnly />
 * <Button variant="danger" label="Delete" loading={deleting} />
 */
import React, { forwardRef } from 'react';
import { tx } from '@/i18n';
import { cx } from './cx';
import { Spinner } from './Slot';

export type ButtonVariant = 'primary' | 'plain' | 'secondary' | 'outline' | 'ghost' | 'link' | 'danger';
export type ButtonSize = 'lg' | 'md' | 'sm';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** lg 40px, md 32px, sm 24px */
  size?: ButtonSize;
  /** Active/pressed state for toggles */
  active?: boolean;
  /** Icon-only mode (square button; pass aria-label) */
  iconOnly?: boolean;
  /** Text label (preferred over children) */
  label?: string;
  /** Leading icon */
  icon?: React.ReactNode;
  /** Trailing icon */
  iconRight?: React.ReactNode;
  /** Replaces the leading icon with a spinner and disables the button */
  loading?: boolean;
  children?: React.ReactNode;
}

const baseStyles =
  'inline-flex items-center justify-center transition-colors shrink-0 select-none cursor-pointer rounded-inner font-normal';

/** Text · Icon Text (icon, label) · Text Icon (label, icon) · an icon on both sides — Large and Medium share it. */
const PAD = { text: 'px-5', lead: 'pl-2.5 pr-4', trail: 'pl-4 pr-2.5', both: 'px-2.5' };

/** The Figma Buttons page (95:13), every size × content type: radius `4px` (icon-only too); a side holding an icon is
 *  padded less than the label's side; icons are 20px in Large, 16px otherwise; Link has no padding. */
const sizeStyles: Record<ButtonSize, {
  box: string; text: string; gap: string; pad: typeof PAD;
  square: string; glyph: string; spinner?: string;
  /** Link: its label line, or its bare icon */
  link: string; linkSquare: string;
}> = {
  lg: { box: 'h-10 py-2.5', text: 'text-sm', gap: 'gap-2', pad: PAD, square: 'size-10 p-2.5',
    glyph: 'sq-icon-slot sq-icon-size-20', spinner: 'w-5 h-5', link: 'h-5', linkSquare: 'size-5' },
  md: { box: 'h-8 py-2', text: 'text-xs', gap: 'gap-1', pad: PAD, square: 'size-8 p-2',
    glyph: 'sq-icon-slot sq-icon-size-16', link: 'h-4', linkSquare: 'size-4' },
  sm: { box: 'h-6 py-1', text: 'text-xs', gap: 'gap-1', pad: { text: 'px-4', lead: 'pl-2 pr-3', trail: 'pl-3 pr-2', both: 'px-2' },
    square: 'size-6 p-1', glyph: 'sq-icon-slot sq-icon-size-16', link: 'h-4', linkSquare: 'size-4' },
};

/** Paint per Figma style: `disabled` is the style's own Figma recipe (the fill at its layer opacity, the label + icon at
 *  their content opacity); a style without one yet fades as a whole (`opacity-50`). Pending the owner's Figma fixes
 *  (2026-10-22): Secondary/Plain disabled, Outline's stroke + hover, Link — kept as they were. */
const variantStyles: Record<ButtonVariant, { base?: string; active: string; inactive: string; disabled?: string }> = {
  primary: {
    active: 'bg-btn-primary-fill-hover text-btn-primary-text-default',
    inactive: 'bg-btn-primary-fill-default text-btn-primary-text-default hover:bg-btn-primary-fill-hover',
    disabled: 'bg-btn-primary-fill-disabled/10 text-btn-primary-text-disabled/40',
  },
  plain: { // the Figma's "Plain": a dark button in Light, a light one in Dark
    active: 'bg-btn-plain-fill-hover text-btn-plain-text-default',
    inactive: 'bg-btn-plain-fill-default text-btn-plain-text-default hover:bg-btn-plain-fill-hover',
  },
  secondary: {
    active: 'bg-btn-secondary-fill-hover text-btn-secondary-text-default',
    inactive: 'bg-btn-secondary-fill-default text-btn-secondary-text-default hover:bg-btn-secondary-fill-hover',
  },
  outline: {
    base: 'inset-ring inset-ring-stroke', // the Figma stroke is inside the box: no layout width; callers recolor it with inset-ring-*
    active: 'bg-bg-hover text-btn-outline-text-default',
    inactive: 'bg-transparent text-btn-outline-text-default hover:bg-bg-hover',
    disabled: 'bg-transparent text-btn-outline-text-disabled',
  },
  ghost: {
    active: 'bg-btn-ghost-active text-btn-ghost-text-default',
    inactive: 'bg-transparent text-btn-ghost-text-default hover:bg-btn-ghost-fill-hover/50',
    disabled: 'bg-transparent text-btn-ghost-text-disabled',
  },
  link: {
    base: 'underline-offset-2',
    active: 'text-btn-primary-fill-default underline',
    inactive: 'text-btn-primary-fill-default hover:underline',
  },
  danger: {
    active: 'bg-btn-danger-hover text-btn-danger-text',
    inactive: 'bg-btn-danger text-btn-danger-text hover:bg-btn-danger-hover',
  },
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      active = false,
      iconOnly = false,
      label,
      icon,
      iconRight,
      loading = false,
      disabled,
      className = '',
      children,
      ...props
    },
    ref,
  ) => {
    const variantStyle = variantStyles[variant];
    const sz = sizeStyles[size];
    const isDisabled = disabled || loading;
    const stateStyles = isDisabled
      ? variantStyle.disabled ?? `${variantStyle.inactive} opacity-50`
      : active ? variantStyle.active : variantStyle.inactive;
    const lead = loading || !!icon;
    const text = typeof (label ?? children) === 'string' ? tx((label ?? children) as string) : (label ?? children);
    const ariaLabel = typeof props['aria-label'] === 'string' ? tx(props['aria-label']) : props['aria-label'];
    const titleAttr = typeof props.title === 'string' ? tx(props.title) : props.title;
    const pad = lead && iconRight ? sz.pad.both : lead ? sz.pad.lead : iconRight ? sz.pad.trail : sz.pad.text;
    // Square = the Figma's Type=Icon, only when asked: some callers put text in `icon` (ZoomChip)
    const geometry = variant === 'link'
      ? `p-0 gap-0.5 ${sz.text} ${iconOnly ? sz.linkSquare : sz.link}`
      : iconOnly ? sz.square : `${sz.box} ${sz.text} ${sz.gap} ${pad}`;

    return (
      <button
        ref={ref}
        type="button"
        disabled={isDisabled}
        className={cx(
          baseStyles,
          geometry,
          sz.glyph,
          variantStyle.base,
          stateStyles,
          isDisabled && 'pointer-events-none',
          className,
        )}
        {...props}
        aria-label={ariaLabel}
        title={titleAttr}
      >
        {loading ? <Spinner className={sz.spinner} /> : icon}
        {text}
        {iconRight}
      </button>
    );
  },
);

Button.displayName = 'Button';

export default Button;
