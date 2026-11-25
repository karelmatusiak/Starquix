/**
 * Field - THE input. Text/number/date inputs, textareas and selects, one API.
 *
 * Slots: `label`/`icon` (leading, legacy) or `leftSlot`; `unit`/`suffix`
 * (trailing text) or `trailing`/`rightSlot`. `error` renders an error border +
 * message line; `mono` renders monospace value text.
 *
 * Presets: SearchField, UnitField, InlineEdit (see their files).
 *
 * @example
 * <Field label="W" value={width} onChange={setWidth} />
 * <Field as="select" label="Font" value={font} onChange={setFont} options={FONTS} />
 * <Field value={slug} onChange={setSlug} error="Already taken" mono />
 */
import React, { forwardRef, useCallback, useContext, useRef } from 'react';
import { tx } from '@/i18n';
import { GestureHostContext, useValueGesture } from './valueGesture';
import { InputContainer, type InputSize } from './InputContainer';
import { ChevronDownIcon } from '@/assets/icons';
import { cx } from './cx';
import { Skeleton } from './Skeleton';

/** THE dropdown chevron: a select Field's, and any field-looking trigger's (the font and colour pickers). */
export const FieldChevron = () => <ChevronDownIcon className="w-4 h-4 shrink-0 text-text-secondary" />;
/** A Button that looks like a select Field: the Field's 1px edge (a real border, not the outline's inset ring) and its
 *  4px trailing gap, so a `<FieldChevron />` as the Button's last child sits exactly where a select Field's does. */
export const fieldTrigger = 'h-7 py-0 pr-1 font-normal bg-input-fill inset-ring-0 border border-input-stroke';

const SKELETON_BOX: Record<InputSize, string> = { sm: 'h-6', md: 'h-7', lg: 'h-8' }; // InputContainer's heights

export type { InputSize };

export interface SelectOption {
  value: string;
  label: string;
}

interface FieldBaseProps {
  value: string | number;
  onChange: (value: string) => void;
  /** Leading text label (16×16 slot; word labels should also pass aria-label) */
  label?: string;
  'aria-label'?: string;
  /** Leading icon (takes precedence over label) */
  icon?: React.ReactNode;
  /** Alias for icon/label slot */
  leftSlot?: React.ReactNode;
  /** Trailing unit string (e.g. "px", "%") — input mode only */
  unit?: string;
  /** Trailing element (e.g. a button) */
  trailing?: React.ReactNode;
  /** Alias for trailing */
  rightSlot?: React.ReactNode;
  /** Alias for unit */
  suffix?: string;
  /** Leading text inside the input line (e.g. "https://") */
  prefix?: string;
  /** Error state; a string also renders as a message under the field */
  error?: boolean | string;
  /** Monospace value text */
  mono?: boolean;
  /** Caption line under the field */
  caption?: string;
  /** The loading state: the field's own box as a pulsing shape (no input) — see Row `skeleton` */
  skeleton?: boolean;
  /** Several elements selected and their values differ: show "Mixed", never a value
   *  (input = empty + placeholder; select = an unpickable "Mixed" option). */
  mixed?: boolean;
  size?: InputSize;
  containerClassName?: string;
  disabled?: boolean;
  className?: string;
}

interface FieldInputProps extends FieldBaseProps {
  as?: 'input';
  type?: 'text' | 'number' | 'date' | 'password';
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  onFocus?: (e: React.FocusEvent<HTMLInputElement>) => void;
  title?: string;
  /** Selectable, not editable: a value the user reads or copies (an address, a repository). */
  readOnly?: boolean;
  /** A read-only field that opens something (its menu) on click gets a pointer. */
  onClick?: (e: React.MouseEvent<HTMLInputElement>) => void;
  /** Defaults to 'new-password' for type="password": a token field must never get the browser's saved password. */
  autoComplete?: string;
}

interface FieldSelectProps extends FieldBaseProps {
  as: 'select';
  options: SelectOption[];
  placeholder?: string;
  showChevron?: boolean;
}

interface FieldTextareaProps extends FieldBaseProps {
  as: 'textarea';
  rows?: number;
  placeholder?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
  onFocus?: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
}
export type FieldProps = FieldInputProps | FieldSelectProps | FieldTextareaProps;

const baseFieldStyles = 'flex-1 h-full px-2 bg-transparent text-text outline-none min-w-0';

export const Field = forwardRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, FieldProps>(
  (props, ref) => {
    const {
      value,
      onChange,
      label,
      icon,
      leftSlot,
      rightSlot,
      suffix,
      prefix,
      error,
      mono,
      caption,
      size = 'md',
      containerClassName = '',
      disabled,
      className,
    } = props;

    // Mixed shows no value: typing or picking sets one for every selected element.
    const shown = props.mixed ? '' : value;

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        onChange(e.target.value);
      },
      [onChange],
    );

    const inputProps = props.as === 'select' || props.as === 'textarea' ? null : props;
    const numericMin = inputProps?.min;
    const numericMax = inputProps?.max;

    // Value gesture kit (instant-edit P2): a number field under a GestureHost types into a draft that commits once (settle,
    // Enter, Tab, blur), steps by preview ticks that commit once, and aborts on Esc. No host / custom onKeyDown = per-event
    // commit exactly as before.
    const gestureHost = useContext(GestureHostContext);
    const gestureOn = !!gestureHost && inputProps?.type === 'number' && !inputProps.onKeyDown;
    const gesture = useValueGesture({
      value: String(shown ?? ''), onChange: onChange as (text: string) => void, host: gestureHost, enabled: gestureOn,
      min: numericMin, max: numericMax,
    });

    // Universal numeric-input stepping: ↑/↓ = ±1, Shift+↑/↓ = ±10.
    // Only applied when the caller passes no custom `onKeyDown`.
    // The value of the last handled arrow press. Key events can arrive faster than React re-renders (key repeat
    // at 30/s while the editor is busy), so stepping from the RENDERED value repeated the same number and lost
    // increments. Dropped when the rendered value catches up to it, and on blur.
    const running = useRef<number | null>(null);
    const rendered = typeof value === 'number' ? value : parseFloat(String(value));
    if (running.current !== null && (props.mixed || rendered === running.current)) running.current = null; // Mixed shows no number to step from
    const handleNumericKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        const current = running.current ?? (typeof shown === 'number' ? shown : parseFloat(String(shown)));
        if (!Number.isFinite(current)) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const delta = e.key === 'ArrowUp' ? step : -step;
        let next = current + delta;
        if (numericMin !== undefined && next < numericMin) next = numericMin;
        if (numericMax !== undefined && next > numericMax) next = numericMax;
        running.current = next;
        onChange(String(next));
      },
      [shown, numericMin, numericMax, onChange],
    );

    if (props.skeleton) return <Skeleton className={cx('w-full min-w-0 rounded-inner', SKELETON_BOX[size], containerClassName || className)} />;

    const leading = leftSlot ?? icon ?? (typeof label === 'string' ? tx(label) : label);

    let trailing: React.ReactNode = props.trailing ?? rightSlot;
    if (props.as === 'select') {
      const showChevron = props.showChevron ?? true;
      if (showChevron && !trailing) trailing = <FieldChevron />;
    } else if (props.as !== 'textarea' && (props.unit ?? suffix) && !trailing) {
      trailing = props.unit ?? suffix;
    }

    const opensOnClick = props.as === 'select' || (!!inputProps?.readOnly && !!inputProps.onClick);
    const lg = size === 'lg';
    const valueClasses = cx(baseFieldStyles, lg ? 'text-sm' : 'text-xs', mono && 'font-mono');

    const field = (
      <InputContainer
        leading={leading}
        trailing={trailing}
        trailingInteractive={props.as !== 'select'}
        size={size}
        disabled={disabled}
        error={!!error}
        className={cx(props.as === 'textarea' && 'h-auto', opensOnClick ? 'cursor-pointer' : 'cursor-text', containerClassName || className)}
      >
        {prefix && <span className="text-xs text-text-secondary shrink-0 pl-2 -mr-2">{prefix}</span>}
        {props.as === 'textarea' ? (
          <textarea ref={ref as React.Ref<HTMLTextAreaElement>} value={shown} rows={props.rows ?? 4}
            aria-label={tx(props['aria-label'])} placeholder={props.mixed ? tx('Mixed') : tx(props.placeholder)} disabled={disabled}
            onChange={handleChange} onKeyDown={props.onKeyDown} onBlur={props.onBlur} onFocus={props.onFocus}
            className={cx(valueClasses, 'py-2 resize-y min-h-20')} />
        ) : props.as === 'select' ? (
          <select
            ref={ref as React.Ref<HTMLSelectElement>}
            value={shown}
            onChange={handleChange}
            disabled={disabled}
            aria-label={tx(props['aria-label'])}
            className={cx(valueClasses, 'cursor-pointer appearance-none')}
          >
            {/* Mixed: shown but never pickable — the placeholder option is a real value ("clear") */}
            {props.mixed
              ? <option value="" disabled hidden>{tx('Mixed')}</option>
              : props.placeholder && <option value="">{tx(props.placeholder)}</option>}
            {props.options.map((option) => (
              <option key={option.value} value={option.value}>
                {tx(option.label)}
              </option>
            ))}
          </select>
        ) : (
          <input
            ref={ref as React.Ref<HTMLInputElement>}
            type={props.type || 'text'}
            value={gestureOn ? gesture.text : shown}
            onChange={gestureOn ? (e) => gesture.onText(e.target.value) : handleChange}
            onCompositionStart={gestureOn ? gesture.onCompositionStart : undefined}
            onCompositionEnd={gestureOn ? gesture.onCompositionEnd : undefined}
            onKeyDown={props.onKeyDown ?? (props.type === 'number' ? (gestureOn ? gesture.onKeyDown : handleNumericKeyDown) : undefined)}
            onBlur={(e) => { running.current = null; if (gestureOn) gesture.onBlur(); props.onBlur?.(e); }}
            onFocus={props.onFocus}
            title={props.title}
            readOnly={props.readOnly}
            onClick={props.onClick}
            aria-label={tx(props['aria-label'])}
            disabled={disabled}
            placeholder={props.mixed ? tx('Mixed') : tx(props.placeholder)}
            min={props.min}
            max={props.max}
            step={props.step}
            autoComplete={props.autoComplete ?? (props.type === 'password' ? 'new-password' : undefined)}
            className={cx(valueClasses, 'placeholder:text-text-secondary', props.readOnly && 'text-ellipsis', props.readOnly && props.onClick && 'cursor-pointer')}
          />
        )}
      </InputContainer>
    );

    if (typeof error === 'string' || caption) {
      return (
        <div className="min-w-0">
          {field}
          {typeof error === 'string' ? (
            <div className={cx(lg ? 'text-xs mt-1' : 'text-2xs mt-0.5', 'text-error truncate')}>{tx(error)}</div>
          ) : (
            caption && <div className={cx(lg ? 'text-xs mt-1' : 'text-2xs mt-0.5', 'text-text-secondary truncate')}>{tx(caption)}</div>
          )}
        </div>
      );
    }
    return field;
  },
);

Field.displayName = 'Field';

export default Field;
