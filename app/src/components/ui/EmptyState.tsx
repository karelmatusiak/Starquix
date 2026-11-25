/**
 * EmptyState - the "No X yet" block: icon + title + caption + optional action.
 */
import React from 'react';
import { tx } from '@/i18n';
import { cx } from './cx';
import { Button, type ButtonProps } from './Button';

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  caption?: string;
  /** Action button; rendered as secondary sm unless overridden */
  action?: { label: string; onClick: () => void } & Partial<Pick<ButtonProps, 'variant' | 'size' | 'icon'>>;
  className?: string;
}

export function EmptyState({ icon, title, caption, action, className = '' }: EmptyStateProps) {
  return (
    <div className={cx('flex flex-col items-center justify-center gap-2 py-8 px-4 text-center', className)}>
      {icon && <div className="text-text-secondary [&>svg]:w-8 [&>svg]:h-8">{icon}</div>}
      <div className="text-sm-medium text-text-muted">{tx(title)}</div>
      {caption && <div className="text-xs text-text-secondary max-w-64">{tx(caption)}</div>}
      {action && (
        <Button
          variant={action.variant ?? 'secondary'}
          size={action.size ?? 'sm'}
          icon={action.icon}
          label={tx(action.label)}
          onClick={action.onClick}
          className="mt-1"
        />
      )}
    </div>
  );
}
