import type { ReactNode } from 'react';
import { STATUSES, typeByKey } from '../../domain/expenseSchema';
import { statusLabel } from '../../domain/workflow';
import type { AttachmentMeta, RequestStatus, Role } from '../../types/domain';
import { fileSize } from '../../utils/format';
import { Icon } from './Icon';
import { useApp } from '../../app/AppContext';
import { previewAttachment } from '../../pages/shared/preview';
import { useToast } from './Toast';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'destructive-outline';

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: 'xs' | 'sm';
  icon?: string;
  iconRight?: string;
  iconOnly?: boolean;
  label?: string;
  block?: boolean;
  className?: string;
  href?: string;
  disabled?: boolean;
  type?: 'button' | 'submit';
  onClick?: () => void;
  id?: string;
  'data-testid'?: string;
  'aria-expanded'?: boolean;
  title?: string;
  /** Emits a bare data-<hook> attribute: app.css targets some buttons that way (print, delete, save, submit, approve, reject, copy). */
  hook?: 'print' | 'delete' | 'save' | 'submit' | 'approve' | 'reject' | 'copy';
  children?: ReactNode;
}

/** Button / link styled with the RXD classes (tc-btn tc-btn--*). */
export function Button(p: ButtonProps) {
  const cls = ['tc-btn', 'tc-btn--' + (p.variant ?? 'secondary')];
  if (p.size) cls.push('tc-btn--' + p.size);
  if (p.iconOnly) cls.push('tc-btn--icon');
  if (p.block) cls.push('tc-btn--block');
  if (p.className) cls.push(p.className);
  const inner = (
    <>
      {p.icon ? <Icon name={p.icon} /> : null}
      {p.label && !p.iconOnly ? <span>{p.label}</span> : null}
      {p.iconRight ? <Icon name={p.iconRight} /> : null}
      {p.children}
    </>
  );
  const hookAttr = p.hook ? { [`data-${p.hook}`]: '' } : {};
  const common = {
    ...hookAttr, className: cls.join(' '), id: p.id, 'data-testid': p['data-testid'],
    'aria-label': p.iconOnly && p.label ? p.label : undefined, title: p.iconOnly && p.label ? p.label : p.title,
    'aria-expanded': p['aria-expanded'],
  };
  if (p.href) return <a href={p.href} {...common}>{inner}</a>;
  return (
    <button type={p.type ?? 'button'} disabled={p.disabled} aria-disabled={p.disabled ? true : undefined} onClick={p.onClick} {...common}>
      {inner}
    </button>
  );
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: string }) {
  return <span className={`tc-badge tc-badge--${tone}`}>{label}</span>;
}

/** Status badge. Approvers read "Submitted" as "Pending Approval". */
export function StatusBadge({ status, role }: { status: RequestStatus; role: Role }) {
  const st = STATUSES[status];
  return <Badge label={statusLabel(status, role)} tone={st?.tone ?? 'neutral'} />;
}

export function Tag({ label, family = 'neutral' }: { label: string; family?: string }) {
  return <span className={`tc-tag tc-tag--${family}`}>{label}</span>;
}

export function TypeTag({ typeKey }: { typeKey: string }) {
  const t = typeByKey(typeKey);
  return t ? <Tag label={t.short} family={t.family} /> : <Tag label={typeKey || '—'} />;
}

export function Count({ n, tone }: { n: number | string; tone?: string }) {
  return <span className={'tc-count' + (tone ? ' tc-count--' + tone : '')}>{n}</span>;
}

export function Alert({ tone = 'info', title, children, action, id }: { tone?: 'info' | 'success' | 'warning' | 'error'; title?: string; children?: ReactNode; action?: ReactNode; id?: string }) {
  const ic = tone === 'error' ? 'x-circle' : tone === 'success' ? 'check-circle' : tone === 'warning' ? 'alert' : 'info';
  return (
    <div className={`tc-alert tc-alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'} id={id}>
      <Icon name={ic} />
      <div className="tc-alert__content">
        {title ? <div className="tc-alert__title">{title}</div> : null}
        {children ? <div className="tc-alert__body">{children}</div> : null}
      </div>
      {action ? <div className="tc-alert__action">{action}</div> : null}
    </div>
  );
}

export function EmptyState({ icon = 'inbox', title, body, action }: { icon?: string; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="tc-empty">
      <Icon name={icon} size={32} />
      <div className="tc-empty__title">{title}</div>
      {body ? <p className="tc-empty__body">{body}</p> : null}
      {action ? <div className="tc-empty__action">{action}</div> : null}
    </div>
  );
}

export function Meter({ label, used, limit, valueText, sub }: { label: string; used: number; limit: number; valueText?: string; sub?: string }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'brand';
  return (
    <div className="tc-meter">
      <div className="tc-meter__head"><span className="tc-meter__label">{label}</span><span className="tc-meter__value">{valueText}</span></div>
      <div className={`tc-meter__track tc-meter__track--${tone}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
        <div className="tc-meter__fill" style={{ width: pct + '%' }} />
      </div>
      {sub ? <div className="tc-meter__sub">{sub}</div> : null}
    </div>
  );
}

export function FileChip({ att, onRemove }: { att: AttachmentMeta; onRemove?: () => void }) {
  const { gateway } = useApp();
  const toast = useToast();
  const openable = !!att.fileId && !!att.docType; // uploaded to the server: can be opened
  const name = <span className="tc-file-chip__name" title={att.name}>{att.name}</span>;
  return (
    <span className="tc-file-chip">
      <Icon name={att.type && att.type.indexOf('image') === 0 ? 'eye' : 'file'} />
      {openable
        ? <button type="button" className="tc-file-chip__name" title={`Open ${att.name}`} data-testid="open-attachment"
            style={{ background: 'none', border: 0, padding: 0, color: 'inherit', cursor: 'pointer', textDecoration: 'underline', font: 'inherit' }}
            onClick={() => { previewAttachment(gateway, att).catch((e: unknown) => toast(e instanceof Error ? e.message : 'Could not open the file.', 'error')); }}>{att.name}</button>
        : name}
      <span className="tc-file-chip__meta">{fileSize(att.size)}</span>
      {onRemove ? (
        <button type="button" className="tc-file-chip__remove" onClick={onRemove} aria-label={`Remove ${att.name}`}><Icon name="close" /></button>
      ) : null}
    </span>
  );
}

export function Pagination({ page, pageSize, total, onPage, onSize }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; onSize: (s: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  const start = total ? (p - 1) * pageSize + 1 : 0;
  const end = Math.min(total, p * pageSize);
  const nav = (ic: string, label: string, target: number, disabled: boolean) => (
    <Button variant="ghost" className="tc-btn--neutral" iconOnly icon={ic} label={label} size="xs" disabled={disabled} onClick={() => onPage(target)} />
  );
  return (
    <div className="tc-pagination">
      <div className="tc-pagination__left">
        <label className="tc-pagination__size">Rows{' '}
          <span className="tc-select-wrap">
            <select className="tc-input tc-select tc-input--sm" aria-label="Rows per page" value={pageSize} onChange={(e) => onSize(parseInt(e.target.value, 10) || 10)}>
              {[10, 25, 50].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <Icon name="chevron-down" className="tc-select-chevron" />
          </span>
        </label>
        <span className="tc-pagination__range">Showing {start}–{end} of {total}</span>
      </div>
      <span className="tc-pagination__nav">
        {nav('chevrons-left', 'First page', 1, p <= 1)}{nav('chevron-left', 'Previous page', p - 1, p <= 1)}
        <span className="tc-pagination__page">Page {p} of {pages}</span>
        {nav('chevron-right', 'Next page', p + 1, p >= pages)}{nav('chevrons-right', 'Last page', pages, p >= pages)}
      </span>
    </div>
  );
}
