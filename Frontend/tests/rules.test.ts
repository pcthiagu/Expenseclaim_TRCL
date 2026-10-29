import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadReferenceSchema } from './helpers/referenceData.ts';
import { SEED_RECEIPTS, SEED_RECORDS } from './helpers/engine/engineSeed.ts';
import { EXPENSE_TYPES, fixedItems, itemByKey } from '../src/domain/expenseSchema.ts';
import * as calc from '../src/domain/calc.ts';
import * as wf from '../src/domain/workflow.ts';
import * as val from '../src/domain/validation.ts';
import * as rc from '../src/domain/receipts.ts';
import * as dw from '../src/domain/dateWise.ts';
import * as ls from '../src/domain/lists.ts';
import type { Actor, AdvanceRequest, ClaimLine, ExpenseClaim, Receipt, TravelClaimRecord, TravelRequest } from '../src/types/domain.ts';

loadReferenceSchema();   // expense types and items come from the database seed, as at run time
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const seed = plain(SEED_RECORDS) as TravelClaimRecord[];
const receiptsSeed = plain(SEED_RECEIPTS) as Receipt[];
const employee: Actor = { role: 'employee', code: '800001', name: 'Karthik R' };
const admin: Actor = { role: 'admin', code: '700010', name: 'Priya Natarajan' };
const NOW = new Date(2026, 9, 15); // 15 Oct 2026
let idc = 0;
const newId = () => `t${++idc}`;
const typeOf = (k: string) => EXPENSE_TYPES.find((t) => t.key === k)!;
const claimBy = (no: string) => plain(seed.find((r) => r.requestNumber === no) as ExpenseClaim);
const emp = (c: string) => ['800000', '800001', '800002', '800003', '800004'].includes(c);

function line(itemKey: string, fields: ClaimLine['fields'], approved: number | null = null, attachments: ClaimLine['attachments'] = []): ClaimLine {
  return { id: newId(), itemKey, fields, attachments, approvedAmount: approved, approverRemarks: '' };
}

/* ---- Status flow ---------------------------------------------------------------------- */
test('status flow: Draft -> Submitted -> Approved | Rejected, and nothing else', () => {
  assert.equal(wf.nextStatus('draft', 'submit'), 'submitted');
  assert.equal(wf.nextStatus('submitted', 'approve'), 'approved');
  assert.equal(wf.nextStatus('submitted', 'reject'), 'rejected');
  for (const s of ['draft', 'approved', 'rejected'] as const) {
    assert.equal(wf.canTransition(s, 'approve'), false, `approve from ${s}`);
    assert.equal(wf.canTransition(s, 'reject'), false, `reject from ${s}`);
  }
  for (const s of ['submitted', 'approved', 'rejected'] as const) assert.equal(wf.canTransition(s, 'submit'), false, `submit from ${s}`);
});

test('employee can edit/delete only own drafts; cannot approve; approver acts only on submitted', () => {
  const otherDraft = { ...claimBy('800001/2026/0106'), employeeCode: '800002' };
  const ownDraft = claimBy('800001/2026/0106');
  assert.equal(wf.canEdit(ownDraft, employee), true);
  assert.equal(wf.canEdit(otherDraft, employee), false);
  assert.equal(wf.canEdit(claimBy('800001/2026/0105'), employee), false, 'submitted is read-only');
  assert.equal(wf.canDelete({ ...ownDraft, requestNumber: '' }, employee), false, 'unsaved draft has nothing to delete');
  assert.equal(wf.canDelete(ownDraft, employee), true);
  assert.equal(wf.canApprove(claimBy('800001/2026/0105'), employee), false);
  assert.equal(wf.canApprove(claimBy('800001/2026/0105'), admin), true);
  assert.equal(wf.canApprove(claimBy('800001/2026/0101'), admin), false, 'already approved');
  assert.equal(wf.canView(ownDraft, admin), false, 'admins do not see other people\'s drafts');
});

test('copying a rejected claim yields a fresh draft with the backend-assigned number left blank', () => {
  const rejected = claimBy('800001/2026/0103');
  assert.equal(wf.canCopy(rejected, employee), true);
  assert.equal(wf.canCopy(claimBy('800001/2026/0101'), employee), false);
  const copy = wf.copyClaimToDraft(rejected, employee, newId, NOW);
  assert.equal(copy.status, 'draft');
  assert.equal(copy.requestNumber, '');
  assert.equal(copy.requestDate, '2026-10-15');
  assert.equal(copy.rejectionReason, '');
  assert.equal(copy.approver, null);
  assert.equal(copy.submittedOn, null);
  assert.notEqual(copy.id, rejected.id);
  assert.ok(copy.items.every((it, i) => it.id !== rejected.items[i]!.id && it.approvedAmount === null && it.approverRemarks === ''));
  assert.equal(copy.items[0]!.fields.amount, rejected.items[0]!.fields.amount, 'line content is kept');
  assert.equal(rejected.status, 'rejected', 'original is untouched');
});

/* ---- Policy limits and caps ------------------------------------------------------------ */
test('lodge limit scales with nights; fuel litres cap is 40', () => {
  const lodge = itemByKey('outside', 'o_lodge')!;
  assert.equal(calc.lineLimitAmount(lodge, { fromDate: '2026-09-23', toDate: '2026-09-25' }), 6000); // 2 nights
  assert.equal(calc.overLimit(lodge, { fromDate: '2026-09-23', toDate: '2026-09-25', amount: 5600 }), 0);
  assert.equal(calc.overLimit(lodge, { fromDate: '2026-09-23', toDate: '2026-09-25', amount: 6500 }), 500);
  const litres = itemByKey('fuel', 's_fuel_litres')!;
  assert.equal(calc.overLimit(litres, { qty: 40 }), 0);
  assert.equal(calc.overLimit(litres, { qty: 45 }), 5);
  assert.equal(calc.lineLimitAmount(itemByKey('outside', 'o_ticket'), { amount: 99999 }), null, 'ticket fare has no fixed limit');
});

test('line eligibility is enforced only for Y; N keeps the amount valid for a warning in the claim grid', () => {
  const expense = { itemKey: 'l_da', fields: { date: '2026-10-01', amount: 300 }, attachments: [] };
  const enforced = val.validateLine(expense, 'local', { eligibilityLimit: 250, enforceEligibility: 'Y', now: NOW });
  assert.equal(enforced.ok, false);
  assert.equal(enforced.errors.amount, 'Cannot exceed your eligibility of ₹250.00');
  const notEnforced = val.validateLine(expense, 'local', { eligibilityLimit: 250, enforceEligibility: 'N', now: NOW });
  assert.equal(notEnforced.ok, true);
});

test('fill-within-policy-limits caps lines, keeps decided lines, and remarks only when capped', () => {
  const lines = [
    line('s_med_glasses', { amount: 3800 }), // limit 3000 -> capped
    line('s_med_lab', { amount: 2200 }), // within
    line('s_med_consult', { amount: 9000 }, 1000), // already decided
    line('o_ticket', { amount: 12000 }), // no limit
  ];
  const out = calc.autofillApproved(lines, (k) => itemByKey('medical', k) ?? itemByKey('outside', k));
  assert.equal(out[0]!.approvedAmount, 3000);
  assert.equal(out[0]!.approverRemarks, 'Capped at policy limit');
  assert.equal(out[1]!.approvedAmount, 2200);
  assert.equal(out[1]!.approverRemarks, '');
  assert.equal(out[2]!.approvedAmount, 1000);
  assert.equal(out[3]!.approvedAmount, 12000);
});

/* ---- Validation ------------------------------------------------------------------------ */
const ctx = { employeeExists: emp, records: seed, now: NOW };

test('medical claim exceeding the remaining annual balance cannot be submitted', () => {
  const draft = claimBy('800001/2026/0106');
  assert.equal(val.validateClaimHeader(draft, true, ctx).ok, true, 'within balance (9800 left, claim 2250)');
  draft.items = [line('s_med_rx', { amount: 5000 }), line('s_med_dental', { amount: 5000 })]; // 10000 > 9800
  const r = val.validateClaimHeader(draft, true, ctx);
  assert.equal(r.ok, false);
  assert.match(r.summary.join(' '), /exceeds the available medical balance of ₹9,800\.00/);
});

test('claim header rules: future date, missing purpose/cost centre, travel dates, no lines', () => {
  const c = claimBy('800001/2026/0105'); // outside travel
  c.requestDate = '2026-12-01';
  c.purpose = '  ';
  c.costCentre = '';
  c.travelTo = '2026-09-01';
  c.items = [];
  const r = val.validateClaimHeader(c, true, ctx);
  assert.equal(r.errors.requestDate, 'Cannot be in the future');
  assert.equal(r.errors.purpose, 'Required to submit');
  assert.equal(r.errors.costCentre, 'Select a cost centre');
  assert.equal(r.errors.travelTo, 'Must be on or after Travel From');
  assert.ok(r.summary.includes('Add at least one expense line.'));
  // Drafts only need employee + request date:
  assert.equal(val.validateClaimHeader({ ...c, requestDate: '2026-10-01' }, false, ctx).ok, true);
});

test('line validation: fuel km, litres, bills, dates', () => {
  const fuel = val.validateLine({ itemKey: 'l_fuel_4w', fields: { date: '2026-10-01', fromLocation: 'A', toLocation: 'B', fromKm: 100, toKm: 100, nonAccountableKm: 0 }, attachments: [] }, 'fuel', { now: NOW });
  assert.equal(fuel.errors.toKm, 'Must be greater than From KM');
  const personal = val.validateLine({ itemKey: 'l_fuel_4w', fields: { date: '2026-10-01', fromLocation: 'A', toLocation: 'B', fromKm: 100, toKm: 150, nonAccountableKm: 80 }, attachments: [] }, 'fuel', { now: NOW });
  assert.equal(personal.errors.nonAccountableKm, 'Cannot exceed Total KM');
  const ok = val.validateLine({ itemKey: 'l_fuel_4w', fields: { date: '2026-10-01', fromLocation: 'A', toLocation: 'B', fromKm: 100, toKm: 142, nonAccountableKm: 2 }, attachments: [] }, 'fuel', { now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.fields.amount, 360, '(42-2) km x 9');
  const litres = val.validateLine({ itemKey: 's_fuel_litres', fields: { date: '2026-10-01', amount: 100, qty: 0 }, attachments: [] }, 'fuel', { now: NOW });
  assert.equal(litres.errors.qty, 'Enter the litres filled');
  assert.equal(litres.errors.attachment, 'Attach at least one bill', 'litres need a bill');
  const futureLodge = val.validateLine({ itemKey: 'o_lodge', fields: { date: '2026-11-01', stayLocation: 'Pune', fromDate: '2026-09-25', toDate: '2026-09-23', amount: 100 }, attachments: [] }, 'outside', { now: NOW });
  assert.equal(futureLodge.errors.date, 'Cannot be in the future');
  assert.equal(futureLodge.errors.toDate, 'Must be on or after From Date');
  const noAmount = val.validateLine({ itemKey: 's_med_lab', fields: { date: '2026-10-01', amount: 0 }, attachments: [{ name: 'a.pdf', size: 1, type: 'application/pdf' }] }, 'medical', { now: NOW });
  assert.equal(noAmount.errors.amount, 'Enter an amount greater than zero');
  assert.equal(val.validateLine({ itemKey: '', fields: {}, attachments: [] }, 'medical').errors.itemKey, 'Choose an expense item');
});

test('approver must give every line an amount between 0 and the claimed amount; reject needs a reason', () => {
  const c = claimBy('800001/2026/0105');
  assert.equal(val.validateApproval(c.items).ok, false, 'submitted lines have null approved amounts');
  const lines = c.items.map((it, i) => ({ ...it, approvedAmount: i === 0 ? -1 : i === 1 ? 999999 : (it.fields.amount as number) }));
  const r = val.validateApproval(lines);
  assert.equal(r.lineErrors[lines[0]!.id], 'Cannot be negative');
  assert.match(r.lineErrors[lines[1]!.id]!, /^Cannot exceed ₹5,600\.00$/);
  assert.equal(Object.keys(r.lineErrors).length, 2);
  const good = c.items.map((it) => ({ ...it, approvedAmount: 0 }));
  assert.equal(val.validateApproval(good).ok, true, 'zero is a valid approved amount');
  assert.equal(val.validateRejectionReason('   '), 'Give the employee a reason');
  assert.equal(val.validateRejectionReason('Duplicate'), null);
  const zeroed = val.zeroUndecidedOnReject([{ ...c.items[0]!, approvedAmount: null }, { ...c.items[1]!, approvedAmount: 50 }]);
  assert.deepEqual(zeroed.map((x) => x.approvedAmount), [0, 50]);
});

test('approved total sums per-line approved amounts; rejected claims total to 0', () => {
  const c = claimBy('800001/2026/0102');
  assert.equal(calc.claimTotal(c), 6000);
  assert.equal(calc.claimApproved(c), 5200);
  assert.equal(calc.approvedTotal(c), 5200);
  assert.equal(calc.claimApproved(claimBy('800001/2026/0103')), 0);
  assert.equal(calc.claimApproved(claimBy('800001/2026/0105')), null);
});

test('advance request: needs amount > 0, within balance, valid period', () => {
  const ar = plain(seed.find((r) => r.requestNumber === 'AR/2026/0023') as AdvanceRequest);
  const vctx = { employeeExists: emp, records: seed };
  assert.equal(val.validateAdvance(ar, true, vctx).ok, true, 'excludes itself: 5000 outstanding, 10000 left, asks 6000');
  assert.equal(val.validateAdvance({ ...ar, amount: 10001 }, true, vctx).errors.amount, 'Exceeds the available advance balance of ₹10,000');
  assert.equal(val.validateAdvance({ ...ar, amount: 0 }, true, vctx).errors.amount, 'Enter an amount greater than zero');
  assert.equal(val.validateAdvance({ ...ar, periodTo: '2026-10-01' }, true, vctx).errors.periodTo, 'Must be on or after the start date');
  assert.equal(val.validateAdvance({ ...ar, amount: '' }, false, vctx).ok, true, 'drafts need only employee and date');
});

test('travel request: estimate lines, advance <= estimate and <= balance, period order', () => {
  const tr = plain(seed.find((r) => r.requestNumber === 'TR/2026/0048') as TravelRequest);
  const vctx = { employeeExists: emp, records: seed };
  // FINDING (preserved prototype behaviour): the seed's own advance (6000) fails the travel-form check, because
  // the linked advance request AR/2026/0023 (6000, pending) already counts against the 15000 limit (balance 4000).
  const seeded = val.validateTravel(tr, true, vctx);
  assert.equal(seeded.ok, false);
  assert.match(seeded.errors.advanceRequired!, /^Exceeds the available advance balance of ₹4,000$/);
  assert.equal(val.validateTravel({ ...tr, advanceRequired: 4000 }, true, vctx).ok, true, 'at the balance is allowed');
  assert.equal(val.validateTravel({ ...tr, advanceRequired: 13000 }, true, vctx).errors.advanceRequired, 'Cannot exceed the total estimate');
  assert.equal(val.validateTravel({ ...tr, advanceRequired: -1 }, true, vctx).errors.advanceRequired, 'Cannot be negative');
  const tooBig = val.validateTravel({ ...tr, advanceRequired: 4001 }, true, vctx);
  assert.match(tooBig.errors.advanceRequired!, /^Exceeds the available advance balance of ₹4,000$/);
  assert.equal(val.validateTravel({ ...tr, periodTo: tr.periodFrom }, true, vctx).errors.periodTo, 'Must be after the start of the period');
  const empty = val.validateTravel({ ...tr, items: [{ id: 'x', item: '', amount: '', remarks: '' }] }, true, vctx);
  assert.ok(empty.summary.includes('Add at least one estimate item with an amount.'));
  assert.equal(calc.travelEstimate(tr), 12000);
});

/* ---- Receipts ------------------------------------------------------------------------- */
test('receipts: linking marks used, relinking frees dropped bills, other claims are never touched', () => {
  const r = receiptsSeed.map((x) => ({ ...x }));
  const lines = [line('l_conveyance', { amount: 410 }, null, [rc.attachmentFromReceipt(r[0]!)]), line('s_med_rx', { amount: 640 }, null, [rc.attachmentFromReceipt(r[1]!)])];
  const linked = rc.linkReceipts(r, 'claim-A', '800001/2026/0107', lines);
  assert.deepEqual(linked[0]!.usedIn, { claimId: 'claim-A', requestNumber: '800001/2026/0107', lineId: lines[0]!.id });
  assert.ok(linked[1]!.usedIn);
  assert.equal(linked[2]!.usedIn, null);
  assert.equal(r[0]!.usedIn, null, 'input not mutated');
  // Remove the first line -> its receipt is released, the other stays linked.
  const afterRemove = rc.linkReceipts(linked, 'claim-A', '800001/2026/0107', [lines[1]!]);
  assert.equal(afterRemove[0]!.usedIn, null);
  assert.ok(afterRemove[1]!.usedIn);
  // A different claim's relink must not release claim-A's receipts.
  const other = rc.linkReceipts(afterRemove, 'claim-B', 'X', []);
  assert.ok(other[1]!.usedIn);
  // Deleting the draft (no lines) frees all of its receipts.
  const deleted = rc.linkReceipts(afterRemove, 'claim-A', '800001/2026/0107', []);
  assert.ok(deleted.every((x) => x.usedIn === null));
});

test('receipt picker excludes bills on other lines, on this line, and on other claims', () => {
  const r = receiptsSeed.map((x) => ({ ...x }));
  r[2]!.usedIn = { claimId: 'other-claim', requestNumber: 'N', lineId: 'z' };
  const lineA = line('l_conveyance', { amount: 1 }, null, [rc.attachmentFromReceipt(r[0]!)]);
  const draft = line('l_food_lunch', { amount: 1 }, null, [rc.attachmentFromReceipt(r[1]!)]);
  const pick = rc.pickableForLine(r, [lineA, draft], draft, 'this-claim');
  assert.deepEqual(pick.map((x) => x.id).sort(), ['rcpt-4', 'rcpt-5']);
});

test('prefill from receipts fills only empty fields; amount is the sum; fuel-by-km amount is never prefilled', () => {
  const two = [receiptsSeed[0]!, receiptsSeed[3]!]; // Uber 410 (2026-10-05), Saravana 260 (2026-10-10)
  const food = itemByKey('local', 'l_food_lunch')!;
  const f = rc.prefillFromReceipts(food, {}, two);
  assert.equal(f.date, '2026-10-05');
  assert.equal(f.billerName, 'Uber');
  assert.equal(f.billNumber, 'UB-88124, 5582');
  assert.equal(f.amount, 670);
  const keep = rc.prefillFromReceipts(food, { date: '2026-09-01', amount: 5 }, two);
  assert.equal(keep.date, '2026-09-01');
  assert.equal(keep.amount, 5);
  assert.equal(rc.prefillFromReceipts(itemByKey('fuel', 'l_fuel_4w'), {}, two).amount, undefined);
});

test('pending receipts (Create claim from receipt box) skip bills already on the form or used by another claim', () => {
  const r = receiptsSeed.map((x) => ({ ...x }));
  r[1]!.usedIn = { claimId: 'other', requestNumber: 'N', lineId: 'z' };
  const onForm = line('l_conveyance', { amount: 1 }, null, [rc.attachmentFromReceipt(r[0]!)]);
  const p = rc.pendingReceipts(['rcpt-1', 'rcpt-2', 'rcpt-3', 'nope'], r, [onForm], 'new-claim');
  assert.deepEqual(p.map((x) => x.id), ['rcpt-3']);
});

/* ---- Date-wise entry ------------------------------------------------------------------ */
const localDef = typeOf('local');
const localCols = fixedItems(localDef);
const medDef = typeOf('medical');
const medCols = fixedItems(medDef);
const outDef = typeOf('outside');
const outCols = fixedItems(outDef);

test('date-wise columns are the fixed items of each type', () => {
  assert.deepEqual(fixedItems(typeOf('fuel')).map((c) => c.short), ['Two wheeler', 'Four wheeler']);
  assert.deepEqual(localCols.map((c) => c.short), ['Food (no bill)', 'Daily allowance', 'Conveyance', 'Mobile']);
  assert.equal(medCols.length, 6);
  assert.deepEqual(fixedItems(typeOf('other')).map((c) => c.short), ['Vehicle maintenance', 'Miscellaneous']);
  assert.deepEqual(outCols.map((c) => c.short), ['Daily allowance', 'Boarding (no bill)', 'Food (no bill)']);
});

test('default date range: travel period, existing lines, else month-to-date; capped at today and 31 days', () => {
  assert.deepEqual(dw.defaultRange(outDef, outCols, [], '2026-09-23', '2026-09-25', '2026-10-15'), { from: '2026-09-23', to: '2026-09-25' });
  assert.deepEqual(dw.defaultRange(outDef, outCols, [], '2026-09-23', '2026-12-25', '2026-10-15'), { from: '2026-09-23', to: '2026-10-15' }, 'to clamps to today');
  assert.deepEqual(dw.defaultRange(localDef, localCols, [], undefined, undefined, '2026-10-15'), { from: '2026-10-01', to: '2026-10-15' });
  const existing = [line('l_da', { date: '2026-09-10', amount: 250 })];
  assert.deepEqual(dw.defaultRange(localDef, localCols, existing, undefined, undefined, '2026-10-15'), { from: '2026-09-10', to: '2026-10-10' });
  const long = dw.defaultRange(outDef, outCols, [], '2026-06-01', '2026-10-15', '2026-10-15');
  assert.equal(long.to, '2026-10-15');
  assert.equal(long.from, '2026-09-15', '31 days inclusive: Sep 15..Oct 15');
  assert.equal(dw.dateList(long, '2026-10-15').length, 31);
});

test('date range validation: required, not future, ordered, at most 31 days', () => {
  const today = '2026-10-15';
  assert.deepEqual(dw.validateRange({ from: '', to: '' }, today), { from: 'Required', to: 'Required' });
  assert.equal(dw.validateRange({ from: '2026-10-01', to: '2026-10-16' }, today).to, 'Cannot be in the future');
  assert.equal(dw.validateRange({ from: '2026-10-10', to: '2026-10-01' }, today).to, 'Must be on or after From Date');
  assert.equal(dw.validateRange({ from: '2026-09-01', to: '2026-10-15' }, today).to, 'Up to 31 days at a time');
  assert.deepEqual(dw.validateRange({ from: '2026-09-15', to: '2026-10-15' }, today), {});
  assert.deepEqual(dw.dateList({ from: '2026-10-10', to: '2026-10-01' }, today), []);
});

function gridFor(cols: typeof localCols, items: ClaimLine[], range: dw.DateRange, today = '2026-10-15') {
  const s = dw.newGridState(range);
  const list = dw.dateList(range, today);
  list.forEach((d) => dw.seedDate(s, d, cols, items));
  return { s, list };
}

test('grid totals (day, column, grand) update from cell values', () => {
  const { s, list } = gridFor(localCols, [], { from: '2026-10-01', to: '2026-10-03' });
  const da = localCols.find((c) => c.key === 'l_da')!;
  const mob = localCols.find((c) => c.key === 'l_mobile')!;
  s.cells['2026-10-01']!.l_da = '250';
  s.cells['2026-10-01']!.l_mobile = '50';
  s.cells['2026-10-02']!.l_da = '240.5';
  assert.equal(dw.rowTotal(s, '2026-10-01', localCols), 300);
  assert.equal(dw.colTotal(s, list, da), 490.5);
  assert.equal(dw.colTotal(s, list, mob), 50);
  assert.equal(dw.grandTotal(s, list, localCols), 540.5);
  assert.equal(dw.filledCount(s, list, localCols), 3);
});

test('grid flags amounts above the per-day limit (warning only) and items needing bills', () => {
  const da = localCols.find((c) => c.key === 'l_da')!;
  assert.equal(dw.isOver(da, '250'), false);
  assert.equal(dw.isOver(da, '250.01'), true);
  assert.equal(dw.isOver(localCols.find((c) => c.key === 'l_food_nobill')!, '99999'), false, 'no limit -> never over');
  assert.equal(dw.billRequired(da), false, 'bills optional for fixed daily items');
  assert.equal(dw.billRequired(medCols[0]!), true, 'medical bills are required');
});

test('copy-down fills only empty dates with the first value; reports nothing-to-copy', () => {
  const { s, list } = gridFor(localCols, [], { from: '2026-10-01', to: '2026-10-04' });
  s.cells['2026-10-02']!.l_da = '200';
  s.cells['2026-10-03']!.l_da = '100';
  const n = dw.copyDown(list, (d) => s.cells[d]!.l_da, (d, v) => { s.cells[d]!.l_da = v; });
  assert.equal(n, 2);
  assert.deepEqual(list.map((d) => s.cells[d]!.l_da), ['200', '200', '100', '200']);
  const none = dw.copyDown(list, (d) => s.cells[d]!.l_conv_fixed, (d, v) => { s.cells[d]!.l_conv_fixed = v; });
  assert.equal(none, null);
  assert.equal(dw.copyDown(list, (d) => s.cells[d]!.l_da, (d, v) => { s.cells[d]!.l_da = v; }), 0, 'all full -> 0 filled');
});

test('"same as previous day" copies every amount and the stay location', () => {
  const { s } = gridFor(outCols, [], { from: '2026-09-23', to: '2026-09-24' });
  s.cells['2026-09-23']!.o_da = '500';
  s.cells['2026-09-23']!.o_boarding_nobill = '600';
  s.stay['2026-09-23'] = 'Bengaluru';
  dw.copyPreviousDay(s, '2026-09-24', '2026-09-23', outCols);
  assert.equal(s.cells['2026-09-24']!.o_da, '500');
  assert.equal(s.cells['2026-09-24']!.o_boarding_nobill, '600');
  assert.equal(s.stay['2026-09-24'], 'Bengaluru');
});

test('required-bill validation: medical cell without a bill, bills without an amount, missing stay location', () => {
  const med = gridFor(medCols, [], { from: '2026-10-01', to: '2026-10-01' });
  med.s.cells['2026-10-01']!.s_med_lab = '1200';
  const v1 = dw.validateGrid(med.s, med.list, medCols);
  assert.equal(v1.ok, false);
  assert.ok(v1.cellErr['2026-10-01|s_med_lab']);
  assert.match(v1.summary[0]!, /attach at least one bill/);
  med.s.bills['2026-10-01']!.s_med_lab = [{ name: 'lab.pdf', size: 10, type: 'application/pdf' }];
  assert.equal(dw.validateGrid(med.s, med.list, medCols).ok, true);
  med.s.cells['2026-10-01']!.s_med_lab = '';
  assert.match(dw.validateGrid(med.s, med.list, medCols).summary[0]!, /enter the amount for the attached bills, or remove them/);

  const out = gridFor(outCols, [], { from: '2026-09-23', to: '2026-09-23' }, '2026-10-15');
  out.s.cells['2026-09-23']!.o_da = '500';
  const v2 = dw.validateGrid(out.s, out.list, outCols);
  assert.ok(v2.stayErr['2026-09-23']);
  out.s.stay['2026-09-23'] = 'Pune';
  assert.equal(dw.validateGrid(out.s, out.list, outCols).ok, true);
  out.s.cells['2026-09-23']!.o_da = '-5';
  assert.match(dw.validateGrid(out.s, out.list, outCols).summary.join(' '), /enter an amount of zero or more/);
});

test('apply: adds lines for filled cells, rounds to 2 dp, carries bills and stay location', () => {
  const { s, list } = gridFor(outCols, [], { from: '2026-09-23', to: '2026-09-24' });
  s.cells['2026-09-23']!.o_da = '500';
  s.cells['2026-09-24']!.o_food_nobill = '199.999';
  s.stay['2026-09-23'] = 'Pune';
  s.stay['2026-09-24'] = 'Pune';
  const bill = { name: 'tea.jpg', size: 5, type: 'image/jpeg', receiptId: 'rcpt-4' };
  s.bills['2026-09-24']!.o_food_nobill = [bill];
  const r = dw.applyGrid([], list, outCols, s, newId);
  assert.deepEqual({ a: r.added, u: r.updated, d: r.removed }, { a: 2, u: 0, d: 0 });
  assert.deepEqual(r.items.map((i) => [i.itemKey, i.fields.date, i.fields.amount, i.fields.stayLocation]), [
    ['o_da', '2026-09-23', 500, 'Pune'], ['o_food_nobill', '2026-09-24', 200, 'Pune'],
  ]);
  assert.deepEqual(r.items[1]!.attachments, [bill], 'bill (and its receipt link) travels with the line');
  assert.equal(r.items[1]!.approvedAmount, null);
});

test('reopen + edit: unchanged cells are no-ops, changed cells update, cleared cells remove, outside-range lines survive', () => {
  const existing = [
    line('l_da', { date: '2026-10-01', amount: 250 }),
    line('l_conv_fixed', { date: '2026-10-01', amount: 300 }),
    line('l_da', { date: '2026-09-20', amount: 250 }), // outside the range we will reopen
    line('l_conveyance', { date: '2026-10-01', modeOfTravel: 'Cab', fromLocation: 'A', toLocation: 'B', amount: 90 }), // not a fixed item
  ];
  const { s, list } = gridFor(localCols, existing, { from: '2026-10-01', to: '2026-10-02' });
  // Reopened state mirrors the claim:
  assert.equal(s.cells['2026-10-01']!.l_da, '250');
  assert.equal(s.cells['2026-10-01']!.l_conv_fixed, '300');
  const unchanged = dw.applyGrid(existing, list, localCols, s, newId);
  assert.deepEqual({ a: unchanged.added, u: unchanged.updated, d: unchanged.removed }, { a: 0, u: 0, d: 0 });
  // Edit: change DA, clear conveyance, add a new day.
  s.cells['2026-10-01']!.l_da = '200';
  s.cells['2026-10-01']!.l_conv_fixed = '';
  s.cells['2026-10-02']!.l_mobile = '50';
  const r = dw.applyGrid(existing, list, localCols, s, newId);
  assert.deepEqual({ a: r.added, u: r.updated, d: r.removed }, { a: 1, u: 1, d: 1 });
  const byKey = (k: string, d: string) => r.items.find((i) => i.itemKey === k && i.fields.date === d);
  assert.equal(byKey('l_da', '2026-10-01')!.fields.amount, 200);
  assert.equal(byKey('l_conv_fixed', '2026-10-01'), undefined);
  assert.equal(byKey('l_mobile', '2026-10-02')!.fields.amount, 50);
  assert.ok(byKey('l_da', '2026-09-20'), 'line outside the range is preserved');
  assert.ok(r.items.some((i) => i.itemKey === 'l_conveyance'), 'non-grid line is preserved');
  assert.deepEqual(r.items.map((i) => String(i.fields.date)), [...r.items.map((i) => String(i.fields.date))].sort(), 'sorted by date');
  assert.equal(existing[0]!.fields.amount, 250, 'inputs are not mutated');
});

test('changing only the bills of a cell counts as an update', () => {
  const existing = [line('s_med_lab', { date: '2026-10-01', amount: 1200 }, null, [{ name: 'a.pdf', size: 1, type: 'application/pdf' }])];
  const { s, list } = gridFor(medCols, existing, { from: '2026-10-01', to: '2026-10-01' });
  s.bills['2026-10-01']!.s_med_lab = [{ name: 'a.pdf', size: 1, type: 'application/pdf' }, { name: 'b.pdf', size: 2, type: 'application/pdf' }];
  const r = dw.applyGrid(existing, list, medCols, s, newId);
  assert.equal(r.updated, 1);
  assert.equal(r.items[0]!.attachments.length, 2);
});

test('grid receipt picker excludes bills on lines outside the grid, in other cells and on other claims', () => {
  const r = receiptsSeed.map((x) => ({ ...x }));
  r[4]!.usedIn = { claimId: 'other', requestNumber: 'N', lineId: 'z' };
  const outside = line('l_conveyance', { date: '2026-09-01', amount: 1 }, null, [rc.attachmentFromReceipt(r[0]!)]);
  const inGridExisting = line('s_med_lab', { date: '2026-10-01', amount: 5 }, null, [rc.attachmentFromReceipt(r[1]!)]);
  const { s, list } = gridFor(medCols, [outside, inGridExisting], { from: '2026-10-01', to: '2026-10-02' });
  s.bills['2026-10-02']!.s_med_rx = [rc.attachmentFromReceipt(r[2]!)];
  const free = dw.pickableForGrid(r, [outside, inGridExisting], list, medCols, s, 'this-claim');
  // rcpt-1 is on a line outside the grid (excluded); rcpt-2 is on an in-range grid line but still in the cell state so excluded;
  // rcpt-3 is in another cell (excluded); rcpt-5 belongs to another claim (excluded) => only rcpt-4 remains.
  assert.deepEqual(free.map((x) => x.id), ['rcpt-4']);
  // If the user clears rcpt-2 from its cell it becomes pickable again (grid owns lines in range).
  s.bills['2026-10-01']!.s_med_lab = [];
  assert.deepEqual(dw.pickableForGrid(r, [outside, inGridExisting], list, medCols, s, 'this-claim').map((x) => x.id), ['rcpt-2', 'rcpt-4']);
});

/* ---- Dashboard, lists, approvals ---------------------------------------------------------- */
const visibleFor = (actor: Actor) => seed.filter((r) => wf.canView(r, actor));

test('employee KPIs (Karthik): totals computed independently from the seed lines', () => {
  const mine = visibleFor(employee).filter((r) => r.kind === 'claim') as ExpenseClaim[];
  const k = ls.employeeKpis(visibleFor(employee));
  const raw = (c: ExpenseClaim) => c.items.reduce((s, i) => s + Number(i.fields.amount), 0);
  assert.equal(k.totalClaims, mine.length);
  assert.equal(k.totalClaims, 6);
  assert.equal(k.claimedAmount, mine.filter((c) => c.status !== 'draft').reduce((s, c) => s + raw(c), 0));
  assert.equal(k.claimedAmount, 378 + 6000 + 650 + 530 + (2450 + 5600 + 1200 + 420 + 380));
  assert.equal(k.approvedAmount, 378 + 5200 + 530);
  assert.equal(k.approvedCount, 3);
  assert.deepEqual([k.drafts, k.rejected, k.attention], [1, 1, 2]);
});

test('approver KPIs: pending counts/amounts, approved amount, overdue (> 3 days waiting) and oldest', () => {
  const k = ls.adminKpis(visibleFor(admin), NOW);
  const pending = seed.filter((r) => r.status === 'submitted');
  assert.equal(k.pendingCount, pending.length);
  assert.deepEqual(k.pendingByKind, { claim: pending.filter((r) => r.kind === 'claim').length, travel: pending.filter((r) => r.kind === 'travel').length, advance: pending.filter((r) => r.kind === 'advance').length });
  assert.equal(k.pendingAmount, pending.reduce((s, r) => s + calc.recordAmount(r), 0));
  assert.equal(k.approvedAmount, seed.filter((r) => r.status === 'approved').reduce((s, r) => s + (calc.recordApproved(r) ?? 0), 0));
  // Submitted 2026-09-28 is the oldest: 17 days before 15 Oct.
  assert.equal(k.oldestDays, 17);
  // Overdue = submitted more than 3 days before today. Latest seed submission is 2026-10-04 (11 days) -> all overdue.
  assert.equal(k.overdueCount, pending.length);
  assert.equal(ls.waitingLong({ ...pending[0]!, submittedOn: '2026-10-12' }, NOW), false, '3 days is not "over 3"');
  assert.equal(ls.waitingLong({ ...pending[0]!, submittedOn: '2026-10-11' }, NOW), true);
});

test('admins never see drafts of other people', () => {
  assert.equal(visibleFor(admin).some((r) => r.status === 'draft'), false);
  assert.equal(visibleFor(employee).every((r) => r.employeeCode === '800001'), true);
});

test('list filters: search, type, employee (admin only), request-date range; status handled by caller', () => {
  const rows = visibleFor(admin);
  const f = ls.emptyFilters();
  const bengaluru = rows.filter((r) => ls.matchesNonStatus(r, { ...f, q: 'bengaluru' }, true)).map((r) => r.requestNumber).sort();
  assert.deepEqual(bengaluru, ['800001/2026/0105', 'AR/2026/0017', 'TR/2026/0041']);
  assert.ok(rows.some((r) => ls.matchesNonStatus(r, { ...f, q: 'TR/2026/0048' }, true)));
  assert.equal(rows.filter((r) => ls.matchesNonStatus(r, { ...f, q: 'Medical Expense' }, true) && r.kind === 'claim').every((r) => (r as ExpenseClaim).expenseType === 'medical'), true);
  const medical = rows.filter((r) => ls.matchesNonStatus(r, { ...f, type: 'medical' }, true) && r.kind === 'claim');
  assert.ok(medical.length > 0 && medical.every((r) => (r as ExpenseClaim).expenseType === 'medical'));
  assert.equal(rows.filter((r) => ls.matchesNonStatus(r, { ...f, employee: '800002' }, true)).every((r) => r.employeeCode === '800002'), true);
  assert.equal(rows.filter((r) => ls.matchesNonStatus(r, { ...f, employee: '800002' }, false)).length, rows.length, 'employee filter ignored for non-admins');
  const ranged = rows.filter((r) => ls.matchesNonStatus(r, { ...f, from: '2026-10-01', to: '2026-10-03' }, true));
  assert.ok(ranged.length > 0 && ranged.every((r) => r.requestDate >= '2026-10-01' && r.requestDate <= '2026-10-03'));
  // type filter only applies to claims:
  assert.ok(rows.filter((r) => r.kind === 'travel').every((r) => ls.matchesNonStatus(r, { ...f, type: 'medical' }, true)));
});

test('sorting: default directions, amount, status order, type, and stability for ties', () => {
  assert.equal(ls.defaultSortDir('requestDate'), 'desc');
  assert.equal(ls.defaultSortDir('total'), 'desc');
  assert.equal(ls.defaultSortDir('requestNumber'), 'asc');
  const claims = visibleFor(admin).filter((r) => r.kind === 'claim');
  const byTotalDesc = ls.sortRows(claims, { key: 'total', dir: 'desc' }).map((r) => calc.recordAmount(r));
  assert.deepEqual(byTotalDesc, [...byTotalDesc].sort((a, b) => b - a));
  const byStatus = ls.sortRows(claims, { key: 'status', dir: 'asc' }).map((r) => r.status);
  const order = ['draft', 'submitted', 'approved', 'rejected'];
  assert.deepEqual(byStatus.map((s) => order.indexOf(s)), byStatus.map((s) => order.indexOf(s)).sort((a, b) => a - b));
  const byType = ls.sortRows(claims, { key: 'expenseType', dir: 'asc' }).map((r) => (r as ExpenseClaim).expenseType);
  assert.equal(byType[0], 'fuel');
  assert.equal(ls.sortRows(claims, null).length, claims.length);
});

test('pagination: pages, clamping and range text values', () => {
  const rows = Array.from({ length: 23 }, (_, i) => i);
  const p1 = ls.paginate(rows, 1, 10);
  assert.deepEqual([p1.total, p1.pages, p1.start, p1.end, p1.rows.length], [23, 3, 1, 10, 10]);
  const p3 = ls.paginate(rows, 99, 10);
  assert.deepEqual([p3.page, p3.start, p3.end, p3.rows.length], [3, 21, 23, 3]);
  const empty = ls.paginate([], 1, 10);
  assert.deepEqual([empty.total, empty.pages, empty.start, empty.end], [0, 1, 0, 0]);
});

test('approvals queue: oldest first, grouped by kind, 30-day history capped at 10 and newest first', () => {
  const v = ls.approvalsView(visibleFor(admin), NOW);
  assert.deepEqual(v.pending.map((r) => r.submittedOn), v.pending.map((r) => r.submittedOn).sort());
  assert.equal(v.pending.length, v.byKind.claim.length + v.byKind.travel.length + v.byKind.advance.length);
  assert.equal(v.oldestDays, 17);
  assert.equal(v.oldestWarn, true);
  assert.equal(v.oldestRequestNumber, v.pending[0]!.requestNumber);
  // 30-day cut-off from 15 Oct 2026 is 15 Sep 2026 (inclusive).
  assert.ok(v.history.length > 0 && v.history.length <= 10);
  assert.ok(v.history.every((r) => (r.status === 'approved' || r.status === 'rejected') && String(r.approvedOn) >= '2026-09-15'));
  assert.deepEqual(v.history.map((r) => r.approvedOn), v.history.map((r) => r.approvedOn).sort().reverse());
  assert.equal(v.history.some((r) => r.requestNumber === '800004/2026/0021'), false, 'approved 8 Sep is outside the window');
  assert.equal(v.history.some((r) => r.requestNumber === '800001/2026/0104'), true, 'approved 22 Sep is inside');
  const empty = ls.approvalsView([], NOW);
  assert.deepEqual([empty.pending.length, empty.oldestDays, empty.oldestRequestNumber, empty.oldestWarn], [0, 0, null, false]);
});
