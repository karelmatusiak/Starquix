import { tx } from '@/i18n';
import { Row } from './Row';
import { Button } from './Button';

export interface OperationNoticeProps {
  title: string;
  detail?: string;
  action?: { label: string; onClick: () => void; busy?: boolean; disabled?: boolean };
  /** Pages that explain or fix it (GitHub settings, a build log): ghost buttons before the action, opened in the browser. */
  links?: { label: string; href: string }[];
  urgency?: 'polite' | 'assertive';
}
/** Curated copy only. The operation owner controls recovery and lifetime. */
export function OperationNotice({ title, detail, action, links = [], urgency = 'polite' }: OperationNoticeProps) {
  return <div role={urgency === 'assertive' ? 'alert' : 'status'} aria-live={urgency} aria-atomic="true">
    <Row hover={false} size="sm" className="h-auto min-h-8 py-2 px-2 border border-stroke rounded-inner"
      title={<div className="whitespace-normal break-words font-normal">
        <div>{tx(title)}</div>
        {detail && <div className="text-xs text-text-secondary mt-1">{tx(detail)}</div>}
      </div>}
      right={action || links.length ? [{ type: 'custom', unboxed: true, node: <div className="flex items-center gap-2">
        {links.map(l => <Button key={l.href} variant="ghost" size="sm" label={tx(l.label)} onClick={() => window.open(l.href, '_blank', 'noopener,noreferrer')} />)}
        {action && <Button variant="secondary" size="sm" label={tx(action.label)} aria-label={tx(action.label)} loading={action.busy}
          disabled={action.disabled} onClick={action.onClick} />}
      </div> }] : undefined}
    />
  </div>;
}
