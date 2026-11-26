import React from 'react';
import { t } from '@/i18n';
import type { PageSeoScore } from '@/store/seo/pageSeoScore';

const FONT_MAP = {
  red: 'text-error',
  yellow: 'text-warning',
  green: 'text-success',
};

export const CompletenessBar: React.FC<{ result: PageSeoScore }> = ({ result }) => {
  const score = Math.round(result.percentage);

  return (
    <div className="flex justify-between px-2.5 py-2 gap-0.5 bg-bg-contrast">
      <div className="flex gap-1">
        <div className="text-xs text-text-muted leading-tight">{t('Score:')}</div>
        <div className={`text-xs ${FONT_MAP[result.color]}`}>{score}</div>
      </div>
      <div className="flex gap-1 opacity-50">
        <div className="text-xs text-text-muted leading-tight">{t('Hint:')}</div>
        {result.hint && (
          <div className="text-xs font-normal text-text-muted">{t(result.hint)}</div>
        )}
      </div>
    </div>
  );
};
