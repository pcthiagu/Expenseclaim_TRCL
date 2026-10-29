import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPENSE_TYPES, FIELD_DEFS, itemByKey, lookup, setReferenceData } from '../src/domain/expenseSchema.ts';
import { loadReferenceSchema } from './helpers/referenceData.ts';
import { effectiveLimit } from '../src/domain/calc.ts';
import { canApprove } from '../src/domain/workflow.ts';
import { EXPECTED_SCHEMA_REV, SCHEMA_SCRIPTS, staleScripts } from '../src/config/schemaRev.ts';
import type { Actor, TravelClaimRecord } from '../src/types/domain.ts';

test('reference data from the database drives the registry: types, items, fields and option lists; bad data is rejected with a readable error', () => {
  const ref = loadReferenceSchema(['CC-9']);
  assert.equal(EXPENSE_TYPES.length, 5); assert.equal(itemByKey('outside', 'o_lodge')!.limit, 3000);
  assert.deepEqual(lookup('COST_CENTRE'), ['CC-9']); assert.ok(lookup('CITIES').includes('Chennai'));
  assert.equal(FIELD_DEFS.amount.label, 'Amount'); assert.equal(FIELD_DEFS.attachment.label.length > 0, true);
  const eligibilityData = structuredClone(ref);
  const lodgeWithFlag = eligibilityData.types.find((t) => t.key === 'outside')!.items.find((i) => i.key === 'o_lodge')!;
  lodgeWithFlag.enforceEligibility = 'Y';
  setReferenceData(eligibilityData);
  assert.equal(itemByKey('outside', 'o_lodge')!.enforceEligibility, 'Y');
  const sqlCasedFlag = structuredClone(ref) as typeof ref & { types: Array<{ items: Array<Record<string, unknown>> }> };
  sqlCasedFlag.types[4]!.items[1]!.EnforceEligibility = 'Y';
  setReferenceData(sqlCasedFlag as never);
  assert.equal(itemByKey('outside', 'o_lodge')!.enforceEligibility, 'Y');
  setReferenceData(ref);
  // a limit changed in the database is the limit the calculations use; a removed limit (no property) means "no fixed limit"
  const edited = structuredClone(ref);
  const lodge = edited.types.find((t) => t.key === 'outside')!.items.find((i) => i.key === 'o_lodge')!; lodge.limit = 3500;
  const allow = edited.types.find((t) => t.key === 'fuel')!.items.find((i) => i.key === 'f_allow_2w')!; delete allow.limit;
  setReferenceData(edited);
  assert.equal(effectiveLimit(itemByKey('outside', 'o_lodge')!, { fromDate: '2026-09-23', toDate: '2026-09-25' })!.amount, 7000, 'lodge: 2 nights x 3500');
  assert.equal(effectiveLimit(itemByKey('fuel', 'f_allow_2w')!, {})!.text, 'No fixed limit – approver discretion');
  const dupes = structuredClone(ref); dupes.lookups.CITIES!.push('Chennai');
  setReferenceData(dupes);
  assert.equal(lookup('CITIES').filter((c) => c === 'Chennai').length, 1, 'a list never shows the same value twice');
  // an item may be removed in the database and disappears from the app
  // const fewer = structuredClone(ref); fewer.types.find((t) => t.key === 'other')!.items.pop();
  const fewer = structuredClone(ref);
(fewer.types.find((t) => t.key === 'other')!.items as any[]).pop();
  setReferenceData(fewer);
  assert.equal(EXPENSE_TYPES.find((t) => t.key === 'other')!.items.length, ref.types.find((t) => t.key === 'other')!.items.length - 1);
  // unusable data fails loudly instead of rendering a broken screen
  const unknown = structuredClone(ref); unknown.fields.push({ key: 'colour', label: 'Colour', type: 'text' });
  assert.throws(() => setReferenceData(unknown), /does not know how to show: "colour"/);
  const undefinedField = structuredClone(ref); undefinedField.fields = undefinedField.fields.filter((f) => f.key !== 'billerName');
  assert.throws(() => setReferenceData(undefinedField), /uses field "billerName", which has no definition/);
  const noTypes = structuredClone(ref); noTypes.types = [];
  assert.throws(() => setReferenceData(noTypes), /no expense types configured/);
  // const dup = structuredClone(ref); dup.types[1]!.items.push({ ...dup.types[0]!.items[0]! });
const dup = structuredClone(ref);
(dup.types[1]!.items as any[]).push({ ...dup.types[0]!.items[0]! });

  assert.throws(() => setReferenceData(dup), /defined twice/);
  assert.throws(() => setReferenceData({} as never), /not in the expected shape/);
  setReferenceData(ref);   // restored
  assert.equal(itemByKey('outside', 'o_lodge')!.limit, 3000);
});

test('the approve hint hides Approve on your OWN request when the policy forbids self-approval, and only in the approver view on submitted requests', () => {
  const req = (code: string, status: TravelClaimRecord['status'] = 'submitted') => ({ kind: 'travel', employeeCode: code, status }) as unknown as TravelClaimRecord;
  const approver: Actor = { role: 'admin', code: '700010', name: 'P' };
  const employeeView: Actor = { role: 'employee', code: '700010', name: 'P' };
  assert.equal(canApprove(req('800001'), approver, { allowSelfApproval: false }), true, 'someone else\'s request');
  assert.equal(canApprove(req('700010'), approver, { allowSelfApproval: false }), false, 'own request, self-approval forbidden');
  assert.equal(canApprove(req('700010'), approver, { allowSelfApproval: true }), true);
  assert.equal(canApprove(req('700010'), approver), true, 'no policy given: the server decides');
  assert.equal(canApprove(req('800001'), employeeView), false, 'the same person in the Employee view cannot approve anything');
  assert.equal(canApprove(req('800001', 'draft'), approver), false);
  assert.equal(canApprove(req('800001', 'approved'), approver), false);
});

test('stale database scripts are detected: missing stamps, older revisions, no schema at all (an old GetSession)', () => {
  const current = Object.fromEntries(SCHEMA_SCRIPTS.map((n) => [n, EXPECTED_SCHEMA_REV]));
  assert.deepEqual(staleScripts(current), []);
  assert.deepEqual(staleScripts({ ...current, '07_procs_receipts': '2026-10-01-a' }), ['07_procs_receipts.sql']);
  const { '05_procs_requests': _gone, ...without } = current; void _gone;
  assert.deepEqual(staleScripts(without), ['05_procs_requests.sql']);
  assert.deepEqual(staleScripts(undefined), SCHEMA_SCRIPTS.map((n) => `${n}.sql`), 'a session without a schema means every script is unconfirmed');
  assert.deepEqual(staleScripts({ ...current, '99_other': 'x' }), [], 'extra rows are ignored');
});
