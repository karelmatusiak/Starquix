/**
 * Tabs - Figma-style tab strip with underline active indicator.
 * (Ported from DesignBar/shared/Tab — THE tab implementation.)
 */
import React from 'react';
import { tx } from '@/i18n';
import { cx } from './cx';

export interface TabOption {
  value: string;
  label: string;
  title?: string;
}

export interface TabsProps {
  options: TabOption[];
  value: string;
  onChange: (value: string) => void;
  size?: 'md' | 'sm';
  className?: string;
}

export const Tabs: React.FC<TabsProps> = ({ options, value, onChange, size = 'md', className = '' }) => {
  const sizeClasses = size === 'sm' ? 'py-3 text-xs' : 'py-4 text-sm';

  return (
    <div className={cx('flex items-stretch gap-4', className)} role="tablist">
      {options.map((option) => {
        const isActive = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(option.value)}
            title={tx(option.title || option.label)}
            className={cx(
              'relative flex items-center border-none bg-transparent cursor-pointer transition-colors font-medium',
              sizeClasses,
              isActive ? 'text-text' : 'text-text-secondary hover:text-text',
            )}
          >
            {tx(option.label)}
            {isActive && <span className="absolute bottom-0 left-0 right-0 h-px bg-text rounded-full" />}
          </button>
        );
      })}
    </div>
  );
};

export function TabPanel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={className}>{children}</div>;
}

export default Tabs;
