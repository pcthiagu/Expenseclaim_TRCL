import { GRID_MAX_DAYS } from '../config/policy';
import { roundMoney } from '../domain/calc';
import type { AttachmentMeta, ClaimLine, ExpenseItemDef, ExpenseTypeDef, Receipt } from '../types/domain';
import { addDays, daysBetween, date as fmtDate, num } from '../utils/format';

/**
 * Date-wise entry grid (claimForm.js openDateGrid): dates are rows, the type's `fixed` items are
 * columns. A filled cell becomes (or updates) one claim line for that date+item; a cleared cell
 * removes it; lines on dates outside the range are untouched. All functions here are pure.
 */

export interface DateRange { from: string; to: string }
export type Cells = Record<string, Record<string, string>>;
export type StayByDate = Record<string, string>;
export type BillsByCell = Record<string, Record<string, AttachmentMeta[]>>;

export interface GridState {
  range: DateRange;
  cells: Cells;
  stay: StayByDate;
  bills: BillsByCell;
}

export const lineDate = (it: Pick<ClaimLine, 'fields'>): string => String(it.fields.date ?? it.fields.fromDate ?? '');

const hasStayField = (c: ExpenseItemDef): boolean => c.fields.includes('stayLocation');

/** The line already on the claim for this date and fixed item, if any. */
export function lineFor(items: readonly ClaimLine[], date: string, itemKey: string): ClaimLine | null {
  return items.find((it) => it.itemKey === itemKey && it.fields.date === date) ?? null;
}

/**
 * Default range: the travel period (outside travel, when valid); else starting at the first date of
 * existing fixed lines and running 31 days; else the month to date. Clamped so `to` is never in the
 * future and the span never exceeds 31 days (extra days are dropped from the START).
 */
export function defaultRange(
  def: ExpenseTypeDef, cols: readonly ExpenseItemDef[], items: readonly ClaimLine[],
  travelFrom: string | undefined, travelTo: string | undefined, today: string,
): DateRange {
  const colKeys = new Set(cols.map((c) => c.key));
  const fixedDates = items.filter((it) => colKeys.has(it.itemKey) && it.fields.date).map((it) => String(it.fields.date)).sort();
  let from: string;
  let to: string;
  const first = fixedDates[0];
  if (def.travelPeriod && travelFrom && travelTo && travelTo >= travelFrom) { from = travelFrom; to = travelTo; }
  else if (first) { from = first; to = addDays(from, GRID_MAX_DAYS - 1); }
  else { from = today.slice(0, 8) + '01'; to = today; }
  if (to > today) to = today;
  if (from > to) from = to;
  if (daysBetween(from, to) >= GRID_MAX_DAYS) from = addDays(to, -(GRID_MAX_DAYS - 1));
  return { from, to };
}

export interface RangeErrors { from?: string; to?: string }

export function validateRange(range: DateRange, today: string): RangeErrors {
  const err: RangeErrors = {};
  if (!range.from) err.from = 'Required';
  if (!range.to) err.to = 'Required';
  else if (range.to > today) err.to = 'Cannot be in the future';
  if (!err.from && !err.to) {
    if (range.to < range.from) err.to = 'Must be on or after From Date';
    else if (daysBetween(range.from, range.to) >= GRID_MAX_DAYS) err.to = `Up to ${GRID_MAX_DAYS} days at a time`;
  }
  return err;
}

/** Inclusive list of dates in a valid range; empty when the range is invalid. */
export function dateList(range: DateRange, today: string): string[] {
  const e = validateRange(range, today);
  if (e.from || e.to) return [];
  const out: string[] = [];
  let d = range.from;
  while (d <= range.to) { out.push(d); d = addDays(d, 1); }
  return out;
}

/** Seeds one date's cells, bills and stay location from existing claim lines. */
export function seedDate(state: GridState, date: string, cols: readonly ExpenseItemDef[], items: readonly ClaimLine[]): void {
  if (state.cells[date]) return;
  const cells: Record<string, string> = {};
  const bills: Record<string, AttachmentMeta[]> = {};
  for (const c of cols) {
    const l = lineFor(items, date, c.key);
    cells[c.key] = l ? String(l.fields.amount) : '';
    bills[c.key] = l ? JSON.parse(JSON.stringify(l.attachments ?? [])) as AttachmentMeta[] : [];
    if (l && l.fields.stayLocation && !state.stay[date]) state.stay[date] = String(l.fields.stayLocation);
  }
  state.cells[date] = cells;
  state.bills[date] = bills;
  if (state.stay[date] === undefined) state.stay[date] = '';
}

export function newGridState(range: DateRange): GridState {
  return { range, cells: {}, stay: {}, bills: {} };
}

/* ---- Totals and flags ------------------------------------------------------------------ */
const cell = (s: GridState, d: string, key: string): string => s.cells[d]?.[key] ?? '';
export const rowTotal = (s: GridState, d: string, cols: readonly ExpenseItemDef[]): number =>
  cols.reduce((sum, c) => sum + num(cell(s, d, c.key)), 0);
export const colTotal = (s: GridState, list: readonly string[], c: ExpenseItemDef): number =>
  list.reduce((sum, d) => sum + num(cell(s, d, c.key)), 0);
export const grandTotal = (s: GridState, list: readonly string[], cols: readonly ExpenseItemDef[]): number =>
  list.reduce((sum, d) => sum + rowTotal(s, d, cols), 0);
export function filledCount(s: GridState, list: readonly string[], cols: readonly ExpenseItemDef[]): number {
  let n = 0;
  for (const d of list) for (const c of cols) if (num(cell(s, d, c.key)) > 0) n++;
  return n;
}
/** A cell is over limit when its item has a per-day/bill limit and the value exceeds it. */
export const isOver = (c: ExpenseItemDef, v: unknown): boolean => c.limit != null && num(v) > c.limit;
/** A bill is required when the item takes attachments and does not mark them optional. */
export const billRequired = (c: ExpenseItemDef): boolean => c.fields.includes('attachment') && !c.attachmentOptional;
export const needsStayColumn = (cols: readonly ExpenseItemDef[]): boolean => cols.some(hasStayField);
export const rowNeedsStay = (s: GridState, d: string, cols: readonly ExpenseItemDef[]): boolean =>
  needsStayColumn(cols) && cols.some((c) => hasStayField(c) && num(cell(s, d, c.key)) > 0);

/* ---- Copy-down and "same as previous day" ------------------------------------------------ */
/**
 * Copies the FIRST non-empty value in the column down into every empty date. Returns how many dates
 * were filled, or `null` when the column has no value to copy.
 */
export function copyDown(
  list: readonly string[], get: (d: string) => string | undefined, set: (d: string, v: string) => void,
): number | null {
  const first = list.map(get).find((v) => v !== '' && v != null);
  if (first === undefined) return null;
  let n = 0;
  for (const d of list) {
    const v = get(d);
    if (v === '' || v == null) { set(d, first); n++; }
  }
  return n;
}

/** Mobile "Same as previous day": copy every item amount (and stay location) from the previous date. */
export function copyPreviousDay(s: GridState, date: string, prev: string, cols: readonly ExpenseItemDef[]): void {
  for (const c of cols) {
    const row = s.cells[date];
    if (row) row[c.key] = cell(s, prev, c.key);
  }
  if (needsStayColumn(cols)) s.stay[date] = s.stay[prev] ?? '';
}

/* ---- Receipt-box bills available to a grid cell ---------------------------------------- */
export function pickableForGrid(
  employeeReceipts: readonly Receipt[], items: readonly ClaimLine[], list: readonly string[],
  cols: readonly ExpenseItemDef[], s: GridState, claimId: string,
): Receipt[] {
  const colKeys = new Set(cols.map((c) => c.key));
  const inRange = new Set(list);
  const used: Record<string, true> = {};
  for (const it of items) {
    if (colKeys.has(it.itemKey) && inRange.has(String(it.fields.date))) continue;
    for (const a of it.attachments ?? []) if (a.receiptId) used[a.receiptId] = true;
  }
  for (const d of list) for (const c of cols) for (const a of s.bills[d]?.[c.key] ?? []) if (a.receiptId) used[a.receiptId] = true;
  return employeeReceipts.filter((r) => !used[r.id] && (!r.usedIn || r.usedIn.claimId === claimId));
}

/* ---- Validation ----------------------------------------------------------------------- */
export interface GridValidation {
  cellErr: Record<string, true>;
  stayErr: Record<string, true>;
  summary: string[];
  ok: boolean;
}

export function validateGrid(s: GridState, list: readonly string[], cols: readonly ExpenseItemDef[]): GridValidation {
  const cellErr: Record<string, true> = {};
  const stayErr: Record<string, true> = {};
  const summary: string[] = [];
  for (const d of list) {
    for (const c of cols) {
      const v = s.cells[d]?.[c.key];
      const files = s.bills[d]?.[c.key] ?? [];
      const label = c.short ?? c.label;
      if (!(num(v) > 0) && files.length) {
        cellErr[`${d}|${c.key}`] = true;
        summary.push(`${fmtDate(d)}, ${label}: enter the amount for the attached bills, or remove them`);
        continue;
      }
      if (v === '' || v == null) continue;
      if (num(v) > 0 && billRequired(c) && !files.length) {
        cellErr[`${d}|${c.key}`] = true;
        summary.push(`${fmtDate(d)}, ${label}: attach at least one bill`);
        continue;
      }
      if (!Number.isFinite(parseFloat(v)) || parseFloat(v) < 0) {
        cellErr[`${d}|${c.key}`] = true;
        summary.push(`${fmtDate(d)}, ${label}: enter an amount of zero or more`);
      }
    }
    if (rowNeedsStay(s, d, cols) && !s.stay[d]) {
      stayErr[d] = true;
      summary.push(`${fmtDate(d)}: choose the stay location`);
    }
  }
  return { cellErr, stayErr, summary, ok: summary.length === 0 };
}

/* ---- Apply ---------------------------------------------------------------------------- */
export interface ApplyResult { items: ClaimLine[]; added: number; updated: number; removed: number }

/**
 * Applies the grid to the claim's lines: add new lines for filled cells, update changed ones (amount,
 * stay location or bills), remove lines whose cell was cleared. Amounts are rounded to 2 dp.
 * Lines on dates outside `list` are preserved. The result is sorted by line date.
 */
export function applyGrid(
  items: readonly ClaimLine[], list: readonly string[], cols: readonly ExpenseItemDef[], s: GridState, newId: () => string,
): ApplyResult {
  let work: ClaimLine[] = items.map((it) => ({ ...it, fields: { ...it.fields } }));
  let added = 0, updated = 0, removed = 0;
  for (const d of list) {
    for (const c of cols) {
      const v = roundMoney(num(cell(s, d, c.key)));
      const line = lineFor(work, d, c.key);
      const stayHere = hasStayField(c);
      if (v > 0) {
        const files: AttachmentMeta[] = JSON.parse(JSON.stringify(s.bills[d]?.[c.key] ?? [])) as AttachmentMeta[];
        if (line) {
          const billsChanged = JSON.stringify(line.attachments ?? []) !== JSON.stringify(files);
          if (line.fields.amount !== v || (stayHere && line.fields.stayLocation !== s.stay[d]) || billsChanged) {
            line.fields.amount = v;
            if (stayHere) line.fields.stayLocation = s.stay[d] ?? '';
            line.attachments = files;
            updated++;
          }
        } else {
          const fields: ClaimLine['fields'] = { date: d, amount: v };
          if (stayHere) fields.stayLocation = s.stay[d] ?? '';
          work.push({ id: newId(), itemKey: c.key, fields, attachments: files, approvedAmount: null, approverRemarks: '' });
          added++;
        }
      } else if (line) {
        work = work.filter((it) => it !== line);
        removed++;
      }
    }
  }
  work.sort((a, b) => lineDate(a).localeCompare(lineDate(b)));
  return { items: work, added, updated, removed };
}
