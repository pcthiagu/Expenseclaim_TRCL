import { useState } from 'react';
import { useBillReader } from '../../app/OcrContext';
import type { ReactNode } from 'react';
import { Icon } from '../../components/common/Icon';
import { Alert, Button, FileChip } from '../../components/common/ui';
import { Field } from '../../components/forms/Field';
import { ModalFrame, useModal } from '../../components/modals/ModalHost';
import { useToast } from '../../components/common/Toast';
import { GRID_MAX_DAYS } from '../../config/policy';
import {
  applyGrid, billRequired, colTotal, copyDown, copyPreviousDay, dateList, defaultRange, filledCount, grandTotal, isOver,
  needsStayColumn, newGridState, pickableForGrid, rowTotal, seedDate, validateGrid, validateRange, type GridState,
} from '../../domain/dateWise';
import { fixedItems, lookup, typeByKey } from '../../domain/expenseSchema';
import { attachmentFromReceipt } from '../../domain/receipts';
import type { TravelClaimGateway } from '../../services/ports';
import { useReceipts } from './useReceipts';
import { useUploader } from '../shared/useUploader';
import type { AttachmentMeta, ClaimLine, ExpenseClaim, ExpenseItemDef } from '../../types/domain';
import { date, money, money0, num, plural, today } from '../../utils/format';

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const dayLabel = (iso: string): string => { const p = iso.split('-'); return DAY[new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getDay()] ?? ''; };
const limitText = (c: ExpenseItemDef): string => (c.limit != null ? `${money0(c.limit)} / ${c.limitPer ?? 'bill'}` : 'No fixed limit');
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export interface DateWiseDrawerProps {
  claim: Pick<ExpenseClaim, 'id' | 'expenseType' | 'items' | 'travelFrom' | 'travelTo'>;
  gateway: TravelClaimGateway;
  isAdmin: boolean;
  newId: () => string;
  onApply: (items: ClaimLine[]) => void;
}

export function DateWiseDrawer({ claim, gateway, isAdmin, newId, onApply }: DateWiseDrawerProps) {
  const { close } = useModal();
  const { receipts, loading: receiptsLoading } = useReceipts(gateway, isAdmin);
  const reader = useBillReader();
  const uploader = useUploader();
  const toast = useToast();
  const def = typeByKey(claim.expenseType);
  const cols = def ? fixedItems(def) : [];
  const needsStay = needsStayColumn(cols);
  const t = today();

  const seedAll = (g: GridState): void => { dateList(g.range, t).forEach((d) => seedDate(g, d, cols, claim.items)); };
  const [grid, setGrid] = useState<GridState>(() => {
    const g = newGridState(def ? defaultRange(def, cols, claim.items, claim.travelFrom, claim.travelTo, t) : { from: t, to: t });
    seedAll(g);
    return g;
  });
  const [openBills, setOpenBills] = useState<string | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [cellErr, setCellErr] = useState<Record<string, true>>({});
  const [stayErr, setStayErr] = useState<Record<string, true>>({});
  const [gsummary, setGsummary] = useState<string[]>([]);

  const mutate = (fn: (g: GridState) => void): void => setGrid((prev) => { const g = clone(prev); fn(g); seedAll(g); return g; });
  const rangeErr = validateRange(grid.range, t);
  const list = dateList(grid.range, t);
  const footerLabel = (): string => { const n = filledCount(grid, list, cols); return n ? `Apply ${plural(n, 'entry', 'entries')} · ${money(grandTotal(grid, list, cols))}` : 'Apply'; };

  const clearErr = (key: string): void => setCellErr((e) => { if (!e[key]) return e; const n = { ...e }; delete n[key]; return n; });

  const apply = (): void => {
    if (rangeErr.from || rangeErr.to) return;
    const v = validateGrid(grid, list, cols);
    setCellErr(v.cellErr); setStayErr(v.stayErr); setGsummary(v.summary);
    if (!v.ok) return;
    const r = applyGrid(claim.items, list, cols, grid, newId);
    if (!r.added && !r.updated && !r.removed) { toast('No changes to apply', 'info'); return; }
    onApply(r.items);
    close();
    const parts: string[] = [];
    if (r.added) parts.push(`${r.added} added`);
    if (r.updated) parts.push(`${r.updated} updated`);
    if (r.removed) parts.push(`${r.removed} removed`);
    toast('Date-wise entries applied · ' + parts.join(', '));
  };

  const fill = (key: string): void => {
    const get = (g: GridState, d: string): string | undefined => (key === 'stay' ? g.stay[d] : g.cells[d]?.[key]);
    const isEmpty = (v: string | undefined): boolean => v === '' || v == null;
    if (list.every((d) => isEmpty(get(grid, d)))) { toast('Enter a value on the first date, then copy it down', 'warning'); return; }
    const empties = list.filter((d) => isEmpty(get(grid, d))).length;
    mutate((g) => {
      copyDown(list, (d) => get(g, d), (d, v) => { if (key === 'stay') g.stay[d] = v; else (g.cells[d] as Record<string, string>)[key] = v; });
    });
    toast(empties ? `Copied to ${plural(empties, 'empty date')}` : 'No empty dates to fill', 'info');
  };

  const addBillFiles = async (d: string, k: string, files: File[]): Promise<void> => {
    const { metas, accepted } = await uploader.upload(files, { kind: 'claim', recordId: claim.id });
    if (!metas.length) return;
    mutate((g) => { (g.bills[d] as Record<string, AttachmentMeta[]>)[k] = [...(g.bills[d]?.[k] ?? []), ...metas]; });
    clearErr(`${d}|${k}`);
    toast(`${plural(metas.length, 'bill')} attached`, 'info');
    if (reader.enabled) void readIntoCell(d, k, accepted);
  };

  /** Reads uploaded bills and fills the cell's amount ONLY if it is still blank (several bills add up). The user always checks it. */
  const readIntoCell = async (d: string, k: string, files: File[]): Promise<void> => {
    let total = 0;
    for (const f of files) {
      const { suggestion, error: err } = await reader.read(f);
      if (err) { toast(`${f.name}: ${err}`, 'warning'); continue; }
      if (suggestion?.amount) total += suggestion.amount.value;
    }
    if (total <= 0) return;
    let filled = false;
    mutate((g) => { const row = g.cells[d] as Record<string, string>; if (!(num(row[k]) > 0)) { row[k] = String(Math.round(total * 100) / 100); filled = true; } });
    toast(`Amount read from the bill: ${money(total)}. Please check it.`, 'info');
    void filled;
  };

  const attachPicked = (d: string, k: string): void => {
    const ids = Object.keys(checked).filter((x) => checked[x]);
    if (!ids.length) { toast('Select at least one bill', 'warning'); return; }
    const picked = receipts.filter((r) => ids.includes(r.id));
    mutate((g) => {
      const row = g.bills[d] as Record<string, AttachmentMeta[]>;
      row[k] = [...(row[k] ?? []), ...picked.map(attachmentFromReceipt)];
      const cells = g.cells[d] as Record<string, string>;
      if (!(num(cells[k]) > 0)) { const sum = picked.reduce((a, r) => a + num(r.amount), 0); if (sum > 0) cells[k] = String(sum); }
    });
    clearErr(`${d}|${k}`);
    setPickOpen(false); setChecked({});
    toast(`${plural(ids.length, 'bill')} attached from your receipt box`, 'info');
  };

  const billsPanel = (colspan: number): ReactNode => {
    if (!openBills) return null;
    const [d = '', k = ''] = openBills.split('|');
    const c = cols.find((x) => x.key === k);
    if (!c) return null;
    const files = grid.bills[d]?.[k] ?? [];
    const free = isAdmin ? [] : pickableForGrid(receipts, claim.items, list, cols, grid, claim.id);
    return (
      <tr className="tc-dategrid__billsrow" key={'bills-' + openBills}>
        <td colSpan={colspan}>
          <div className="tc-dategrid__bills" role="region" aria-label={`Bills for ${c.label}, ${date(d)}`} data-testid="bills-panel">
            <div className="tc-dategrid__billshead">
              <span className="tc-medium"><Icon name="paperclip" /> Bills · {c.label} · {date(d)}</span>
              <Button variant="ghost" className="tc-btn--neutral" size="xs" iconOnly icon="close" label="Close bills" onClick={() => { setOpenBills(null); setPickOpen(false); }} />
            </div>
            {files.length
              ? <div className="tc-file__chips">{files.map((a, i) => <FileChip key={a.name + i} att={a} onRemove={() => { mutate((g) => { (g.bills[d] as Record<string, AttachmentMeta[]>)[k] = (g.bills[d]?.[k] ?? []).filter((_, j) => j !== i); }); }} />)}</div>
              : <p className="tc-text-secondary tc-text-s">No bills on this entry yet. {billRequired(c) ? 'A bill is required for this item.' : 'Bills are optional.'} If the amount is blank it fills from the receipt box bills you pick.</p>}
            <div className="tc-row">
              <label className="tc-btn tc-btn--secondary tc-btn--sm"><Icon name="upload" /><span>Upload bills</span>
                <input type="file" className="tc-visually-hidden" multiple data-testid="bill-upload" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                  onChange={(e) => { const fl = Array.from<File>(e.target.files ?? []); e.target.value = ''; addBillFiles(d, k, fl); }} />
              </label>
              {isAdmin ? null : <Button variant="ghost" size="sm" icon="inbox" label={receiptsLoading ? 'Loading receipt box…' : free.length ? `Choose from receipt box (${free.length})` : 'Receipt box has no unused bills'} disabled={receiptsLoading || !free.length || pickOpen} onClick={() => setPickOpen(true)} data-testid="grid-picker-open" />}
            </div>
            {pickOpen && free.length ? (
              <fieldset className="tc-receiptpick tc-receiptpick--open">
                <legend>Choose bills from your receipt box</legend>
                <div className="tc-receiptpick__list">
                  {free.map((r) => (
                    <label key={r.id} className="tc-receiptpick__row">
                      <input type="checkbox" checked={!!checked[r.id]} data-testid={`grid-pick-${r.id}`} onChange={(e) => setChecked((x) => ({ ...x, [r.id]: e.target.checked }))} />
                      <span className="tc-receiptpick__name"><Icon name={r.file.type.indexOf('image') === 0 ? 'eye' : 'file'} />{r.file.name}</span>
                      <span className="tc-receiptpick__meta">{[r.billerName, r.date ? date(r.date) : ''].filter(Boolean).join(' · ') || 'No details yet'}</span>
                      <span className="tc-receiptpick__amt tc-mono">{r.amount ? money(r.amount) : '—'}</span>
                    </label>
                  ))}
                </div>
                <div className="tc-receiptpick__foot">
                  <Button variant="ghost" className="tc-btn--neutral" size="sm" label="Cancel" onClick={() => setPickOpen(false)} />
                  <Button size="sm" icon="paperclip" label="Attach selected" onClick={() => attachPicked(d, k)} data-testid="grid-picker-attach" />
                </div>
              </fieldset>
            ) : null}
          </div>
        </td>
      </tr>
    );
  };

  const fillBtn = (key: string, label: string): ReactNode => (
    <Button variant="ghost" className="tc-btn--neutral tc-dategrid__fill" size="xs" iconOnly icon="corner-down-right" label={`Copy the first ${label} to every empty date`} onClick={() => fill(key)} data-testid={`fill-${key}`} />
  );

  const cell = (d: string, c: ExpenseItemDef): ReactNode => {
    const v = grid.cells[d]?.[c.key] ?? '';
    const key = `${d}|${c.key}`;
    const err = cellErr[key];
    const o = !err && isOver(c, v);
    const n = grid.bills[d]?.[c.key]?.length ?? 0;
    const isOpen = openBills === key;
    const billLabel = `Bills for ${c.label}, ${date(d)}${n ? ` (${n} attached)` : ''}`;
    return (
      <td key={c.key} className={'tc-dategrid__cell' + (err ? ' is-error' : o ? ' is-over' : '')} data-label={c.short ?? c.label}>
        <div className="tc-dategrid__cellrow">
          <div className="tc-input-group">
            <span className="tc-input-prefix" aria-hidden="true">₹</span>
            <input type="number" inputMode="decimal" step={0.01} min={0} className="tc-input tc-input--num tc-input--sm" value={v} data-testid={`cell-${d}-${c.key}`}
              aria-label={`${c.label}, ${date(d)}`} aria-invalid={err ? true : undefined} title={o ? `Over the ${limitText(c)} limit` : undefined}
              onChange={(e) => { const val = e.target.value; clearErr(key); mutate((g) => { (g.cells[d] as Record<string, string>)[c.key] = val; }); }} />
          </div>
          <button type="button" className={'tc-btn tc-btn--ghost tc-btn--xs tc-dategrid__billbtn' + (n ? ' has-bills' : '') + (isOpen ? ' is-on' : '')} aria-expanded={isOpen}
            aria-label={billLabel} title={billLabel} data-testid={`bills-${d}-${c.key}`} onClick={() => { setOpenBills(isOpen ? null : key); setPickOpen(false); }}>
            <Icon name="paperclip" />{n ? <span className="tc-dategrid__billcount">{n}</span> : null}
          </button>
        </div>
      </td>
    );
  };

  const colspan = (needsStay ? 3 : 2) + cols.length;
  const table = (
    <div className="tc-dategrid__wrap">
      <table className="tc-dategrid" data-testid="dategrid">
        <thead>
          <tr>
            <th scope="col" className="tc-dategrid__date">Date</th>
            {needsStay ? <th scope="col"><span className="tc-dategrid__th">Stay location{fillBtn('stay', 'stay location')}</span></th> : null}
            {cols.map((c) => (
              <th key={c.key} scope="col" className="tc-num">
                <span className="tc-dategrid__th">{c.short ?? c.label}{fillBtn(c.key, `${(c.short ?? c.label).toLowerCase()} amount`)}</span>
                <span className="tc-dategrid__limit">{limitText(c)}{billRequired(c) ? ' · bill required' : ''}</span>
              </th>
            ))}
            <th scope="col" className="tc-num">Day total</th>
          </tr>
        </thead>
        <tbody>
          {list.flatMap((d, i) => {
            const dl = dayLabel(d);
            const prev = list[i - 1];
            const rows: ReactNode[] = [
              <tr key={d} className={dl === 'Sun' ? 'is-weekend' : ''} data-testid={`row-${d}`}>
                <th scope="row" className="tc-dategrid__date">
                  <span className="tc-dategrid__day">{dl}</span> {date(d)}
                  {prev ? <Button variant="ghost" size="xs" icon="copy" label="Same as previous day" className="tc-dategrid__copyprev" onClick={() => mutate((g) => copyPreviousDay(g, d, prev, cols))} data-testid={`prev-${d}`} /> : null}
                </th>
                {needsStay ? (
                  <td className={'tc-dategrid__stay' + (stayErr[d] ? ' is-error' : '')} data-label="Stay location">
                    <div className="tc-select-wrap">
                      <select className="tc-input tc-select tc-input--sm" value={grid.stay[d] ?? ''} aria-label={`Stay location, ${date(d)}`} aria-invalid={stayErr[d] ? true : undefined} data-testid={`stay-${d}`}
                        onChange={(e) => { const val = e.target.value; setStayErr((x) => { const n = { ...x }; delete n[d]; return n; }); mutate((g) => { g.stay[d] = val; }); }}>
                        <option value="">Select</option>
                        {lookup('CITIES').map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <Icon name="chevron-down" className="tc-select-chevron" />
                    </div>
                  </td>
                ) : null}
                {cols.map((c) => cell(d, c))}
                <td className="tc-num tc-dategrid__total" data-label="Day total" data-testid={`rowtotal-${d}`}>{money(rowTotal(grid, d, cols))}</td>
              </tr>,
            ];
            if (openBills && openBills.split('|')[0] === d) rows.push(billsPanel(colspan));
            return rows;
          })}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="tc-dategrid__date">Total</th>
            {needsStay ? <td className="tc-dategrid__stay" /> : null}
            {cols.map((c) => <td key={c.key} className="tc-num" data-label={c.short ?? c.label} data-testid={`coltotal-${c.key}`}>{money(colTotal(grid, list, c))}</td>)}
            <td className="tc-num tc-dategrid__total" data-label="Grand total" data-testid="grandtotal">{money(grandTotal(grid, list, cols))}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );

  return (
    <ModalFrame title="Date-wise entry" size="drawer" className="tc-modal--wide" autoFocus={false} testId="dategrid-modal"
      footer={<><Button label="Cancel" onClick={close} /><Button variant="primary" icon="check" label={uploader.uploading ? 'Uploading…' : footerLabel()} disabled={uploader.uploading} onClick={apply} data-testid="grid-apply" /></>}>
      <div className="tc-stack tc-stack--16">
        {gsummary.length ? <Alert tone="error" title="Please fix the highlighted entries"><ul>{gsummary.map((s) => <li key={s}>{s}</li>)}</ul></Alert> : null}
        <p className="tc-text-secondary tc-text-s">Enter the amount for each date under the expense item. Leave a cell blank for days without that expense. Use the paperclip beside an amount to attach bills. Each filled cell becomes one line on the claim; lines on other dates stay as they are.</p>
        <div className="tc-dategrid__range">
          <Field label="From Date" type="date" value={grid.range.from} required max={t} error={rangeErr.from} testId="range-from" onChange={(v) => { setGsummary([]); mutate((g) => { g.range = { ...g.range, from: String(v) }; }); }} />
          <Field label="To Date" type="date" value={grid.range.to} required max={t} error={rangeErr.to} helper={rangeErr.to ? undefined : `Up to ${GRID_MAX_DAYS} days at a time`} testId="range-to" onChange={(v) => { setGsummary([]); mutate((g) => { g.range = { ...g.range, to: String(v) }; }); }} />
        </div>
        {list.length ? table : null}
      </div>
    </ModalFrame>
  );
}
