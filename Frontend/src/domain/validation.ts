import type { PolicyConfig } from '../config/policy';
import { DEFAULT_POLICY } from '../config/policy';
import { applyFuel, claimTotal, itemAmount, medicalUsage, advanceUsage, travelEstimate } from '../domain/calc';
import { FIELD_DEFS, itemByKey, normalizeBillAvailability, typeByKey } from '../domain/expenseSchema';
import type {
  AdvanceRequest, ClaimLine, EligibilityEnforcement, ExpenseClaim, ExpenseItemDef, TravelClaimRecord, TravelRequest,
} from '../types/domain';
import { date as fmtDate, money, money0, num, today } from '../utils/format';

/**
 * Validation ported from js/screens/{claimForm,travelForm,advanceForm}.js.
 * Each validator returns field errors (keyed like the prototype) plus a flat `summary` list shown
 * in the error banner. The backend must re-validate every rule; these exist for fast feedback.
 */
export interface ValidationResult {
  errors: Record<string, string>;
  summary: string[];
  ok: boolean;
}

function result(errors: Record<string, string>, extra: string[], labels: Record<string, string>): ValidationResult {
  const summary = [...extra];
  for (const k of Object.keys(errors)) summary.push(`${labels[k] ?? k}: ${errors[k]}`);
  return { errors, summary, ok: summary.length === 0 };
}

/** Looks up an employee by code. In production this is a backend lookup. */
export type EmployeeExists = (code: string) => boolean;

/* ---- Expense claim header ---------------------------------------------------------------- */
const CLAIM_LABELS: Record<string, string> = {
  employeeCode: 'Employee Code', requestDate: 'Request Date', purpose: 'Purpose', travelFrom: 'Travel From',
  travelTo: 'Travel To', rejectionReason: 'Rejection Reason', costCentre: 'Cost Centre',
};

export function validateClaimHeader(
  form: ExpenseClaim, forSubmit: boolean, ctx: {
    employeeExists: EmployeeExists; records: readonly TravelClaimRecord[]; policy?: PolicyConfig; now?: Date;
  },
): ValidationResult {
  const policy = ctx.policy ?? DEFAULT_POLICY;
  const now = ctx.now ?? new Date();
  const errors: Record<string, string> = {};
  const extra: string[] = [];
  const def = typeByKey(form.expenseType);
  if (!form.employeeCode || !ctx.employeeExists(form.employeeCode)) errors.employeeCode = 'Enter a valid employee code';
  if (!form.requestDate) errors.requestDate = 'Required';
  else if (form.requestDate > today(now)) errors.requestDate = 'Cannot be in the future';
  if (forSubmit) {
    if (!String(form.purpose ?? '').trim()) errors.purpose = 'Required to submit';
    if (!form.costCentre) errors.costCentre = 'Select a cost centre';
    if (def?.travelPeriod) {
      if (!form.travelFrom) errors.travelFrom = 'Required';
      if (!form.travelTo) errors.travelTo = 'Required';
      else if (form.travelFrom && form.travelTo < form.travelFrom) errors.travelTo = 'Must be on or after Travel From';
    }
    if (!form.items.length) extra.push('Add at least one expense line.');
    if (def?.showBalance && form.employeeCode) {
      const su = medicalUsage(ctx.records, form.employeeCode, form.id, policy, now);
      const total = claimTotal(form);
      if (total > su.balance) extra.push(`Total ${money(total)} exceeds the available medical balance of ${money(su.balance)}.`);
    }
  }
  // Prototype order: field errors are pushed to the summary AFTER the extra messages? No: extras were
  // pushed first (inside the forSubmit block), then field errors. `result` preserves that order.
  return result(errors, extra, CLAIM_LABELS);
}

/* ---- Single expense line (Add / Edit Expense modal) ------------------------------------- */
export interface LineValidation extends ValidationResult {
  /** Fields as they should be stored (fuel amount/total recomputed). */
  fields: ClaimLine['fields'];
}

export function validateLine(
  line: Pick<ClaimLine, 'itemKey' | 'fields' | 'attachments'>, expenseTypeKey: string,
  opts: { policy?: PolicyConfig; now?: Date; eligibilityLimit?: number | null; enforceEligibility?: EligibilityEnforcement } = {},
): LineValidation {
  const now = opts.now ?? new Date();
  const errors: Record<string, string> = {};
  const d: ExpenseItemDef | null = itemByKey(expenseTypeKey, line.itemKey);
  if (!d) {
    errors.itemKey = 'Choose an expense item';
    return { errors, summary: ['Expense Item: choose an item'], ok: false, fields: line.fields };
  }
  const f = d.compute === 'fuelKm' ? applyFuel(d, line.fields, opts.policy) : { ...line.fields };
  const billUnavailable = normalizeBillAvailability(f.isBillAvailable) === 'No';
  for (const key of d.fields) {
    const fd = FIELD_DEFS[key];
    if (!fd || fd.computed || key === 'attachment') continue;
    if (billUnavailable && (key === 'billerName' || key === 'billNumber')) continue;
    const v = f[key];
    const empty = v === undefined || v === null || v === '' || (typeof v === 'string' && !v.trim());
    if (fd.required && empty) errors[key] = 'Required';
  }
  for (const key of ['igst', 'cgst', 'sgst'] as const) {
    const value = f[key];
    if (d.fields.includes(key) && value !== undefined && value !== '') {
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount < 0) errors[key] = 'Enter a number of 0 or more';
    }
  }
  if (d.compute === 'fuelKm') {
    if (!errors.toKm && f.fromKm !== '' && f.toKm !== '' && num(f.toKm) <= num(f.fromKm)) errors.toKm = 'Must be greater than From KM';
    const tripKm = Math.max(0, num(line.fields.toKm) - num(line.fields.fromKm));
    if (!errors.nonAccountableKm && num(f.nonAccountableKm) > tripKm) errors.nonAccountableKm = 'Cannot exceed Total KM';
    if (!errors.toKm && !errors.fromKm && !errors.nonAccountableKm && !(num(f.amount) > 0)) errors.toKm = 'No claimable distance after deductions';
  } else if (!errors.amount && !(num(f.amount) > 0)) {
    errors.amount = 'Enter an amount greater than zero';
  }
  if (!errors.amount && opts.enforceEligibility === 'Y' && opts.eligibilityLimit != null && num(f.amount) > opts.eligibilityLimit) {
    errors.amount = `Cannot exceed your eligibility of ${money(opts.eligibilityLimit)}`;
  }
  if (d.fields.includes('qty') && !errors.qty && !(num(f.qty) > 0)) errors.qty = 'Enter the litres filled';
  if (f.fromDate && f.toDate && f.toDate < f.fromDate) errors.toDate = 'Must be on or after From Date';
  if (f.fromDate && f.toDate && f.fromDate === f.toDate && f.fromTime && f.toTime && f.toTime <= f.fromTime) errors.toTime = 'Must be after From Time';
  if (f.date && String(f.date) > today(now)) errors.date = 'Cannot be in the future';
  if (d.fields.includes('attachment') && !d.attachmentOptional && !billUnavailable && !line.attachments.length) errors.attachment = 'Attach at least one bill';
  const labels: Record<string, string> = {};
  for (const k of Object.keys(errors)) labels[k] = k === 'attachment' ? 'Bills' : (FIELD_DEFS[k as keyof typeof FIELD_DEFS]?.label ?? k);
  const r = result(errors, [], labels);
  return { ...r, fields: f };
}

/** Normalises a validated line for saving (numeric coercion, drop fields the item doesn't use). */
export function normalizeLine(line: ClaimLine, d: ExpenseItemDef): ClaimLine {
  const fields: ClaimLine['fields'] = { ...line.fields };
  for (const k of ['amount', 'qty', 'fromKm', 'toKm', 'nonAccountableKm', 'totalKm', 'igst', 'cgst', 'sgst'] as const) {
    if (typeof fields[k] === 'string' && !fields[k].trim()) fields[k] = '';
    else if (fields[k] !== undefined && fields[k] !== '') fields[k] = num(fields[k]);
  }
  for (const k of Object.keys(fields) as (keyof typeof fields)[]) {
    if (!d.fields.includes(k)) delete fields[k];
  }
  return { ...line, fields, attachments: d.fields.includes('attachment') ? line.attachments : [] };
}

/* ---- Approver: per-line approved amounts ------------------------------------------------- */
export interface ApprovalCheck { lineErrors: Record<string, string>; summary: string[]; ok: boolean }

/** Every line needs an approved amount between 0 and the claimed amount (claimForm.js approve()). */
export function validateApproval(lines: readonly ClaimLine[]): ApprovalCheck {
  const lineErrors: Record<string, string> = {};
  for (const it of lines) {
    const a = it.approvedAmount as unknown;
    const claimed = itemAmount(it);
    if (a === '' || a === null || a === undefined || (typeof a === 'number' && Number.isNaN(a))) lineErrors[it.id] = 'Enter an amount';
    else if ((a as number) < 0) lineErrors[it.id] = 'Cannot be negative';
    else if ((a as number) > claimed) lineErrors[it.id] = `Cannot exceed ${money(claimed)}`;
  }
  const bad = Object.keys(lineErrors).length > 0;
  return { lineErrors, summary: bad ? ['Approved Amount: enter a value between ₹0 and the claimed amount on every line.'] : [], ok: !bad };
}

/** Rejection requires a reason. */
export const validateRejectionReason = (reason: string): string | null =>
  String(reason ?? '').trim() ? null : 'Give the employee a reason';

/** On rejection, lines without an approved amount are set to 0 (claimForm.js reject()). */
export const zeroUndecidedOnReject = (lines: readonly ClaimLine[]): ClaimLine[] =>
  lines.map((it) => ((it.approvedAmount === null || (it.approvedAmount as unknown) === '') ? { ...it, approvedAmount: 0 } : it));

/* ---- Travel request ---------------------------------------------------------------------- */
const TRAVEL_LABELS: Record<string, string> = {
  employeeCode: 'Employee Code', requestDate: 'Request Date', purpose: 'Travel Purpose', fromLocation: 'Travel Location From',
  toLocation: 'Travel Location To', periodFrom: 'Travel Period From', periodTo: 'Travel Period To',
  advanceRequired: 'Advance Amount Required', approverRemarks: 'Approver Remarks',
};

export function validateTravel(
  form: TravelRequest, forSubmit: boolean,
  ctx: { employeeExists: EmployeeExists; records: readonly TravelClaimRecord[]; policy?: PolicyConfig },
): ValidationResult {
  const errors: Record<string, string> = {};
  const extra: string[] = [];
  if (!form.employeeCode || !ctx.employeeExists(form.employeeCode)) errors.employeeCode = 'Enter a valid employee code';
  if (!form.requestDate) errors.requestDate = 'Required';
  if (forSubmit) {
    if (!form.purpose) errors.purpose = 'Select a purpose';
    if (!String(form.fromLocation ?? '').trim()) errors.fromLocation = 'Required';
    if (!String(form.toLocation ?? '').trim()) errors.toLocation = 'Required';
    if (!form.periodFrom) errors.periodFrom = 'Required';
    if (!form.periodTo) errors.periodTo = 'Required';
    else if (form.periodFrom && form.periodTo <= form.periodFrom) errors.periodTo = 'Must be after the start of the period';
    let valid = 0;
    form.items.forEach((it, i) => {
      const hasAny = it.item || num(it.amount) > 0;
      if (!hasAny) return;
      if (!it.item) errors[`items.${i}.item`] = 'Pick an item';
      if (!(num(it.amount) > 0)) errors[`items.${i}.amount`] = 'Enter an amount';
      if (it.item && num(it.amount) > 0) valid++;
    });
    if (!valid) extra.push('Add at least one estimate item with an amount.');
    const adv = num(form.advanceRequired);
    const au = form.employeeCode ? advanceUsage(ctx.records, form.employeeCode, null, ctx.policy) : null;
    if (adv < 0) errors.advanceRequired = 'Cannot be negative';
    else if (adv > travelEstimate(form)) errors.advanceRequired = 'Cannot exceed the total estimate';
    else if (au && adv > au.balance) errors.advanceRequired = `Exceeds the available advance balance of ${money0(au.balance)}`;
  }
  const labels: Record<string, string> = { ...TRAVEL_LABELS };
  for (const k of Object.keys(errors)) {
    if (k.startsWith('items.')) labels[k] = `Estimate item ${Number(k.split('.')[1]) + 1}`;
  }
  return result(errors, extra, labels);
}

/* ---- Advance request --------------------------------------------------------------------- */
const ADVANCE_LABELS: Record<string, string> = {
  employeeCode: 'Employee Code', requestDate: 'Request Date', purpose: 'Travel Purpose', periodFrom: 'Travel Period From',
  periodTo: 'Travel Period To', amount: 'Amount', approverRemarks: 'Approver Remarks',
};

export function validateAdvance(
  form: AdvanceRequest, forSubmit: boolean,
  ctx: { employeeExists: EmployeeExists; records: readonly TravelClaimRecord[]; policy?: PolicyConfig },
): ValidationResult {
  const errors: Record<string, string> = {};
  if (!form.employeeCode || !ctx.employeeExists(form.employeeCode)) errors.employeeCode = 'Enter a valid employee code';
  if (!form.requestDate) errors.requestDate = 'Required';
  if (forSubmit) {
    if (!form.purpose) errors.purpose = 'Select a purpose';
    if (!form.periodFrom) errors.periodFrom = 'Required';
    if (!form.periodTo) errors.periodTo = 'Required';
    else if (form.periodFrom && form.periodTo < form.periodFrom) errors.periodTo = 'Must be on or after the start date';
    const amt = num(form.amount);
    const au = form.employeeCode ? advanceUsage(ctx.records, form.employeeCode, form.id, ctx.policy) : null;
    if (!(amt > 0)) errors.amount = 'Enter an amount greater than zero';
    else if (au && amt > au.balance) errors.amount = `Exceeds the available advance balance of ${money0(au.balance)}`;
  }
  return result(errors, [], ADVANCE_LABELS);
}

/** Travel / advance rejection requires Approver Remarks. */
export const validateRemarksForReject = (remarks: string): string | null =>
  String(remarks ?? '').trim() ? null : 'Give the employee a reason';

/** Convenience for UI: format a date for validation messages. */
export const dateLabel = fmtDate;
