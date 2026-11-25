/**
 * Labeled - the Figma Input's frame around any control in a window: the label (text-xs, dimmed: the Text/Secondary token,
 * owner 2026-10-21) 4px above it, the helper or error line 4px below. The control is a `Field size="lg"`, a Button, a SegmentedControl, or an InputGroup of them.
 *
 * @example
 * <Labeled label="Address"><Field size="lg" readOnly value={url} onChange={() => {}} aria-label="Address" /></Labeled>
 * <Labeled label="GitHub"><Button variant="outline" size="md" label="Log in" onClick={signIn} /></Labeled>
 */
import React from 'react';
import { tx } from '@/i18n';
import { cx } from './cx';
import { SkeletonText } from './Skeleton';

export interface LabeledProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  label: string;
  /** Helper line under the control (text-secondary). */
  caption?: string | null;
  /** Error line under the control; wins over `caption`. */
  error?: string | null;
  /** The loading state: the label as a bar of its own width, no helper line; pass the control's own skeleton as children. */
  skeleton?: boolean;
  children: React.ReactNode;
}

export function Labeled({ label, caption, error, skeleton = false, children, className, ...rest }: LabeledProps) {
  const line = !skeleton && (error || caption);
  return (
    <div className={cx('flex flex-col gap-1 min-w-0', className)} {...rest}>
      {skeleton ? <SkeletonText line="h-4" bar="h-2.5">{tx(label)}</SkeletonText> : <span className="text-xs text-text-secondary truncate">{tx(label)}</span>}
      {children}
      {line && <span className={cx('text-xs break-words', error ? 'text-error' : 'text-text-secondary')}>{tx(line)}</span>}
    </div>
  );
}

export default Labeled;
