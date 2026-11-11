import { DEFAULT_POLICY, type PolicyConfig } from '../config/policy';
import type {
  AdvanceUsage, ExpenseClaim, ExpenseItemDef, ClaimLine, LimitInfo, LineFields, MedicalUsage,
  TravelClaimRecord, TravelRequest,
} from '../types/domain';
import { daysBetween, money0, num, today } from '../utils/format';

/**
 * Business calculations ported 1:1 from js/store.js (TC.calc).
 *
 * ROUNDING (preserved from the prototype, not changed):
 *  - Only the fuel-by-km amount is rounded: Math.round(claimableKm * rate * 100) / 100.
 *  - The date-wise "apply" step rounds each cell to 2 dp the same way (see dateWise.ts).
 *  - Totals are plain floating-point sums, with no intermediate rounding.
 * KNOWN RISK: binary floating point means values such as 1.005 * 100 can round the "wrong" way,
 * and long sums can drift by fractions of a paisa. A decimal-safe (integer paise) implementation is
 * recommended once the business owner/backend confirms the authoritative rounding rule; it is NOT
 * applied silently here because it could change displayed totals.
 */

export const roundMoney = (n: number): number => Math.round(n * 100) / 100;

export const itemAmount = (line: Pick<ClaimLine, 'fields'> | null | undefined): number => num(line?.fields?.amount);

export const claimTotal = (c: Pick<ExpenseClaim, 'items'>): number =>
  (c.items ?? []).reduce((s, it) => s + itemAmount(it), 0);

/** Approved total: sum of line approved amounts when approved, 0 when rejected, null while pending/draft. */
export function claimApproved(c: Pick<ExpenseClaim, 'items' | 'status'>): number | null {
  if (c.status === 'approved') return (c.items ?? []).reduce((s, it) => s + num(it.approvedAmount), 0);
  if (c.status === 'rejected') return 0;
  return null;
}

/** Policy limit for one line, scaled by nights/days when the item carries a from/to date range. */
export function effectiveLimit(def: ExpenseItemDef | null | undefined, fields: LineFields = {}): LimitInfo | null {
  if (!def) return null;
  if (def.limitQty != null) return { qty: def.limitQty, text: `${def.limitQty} litres per claim` };
  if (def.limit == null) return { amount: null, text: 'No fixed limit – approver discretion' };
  const per = def.limitPer ?? 'bill';
  let units = 1;
  if ((per === 'night' || per === 'day') && fields.fromDate && fields.toDate) {
    units = Math.max(1, daysBetween(String(fields.fromDate), String(fields.toDate)));
  }
  const amount = def.limit * units;
  let text = `${money0(def.limit)} per ${per}`;
  if (units > 1) text += ` × ${units} ${per}s = ${money0(amount)}`;
  return { amount, units, per, text };
}

/** How far a line exceeds its policy limit (INR, or litres for quantity caps). */
export function overLimit(def: ExpenseItemDef | null | undefined, fields: LineFields = {}): number {
  const lim = effectiveLimit(def, fields);
  if (!lim) return 0;
  if (lim.qty != null) return Math.max(0, num(fields.qty) - lim.qty);
  if (lim.amount == null) return 0;
  return Math.max(0, num(fields.amount) - lim.amount);
}

export function lineLimitAmount(def: ExpenseItemDef | null | undefined, fields: LineFields = {}): number | null {
  const lim = effectiveLimit(def, fields);
  return lim && lim.amount != null ? lim.amount : null;
}

export const fuelRate = (def: ExpenseItemDef | null | undefined, policy: PolicyConfig = DEFAULT_POLICY): number =>
  def?.rate ? policy.rates[def.rate] : 0;

/**
 * Fuel by kilometres: totalKm is claimable distance after deducting non-accountable km;
 * amount = round2(totalKm * rate). Returns a NEW fields object (the prototype mutated in place).
 * Items that are not 'fuelKm' are returned unchanged.
 */
export function applyFuel(def: ExpenseItemDef | null | undefined, fields: LineFields, policy: PolicyConfig = DEFAULT_POLICY): LineFields {
  if (!def || def.compute !== 'fuelKm') return fields;
  const tripKm = Math.max(0, num(fields.toKm) - num(fields.fromKm));
  const claimableKm = Math.max(0, tripKm - num(fields.nonAccountableKm));
  return { ...fields, totalKm: claimableKm, amount: roundMoney(claimableKm * fuelRate(def, policy)) };
}

/**
 * Medical balance for the CURRENT calendar year (from `now`): approved claims count at their approved
 * amount, submitted claims at their claimed total; drafts and rejected claims do not count.
 * Client-side only for display and early validation. The backend must enforce the same rule.
 */
export function medicalUsage(
  records: readonly TravelClaimRecord[], employeeCode: string, excludeId: string | null,
  policy: PolicyConfig = DEFAULT_POLICY, now: Date = new Date(),
): MedicalUsage {
  const year = today(now).slice(0, 4);
  let approved = 0;
  let pending = 0;
  for (const r of records) {
    if (r.kind !== 'claim' || r.expenseType !== 'medical' || r.employeeCode !== employeeCode || r.id === excludeId) continue;
    if (String(r.requestDate ?? '').slice(0, 4) !== year) continue;
    if (r.status === 'approved') approved += claimApproved(r) ?? 0;
    else if (r.status === 'submitted') pending += claimTotal(r);
  }
  const limit = policy.medicalAnnualLimit;
  return { limit, approved, pending, used: approved + pending, balance: Math.max(0, limit - approved - pending) };
}

/** Advance balance: approved and unsettled advances are "outstanding", submitted ones "pending". */
export function advanceUsage(
  records: readonly TravelClaimRecord[], employeeCode: string, excludeId: string | null = null,
  policy: PolicyConfig = DEFAULT_POLICY,
): AdvanceUsage {
  let outstanding = 0;
  let pending = 0;
  for (const r of records) {
    if (r.kind !== 'advance' || r.employeeCode !== employeeCode || r.id === excludeId) continue;
    if (r.status === 'approved' && !r.settled) outstanding += num(r.amount);
    else if (r.status === 'submitted') pending += num(r.amount);
  }
  const limit = policy.advanceLimit;
  return { limit, outstanding, pending, used: outstanding + pending, balance: Math.max(0, limit - outstanding - pending) };
}

export const travelEstimate = (tr: Pick<TravelRequest, 'items'>): number =>
  (tr.items ?? []).reduce((s, i) => s + num(i.amount), 0);

export function recordAmount(r: TravelClaimRecord): number {
  if (r.kind === 'claim') return claimTotal(r);
  if (r.kind === 'travel') return travelEstimate(r);
  return num(r.amount);
}

/** Approved amount for any record kind; null while undecided. */
export function recordApproved(r: TravelClaimRecord): number | null {
  if (r.kind === 'claim') return claimApproved(r);
  if (r.status === 'approved') return recordAmount(r);
  if (r.status === 'rejected') return 0;
  return null;
}

/** Sum of per-line approved amounts as entered by the approver (null/'' count as 0). */
export const approvedTotal = (c: Pick<ExpenseClaim, 'items'>): number =>
  (c.items ?? []).reduce((s, it) => s + num(it.approvedAmount), 0);

/** Supplies the claimed amount as the initial approval value without replacing an approver's existing decision. */
export function withDefaultApprovedAmounts(lines: readonly ClaimLine[]): ClaimLine[] {
  return lines.map((it) => it.approvedAmount == null
    ? { ...it, approvedAmount: itemAmount(it) }
    : it);
}

/**
 * "Fill within policy limits" (approver): for every line without an approved amount, approve
 * min(claimed, limit); when capped and the remark is empty, remark 'Capped at policy limit'.
 * Lines that already have an approved amount are left alone. Returns new lines.
 */
export function autofillApproved(lines: readonly ClaimLine[], defFor: (itemKey: string) => ExpenseItemDef | null): ClaimLine[] {
  return lines.map((it) => {
    if (it.approvedAmount !== null && (it.approvedAmount as unknown) !== '') return it;
    const d = defFor(it.itemKey);
    const amt = itemAmount(it);
    const la = lineLimitAmount(d, it.fields);
    const approvedAmount = la == null ? amt : Math.min(amt, la);
    const approverRemarks = la != null && amt > la && !it.approverRemarks ? 'Capped at policy limit' : it.approverRemarks;
    return { ...it, approvedAmount, approverRemarks };
  });
}
