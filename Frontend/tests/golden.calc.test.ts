import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReferenceSchema } from './helpers/referenceData.ts';
import { SEED_RECORDS } from './helpers/engine/engineSeed.ts';
import { EXPENSE_TYPES } from '../src/domain/expenseSchema.ts';
import * as calc from '../src/domain/calc.ts';
import * as f from '../src/utils/format.ts';
import { canApprove, canCopy, canDelete, canEdit, canView, statusLabel } from '../src/domain/workflow.ts';
import type { Actor, TravelClaimRecord, LineFields, ExpenseItemDef } from '../src/types/domain.ts';

/**
 * Golden tests. tests/fixtures/golden.json holds what the ORIGINAL prototype computed (js/store.js, js/data.js) for these exact inputs, with the clock fixed at
 * 2026-10-15T10:00. The prototype itself is no longer in the project; these values keep the guarantee that totals, limits, fuel, balances, formatting and
 * permission hints still produce the numbers the business already saw.
 */
loadReferenceSchema();   // expense types and items come from the database seed, as at run time
const G = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/golden.json'), 'utf8')) as Record<string, any>;
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const records = plain(SEED_RECORDS) as TravelClaimRecord[];
const NOW = new Date(2026, 9, 15, 10, 0, 0);

test('record totals and approved amounts equal the prototype\'s for every seed record', () => {
  assert.equal(records.length, Object.keys(G.records).length);
  for (const r of records) {
    const g = G.records[r.id];
    assert.ok(g, `golden for ${r.id}`);
    assert.equal(calc.recordAmount(r), g.amount, `recordAmount ${r.requestNumber}`);
    assert.equal(calc.recordApproved(r), g.approved, `recordApproved ${r.requestNumber}`);
    if (r.kind === 'claim') { assert.equal(calc.claimTotal(r), g.claimTotal); assert.equal(calc.claimApproved(r), g.claimApproved); }
  }
});

const FIELD_VARIANTS = G.variants as LineFields[];

test('effectiveLimit / overLimit / lineLimitAmount equal the prototype\'s for every item x field variant', () => {
  let checked = 0;
  for (const t of EXPENSE_TYPES) {
    for (const item of t.items) {
      FIELD_VARIANTS.forEach((fields, i) => {
        const g = G.limits[`${t.key}|${item.key}|${i}`];
        assert.ok(g, `golden for ${item.key} #${i}`);
        assert.deepEqual(plain(calc.effectiveLimit(item, fields)), g.eff, `${item.key} ${JSON.stringify(fields)}`);
        assert.equal(calc.overLimit(item, fields), g.over, `over ${item.key} ${JSON.stringify(fields)}`);
        assert.equal(calc.lineLimitAmount(item, fields), g.la, `limitAmt ${item.key}`);
        checked++;
      });
    }
  }
  assert.equal(checked, Object.keys(G.limits).length, 'the database seed defines exactly the items the prototype had');
});

test('fuel-by-km computation preserves rates and computes claimable total km (incl. deductions, zero and reversed readings)', () => {
  const inputs = G.fuelInputs as LineFields[];
  for (const key of ['l_fuel_2w', 'l_fuel_4w']) {
    const def = EXPENSE_TYPES[0]!.items.find((i) => i.key === key)!;
    inputs.forEach((inp, i) => {
      const mine = calc.applyFuel(def, inp);
      const g = G.fuel[`${key}|${i}`];
      const tripKm = Math.max(0, Number(inp.toKm || 0) - Number(inp.fromKm || 0));
      const claimableKm = Math.max(0, tripKm - Number(inp.nonAccountableKm || 0));
      assert.equal(mine.totalKm, claimableKm, `${key} claimable totalKm ${JSON.stringify(inp)}`);
      assert.equal(mine.amount, g.amount, `${key} amount ${JSON.stringify(inp)}`);
    });
  }
  // Worked examples: 42 km on four wheeler = 42 x 9 = 378 ; 42 - 12 on two wheeler = 30 x 4 = 120
  const four = EXPENSE_TYPES[0]!.items.find((i) => i.key === 'l_fuel_4w')!;
  const two = EXPENSE_TYPES[0]!.items.find((i) => i.key === 'l_fuel_2w')!;
  assert.equal(calc.applyFuel(four, { fromKm: 23410, toKm: 23452, nonAccountableKm: 0 }).amount, 378);
  assert.equal(calc.applyFuel(two, { fromKm: 23410, toKm: 23452, nonAccountableKm: 12 }).amount, 120);
});

test('applyFuel does not mutate its input and ignores non-fuel items', () => {
  const four = EXPENSE_TYPES[0]!.items.find((i) => i.key === 'l_fuel_4w')!;
  const input: LineFields = { fromKm: 0, toKm: 10, nonAccountableKm: 0 };
  const out = calc.applyFuel(four, input);
  assert.deepEqual(input, { fromKm: 0, toKm: 10, nonAccountableKm: 0 });
  assert.notEqual(out, input);
  const lodge = EXPENSE_TYPES.find((t) => t.key === 'outside')!.items.find((i) => i.key === 'o_lodge') as ExpenseItemDef;
  assert.equal(calc.applyFuel(lodge, input), input);
});

test('medicalUsage and advanceUsage equal the prototype\'s for every employee (with and without exclusions)', () => {
  let n = 0;
  for (const code of ['800000', '800001', '800002', '800003', '800004', '999999']) {
    for (const r of [null, ...records.filter((x) => x.employeeCode === code).map((x) => x.id)]) {
      const g = G.usage[`${code}|${r}`];
      assert.ok(g, `golden usage ${code}|${r}`);
      assert.deepEqual(plain(calc.medicalUsage(records, code, r, undefined, NOW)), g.medical, `medical ${code} excl ${r}`);
      assert.deepEqual(plain(calc.advanceUsage(records, code, r)), g.advance, `advance ${code} excl ${r}`);
      n++;
    }
  }
  assert.equal(n, Object.keys(G.usage).length);
});

test('Karthik medical balance reflects approved + submitted medical claims of the current year', () => {
  const u = calc.medicalUsage(records, '800001', null, undefined, NOW);
  assert.equal(u.limit, 15000);
  assert.equal(u.approved, 5200);   // 0102 approved 2200 + 3000 (the draft 0106 does not count)
  assert.equal(u.pending, 0);
  assert.equal(u.balance, 9800);
});

test('Karthik advance balance: approved unsettled AR/2026/0017 (5000) + submitted AR/2026/0023 (6000) vs 15000 limit', () => {
  assert.deepEqual(calc.advanceUsage(records, '800001'), { limit: 15000, outstanding: 5000, pending: 6000, used: 11000, balance: 4000 });
});

test('formatting helpers equal the prototype\'s', () => {
  const T = G.fmt;
  [0, 1, 1234.5, 1234567.891, -5, '12abc', null, undefined, 0.005, 99999999].forEach((n, i) => {
    assert.deepEqual([f.money(n), f.money0(n), f.numFmt(n)], T.money[i], `money ${String(n)}`);
  });
  ['2026-09-23', '2026-01-01', '2026-12-31T10:00', '', null, 'garbage', '2026-09'].forEach((d, i) => {
    assert.deepEqual([f.date(d as string), f.longDate(d as string), f.dateTime(d as string)], T.dates[i], `date ${String(d)}`);
  });
  ['00:00', '06:05', '12:00', '13:45', '23:59', '', null].forEach((t, i) => assert.equal(f.time(t as string), T.times[i], `time ${String(t)}`));
  [0, 100, 1023, 1024, 214 * 1024, 5 * 1024 * 1024, 5.5 * 1024 * 1024].forEach((b, i) => assert.equal(f.fileSize(b), T.sizes[i], `fileSize ${b}`));
  ['Karthik R', 'Selva', '', '  a  b  c ', null].forEach((n, i) => assert.equal(f.initials(n as string), T.initials[i]));
  assert.equal(f.plural(1, 'bill'), T.misc.plural1);
  assert.equal(f.plural(3, 'bill'), T.misc.plural3);
  assert.equal(f.plural(2, 'entry', 'entries'), T.misc.pluralEntry);
  assert.equal(f.daysBetween('2026-09-23', '2026-09-26'), T.misc.between);
  assert.equal(f.daysBetween('2026-02-27', '2026-03-02'), T.misc.leap);
  assert.equal(f.today(NOW), T.misc.today);
  assert.equal(f.waiting('2026-10-14', new Date(2026, 9, 15)), '1 day');
  assert.equal(f.waiting('2026-10-15', new Date(2026, 9, 15)), 'Today');
  assert.equal(f.waiting('2026-10-10', new Date(2026, 9, 15)), '5 days');
});

test('Indian currency grouping is preserved (en-IN, INR)', () => {
  assert.equal(f.money(1234567.5), '₹12,34,567.50');
  assert.equal(f.money0(15000), '₹15,000');
});

test('permission hints equal the prototype\'s for every record, role and user', () => {
  const users: Record<string, Actor> = {
    employee: { role: 'employee', code: '800001', name: 'Karthik R' },
    admin: { role: 'admin', code: '700010', name: 'Priya Natarajan' },
  };
  let n = 0;
  for (const role of ['employee', 'admin'] as const) {
    const actor = users[role]!;
    for (const r of records) {
      const g = G.perm[`${role}|${r.id}`];
      assert.ok(g, `golden perm ${role}|${r.id}`);
      assert.equal(canView(r, actor), g.view, `canView ${role} ${r.requestNumber}`);
      assert.equal(canEdit(r, actor), g.edit, `canEdit ${role} ${r.requestNumber}`);
      assert.equal(canApprove(r, actor), g.approve, `canApprove ${role} ${r.requestNumber}`);
      assert.equal(canDelete(r, actor), g.del, `canDelete ${role} ${r.requestNumber}`);
      if (r.kind === 'claim') assert.equal(canCopy(r, actor), g.copy, `canCopy ${role} ${r.requestNumber}`);
      n++;
    }
    assert.deepEqual([statusLabel('submitted', role), statusLabel('approved', role)], G.perm[`${role}|label`]);
  }
  assert.equal(n * 1 + 2, Object.keys(G.perm).length);
});
