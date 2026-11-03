import type { ReactNode } from 'react';
import { useApp } from '../../app/AppContext';
import { Icon } from '../../components/common/Icon';
import { useToast } from '../../components/common/Toast';
import { previewAttachment } from '../shared/preview';
import { Button, FileChip } from '../../components/common/ui';
import { Field } from '../../components/forms/Field';
import { lineLimitAmount, overLimit } from '../../domain/calc';
import { FIELD_DEFS, GRID_COLUMNS, itemByKey, typeByKey } from '../../domain/expenseSchema';
import type { AttachmentMeta, ClaimLine, EligibilityEnforcement, ExpenseItemDef, ExpenseTypeKey, FieldKey } from '../../types/domain';
import { date, dash, money, num, numFmt, time } from '../../utils/format';

const NUM_COLS: Partial<Record<FieldKey, true>> = { amount: true, qty: true, limit: true, fromKm: true, toKm: true, totalKm: true, nonAccountableKm: true };
const colLabel = (c: FieldKey): string => (c === 'attachment' ? 'Bills' : FIELD_DEFS[c]?.label ?? c);
const dim = <span className="tc-text-secondary">—</span>;

/** Bills in a table cell. Files stored on the server (fileId + docType) are listed one per line and open in a new tab, so an approver can
 *  check every bill; otherwise the original compact form (first name + "+N") is kept. */
function AttachmentLinks({ files }: { files: readonly AttachmentMeta[] }) {
  const { gateway } = useApp();
  const toast = useToast();
  if (!files.some((a) => a.fileId && a.docType)) {
    return (
      <span className="tc-row tc-nowrap" title={files.map((a) => a.name).join(', ')}>
        <Icon name="paperclip" /><span className="tc-cell-trunc">{files[0]?.name}</span>
        {files.length > 1 ? <span className="tc-more">+{files.length - 1}</span> : null}
      </span>
    );
  }
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {files.map((a, i) => (
        <span key={a.name + i} className="tc-row tc-nowrap"><Icon name="paperclip" />
          {a.fileId && a.docType
            ? <button type="button" className="tc-cell-trunc" data-testid="open-attachment" title={`Open ${a.name}`} style={{ background: 'none', border: 0, padding: 0, color: 'inherit', cursor: 'pointer', textDecoration: 'underline', font: 'inherit', textAlign: 'left' }}
                onClick={(e) => { e.stopPropagation(); previewAttachment(gateway, a).catch((err: unknown) => toast(err instanceof Error ? err.message : 'Could not open the file.', 'error')); }}>{a.name}</button>
            : <span className="tc-cell-trunc">{a.name}</span>}
        </span>
      ))}
    </span>
  );
}

/** Columns shown in the desktop line grid: the union of the fields used by the type's items, in grid order. */
export function gridColumns(type: ExpenseTypeKey): FieldKey[] {
  const used = new Set<FieldKey>();
  typeByKey(type)?.items.forEach((it) => it.fields.forEach((f) => used.add(f)));
  return GRID_COLUMNS.filter((c) => used.has(c));
}

function cellValue(def: ExpenseItemDef, it: ClaimLine, col: FieldKey): ReactNode {
  const v = it.fields[col];
  const fd = FIELD_DEFS[col];
  if (col === 'attachment') {
    const files = it.attachments ?? [];
    if (!files.length) return dim;
    return <AttachmentLinks files={files} />;
  }
  if (col === 'limit') {
    if (def.limitQty != null) return `${numFmt(def.limitQty)} L`;
    const la = lineLimitAmount(def, it.fields);
    return la == null ? <span className="tc-text-secondary">No limit</span> : money(la);
  }
  if (col === 'amount') {
    const over = overLimit(def, it.fields);
    if (over && def.limitQty == null) return <span className="tc-over" title={`Exceeds the policy limit by ${money(over)}`}><Icon name="alert" />{money(v)}</span>;
    return money(v);
  }
  if (col === 'qty') {
    if (v === '' || v == null) return '—';
    const overQ = overLimit(def, it.fields);
    return overQ ? <span className="tc-over" title={`Exceeds the cap by ${overQ} litres`}><Icon name="alert" />{numFmt(v)} L</span> : `${numFmt(v)} L`;
  }
  if (v === '' || v == null) return dim;
  if (!fd) return String(v);
  if (fd.type === 'date') return date(String(v));
  if (fd.type === 'time') return time(String(v));
  if (fd.type === 'number') return numFmt(v);
  if (col === 'remarks' || col === 'alongWith') return <span className="tc-cell-trunc" title={String(v)}>{String(v)}</span>;
  return String(v);
}

export interface ClaimItemsProps {
  items: readonly ClaimLine[];
  expenseType: ExpenseTypeKey;
  editable: boolean;
  approving: boolean;
  showApproval: boolean;
  lineErrors: Record<string, string>;
  total: number;
  approvedTotal: number;
  eligibilityByLine: ReadonlyMap<string, { limit: number | null; enforceEligibility?: EligibilityEnforcement; locationBased: boolean; dynamicLimit?: boolean }>;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onApproval: (id: string, patch: { approvedAmount?: number | null; approverRemarks?: string }) => void;
}

export function ClaimItems(p: ClaimItemsProps) {
  return (
    <>
      <div className="tc-desktop-only"><ItemsTable {...p} /></div>
      <div className="tc-mobile-only"><ItemCards {...p} /></div>
    </>
  );
}

function ItemsTable(p: ClaimItemsProps) {
  const cols = gridColumns(p.expenseType);
  return (
    <div className="tc-table-wrap">
      <table className={'tc-table tc-table--sticky' + (p.showApproval ? ' tc-table--approve' : '')} data-testid="items-table">
        <thead>
          <tr>
            <th>Expense Item</th>
            {cols.map((c) => <th key={c} className={NUM_COLS[c] ? 'tc-num' : undefined}>{colLabel(c)}</th>)}
            {p.showApproval ? <><th className="tc-num tc-col-appr-amount">Approved Amount</th><th className="tc-col-appr-remarks">Approver Remarks</th></> : null}
            {p.editable ? <th><span className="tc-visually-hidden">Actions</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {p.items.map((it, i) => {
            const d: ExpenseItemDef = itemByKey(p.expenseType, it.itemKey) ?? { key: it.itemKey, label: it.itemKey, fields: [] };
            const eligibility = p.eligibilityByLine.get(it.id);
            const eligibilityWarning = eligibility?.enforceEligibility === 'N' && eligibility.limit != null && num(it.fields.amount) > eligibility.limit;
            return (
              <tr key={it.id} data-testid="item-row">
                <td><span className="tc-text-secondary tc-mono tc-text-xs">{i + 1}</span>&nbsp; <span className="tc-medium">{d.label}</span></td>
                {cols.map((c) => <td key={c} className={NUM_COLS[c] ? 'tc-num' : undefined}>
                  {d.fields.includes(c)
                    ? c === 'amount' && eligibilityWarning
                      ? <span className="tc-over" title="Claimed amount exceeds eligibility" data-testid="eligibility-warning"><Icon name="alert" />{money(it.fields.amount)}</span>
                      : c === 'amount' && eligibility?.dynamicLimit
                        ? money(it.fields.amount)
                        : c === 'limit' && eligibility?.dynamicLimit
                          ? eligibility.limit == null ? <span className="tc-text-secondary">No limit</span> : money(eligibility.limit)
                        : cellValue(d, it, c)
                    : dim}
                </td>)}
                {p.showApproval ? (p.approving ? (
                  <>
                    <td className="tc-num tc-col-appr-amount">
                      <Field type="money" value={it.approvedAmount ?? ''} error={p.lineErrors[it.id]} ariaLabel={`Approved amount for line ${i + 1}`} testId={`appr-amount-${i}`}
                        onChange={(v) => p.onApproval(it.id, { approvedAmount: v === '' ? null : Number(v) })} />
                    </td>
                    <td className="tc-col-appr-remarks">
                      <Field type="text" value={it.approverRemarks} placeholder="Remarks" ariaLabel={`Approver remarks for line ${i + 1}`} testId={`appr-remarks-${i}`}
                        onChange={(v) => p.onApproval(it.id, { approverRemarks: String(v) })} />
                    </td>
                  </>
                ) : (
                  <>
                    <td className="tc-num tc-col-appr-amount">{it.approvedAmount == null ? '—' : money(it.approvedAmount)}</td>
                    <td className="tc-cell-wrap tc-col-appr-remarks">{dash(it.approverRemarks)}</td>
                  </>
                )) : null}
                {p.editable ? (
                  <td className="tc-cell-actions">
                    <Button variant="ghost" className="tc-btn--neutral" size="sm" iconOnly icon="edit" label={`Edit line ${i + 1}`} onClick={() => p.onEdit(it.id)} />
                    <Button variant="ghost" className="tc-btn--neutral" size="sm" iconOnly icon="trash" label={`Remove line ${i + 1}`} onClick={() => p.onRemove(it.id)} />
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            {cols.map((c) => <td key={c} className={NUM_COLS[c] ? 'tc-num' : ''}>{c === 'amount' ? money(p.total) : ''}</td>)}
            {p.showApproval ? <><td className="tc-num tc-col-appr-amount" data-approved-total>{money(p.approvedTotal)}</td><td className="tc-col-appr-remarks" /></> : null}
            {p.editable ? <td /> : null}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ItemCards(p: ClaimItemsProps) {
  return (
    <div className="tc-list">
      {p.items.map((it, i) => {
        const d: ExpenseItemDef = itemByKey(p.expenseType, it.itemKey) ?? { key: it.itemKey, label: it.itemKey, fields: [] };
        const f = it.fields;
        const eligibility = p.eligibilityByLine.get(it.id);
        const eligibilityWarning = eligibility?.enforceEligibility === 'N' && eligibility.limit != null && num(f.amount) > eligibility.limit;
        const over = eligibility?.dynamicLimit ? 0 : overLimit(d, f);
        const la = eligibility?.dynamicLimit ? eligibility.limit : lineLimitAmount(d, f);
        const facts: Array<[string, string]> = [];
        if (f.date) facts.push(['Date', date(String(f.date)) + (f.time ? ', ' + time(String(f.time)) : '')]);
        if (f.fromDate) facts.push(['Period', date(String(f.fromDate)) + (f.fromTime ? ' ' + time(String(f.fromTime)) : '') + ' – ' + date(String(f.toDate)) + (f.toTime ? ' ' + time(String(f.toTime)) : '')]);
        if (f.stayLocation) facts.push(['Stay location', String(f.stayLocation)]);
        if (f.isBillAvailable) facts.push(['Is Bill Available', String(f.isBillAvailable)]);
        if (f.fromLocation || f.toLocation) facts.push(['Route', dash(f.fromLocation) + ' → ' + dash(f.toLocation)]);
        if (f.modeOfTravel) facts.push(['Mode', String(f.modeOfTravel)]);
        if (f.billerName) facts.push(['Biller', String(f.billerName)]);
        if (f.billNumber) facts.push(['Bill number', String(f.billNumber)]);
        if (f.totalKm !== undefined && f.totalKm !== '') facts.push(['Distance', numFmt(f.totalKm) + ' km' + (num(f.nonAccountableKm) ? ` (${numFmt(f.nonAccountableKm)} km personal)` : '')]);
        if (f.qty) facts.push(['Quantity', numFmt(f.qty) + ' L']);
        if (d.fields.includes('limit')) facts.push(['Policy limit', d.limitQty != null ? numFmt(d.limitQty) + ' L' : (la == null ? 'No fixed limit' : money(la))]);
        if (f.alongWith) facts.push(['Along with', String(f.alongWith)]);
        return (
          <article key={it.id} className="tc-item-card">
            <div className="tc-item-card__top">
              <div>
                <div className="tc-item-card__title"><span className="tc-text-secondary tc-mono tc-text-xs">{i + 1}</span> {d.label}</div>
                {f.remarks ? <div className="tc-text-secondary tc-text-s">{String(f.remarks)}</div> : null}
              </div>
              <div className="tc-item-card__amount">{money(f.amount)}</div>
            </div>
            {eligibilityWarning
              ? <div className="tc-over tc-text-xs" title="Claimed amount exceeds eligibility" data-testid="eligibility-warning"><Icon name="alert" /> Exceeds eligibility</div>
              : over ? <div className="tc-over tc-text-xs"><Icon name="alert" /> Exceeds the policy limit by {d.limitQty != null ? `${over} litres` : money(over)}</div> : null}
            <div className="tc-item-card__grid">{facts.map(([k, v]) => <div key={k}><div className="tc-kv__label">{k}</div><div className="tc-kv__value">{v}</div></div>)}</div>
            {it.attachments?.length ? <div className="tc-file__chips">{it.attachments.map((a, j) => <FileChip key={a.name + j} att={a} />)}</div> : null}
            {p.showApproval ? (
              <div className="tc-item-card__approve">
                {p.approving ? (
                  <>
                    <Field label="Approved Amount" type="money" value={it.approvedAmount ?? ''} error={p.lineErrors[it.id]} onChange={(v) => p.onApproval(it.id, { approvedAmount: v === '' ? null : Number(v) })} />
                    <Field label="Approver Remarks" type="text" value={it.approverRemarks} placeholder="Optional" onChange={(v) => p.onApproval(it.id, { approverRemarks: String(v) })} />
                  </>
                ) : (
                  <>
                    <div><div className="tc-kv__label">Approved Amount</div><div className="tc-kv__value tc-mono">{it.approvedAmount == null ? '—' : money(it.approvedAmount)}</div></div>
                    <div><div className="tc-kv__label">Approver Remarks</div><div className="tc-kv__value">{dash(it.approverRemarks)}</div></div>
                  </>
                )}
              </div>
            ) : null}
            {p.editable ? (
              <div className="tc-item-card__actions">
                <Button size="sm" icon="edit" label="Edit" onClick={() => p.onEdit(it.id)} />
                <Button variant="destructive-outline" size="sm" icon="trash" label="Remove" onClick={() => p.onRemove(it.id)} />
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
