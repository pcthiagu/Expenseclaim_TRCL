import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerEngine } from './helpers/engine/serverEngine.ts';
import { buildReferenceData, loadReferenceSchema } from './helpers/referenceData.ts';
import { GST_FIELD_KEYS, setReferenceData } from '../src/domain/expenseSchema.ts';
import { ApiError } from '../src/services/apiClient.ts';
import { claimTotal } from '../src/domain/calc.ts';
import type { AdvanceRequest, ExpenseClaim, TravelClaimRecord, TravelRequest } from '../src/types/domain.ts';

const NOW = new Date(2026, 9, 15, 10, 0, 0);
let n = 0;
const mk = (as: 'employee' | 'admin' = 'employee') => new ServerEngine({ as, now: () => NOW, newId: () => `id${++n}` });
const rejects = async (p: Promise<unknown>, code: string, msg?: RegExp): Promise<ApiError> => {
  try { await p; } catch (caught) {
    if (!(caught instanceof ApiError)) throw new Error(`expected ApiError, got ${String(caught)}`);
    assert.equal(caught.code, code, `code (message: ${caught.message})`);
    if (msg) assert.match(caught.message, msg);
    return caught;
  }
  throw new Error('expected rejection');
};
const newClaim = (over: Partial<ExpenseClaim> = {}): ExpenseClaim => ({
  id: 'new-claim', kind: 'claim', requestNumber: '', employeeCode: '800001', employeeName: '', costCentre: 'CC-101 · Engineering',
  requestDate: '2026-10-15', status: 'draft', submittedOn: null, approvedOn: null, approver: null, createdAt: '', updatedAt: '',
  expenseType: 'local', purpose: 'Vendor visit', items: [], employeeComments: '', approverComments: '', rejectionReason: '', ...over,
});
const line = (id: string, itemKey: string, fields: ExpenseClaim['items'][number]['fields'], attachments: ExpenseClaim['items'][number]['attachments'] = []) =>
  ({ id, itemKey, fields, attachments, approvedAmount: null, approverRemarks: '' });
const file = (name: string, type = 'application/pdf', size = 100) => new File([new Uint8Array(size)], name, { type });


loadReferenceSchema();   // the engine runs on the database seed's expense types and items

test('session reports identity from the gateway, not from any payload', async () => {
  assert.deepEqual(await mk('employee').getSession().then((s) => [s.code, s.role]), ['800001', 'employee']);
  assert.deepEqual(await mk('admin').getSession().then((s) => [s.code, s.role]), ['700010', 'admin']);
});

test('employees see only their own records; approvers see non-draft records of everyone', async () => {
  const e = await mk('employee').listRecords({});
  assert.ok(e.rows.length > 0 && e.rows.every((r) => r.employeeCode === '800001'));
  const a = await mk('admin').listRecords({});
  assert.ok(a.rows.every((r) => r.status !== 'draft'));
  assert.ok(new Set(a.rows.map((r) => r.employeeCode)).size > 3);
  const filtered = await mk('admin').listRecords({ employeeCode: '800002' });
  assert.ok(filtered.rows.length > 0 && filtered.rows.every((r) => r.employeeCode === '800002'));
  const ignored = await mk('employee').listRecords({ employeeCode: '800002' });
  assert.ok(ignored.rows.every((r) => r.employeeCode === '800001'), 'employee cannot widen scope with a filter');
  const page = await mk('employee').listRecords({ kind: 'claim', page: 2, pageSize: 4, sortKey: 'requestDate', sortDir: 'desc' });
  assert.equal(page.rows.length, 2);
  assert.equal(page.total, 6);
});

test('other people\'s records, and other people\'s drafts, look not-found', async () => {
  const g = mk('employee');
  const other = (await mk('admin').listRecords({ employeeCode: '800002' })).rows[0] as TravelClaimRecord;
  await rejects(g.getRecord(other.kind, other.id), 'not_found');
  await rejects(g.getRecord('claim', 'does-not-exist'), 'not_found');
  const adminReading = mk('admin');
  const draft = (await mk('employee').listRecords({ status: 'draft' })).rows[0] as TravelClaimRecord;
  await rejects(adminReading.getRecord('claim', draft.id), 'not_found');
  await rejects(g.getRecord('travel', (await g.listRecords({ kind: 'claim' })).rows[0]!.id), 'not_found', undefined); // wrong kind
});

test('first save assigns a unique request number; later saves keep it; client numbers are ignored', async () => {
  const g = mk('employee');
  const a = await g.saveDraft(newClaim({ id: 'c-a', requestNumber: 'HACKED/0001' }));
  assert.equal(a.requestNumber, '800001/2026/0107', 'next after seed 0106, not the client value');
  const b = await g.saveDraft(newClaim({ id: 'c-b' }));
  assert.equal(b.requestNumber, '800001/2026/0108');
  const again = await g.saveDraft({ ...a, purpose: 'Edited', requestNumber: 'X' } as ExpenseClaim);
  assert.equal(again.requestNumber, a.requestNumber);
  assert.equal((again as ExpenseClaim).purpose, 'Edited');
  const tr = await g.saveDraft({ ...(await g.getRecord('travel', (await g.listRecords({ kind: 'travel' })).rows[0]!.id)), id: 't-new', requestNumber: '' } as TravelRequest);
  assert.equal(tr.requestNumber, 'TR/2026/0049', 'max across ALL users (0048 mine, 0045 Divya)');
  const ar = await g.saveDraft({ id: 'a-new', kind: 'advance', requestNumber: '', employeeCode: '800001', requestDate: '2026-10-15', periodFrom: '', periodTo: '', amount: '', purpose: '', remarks: '', alongWith: '', attachments: [], createLeave: false, travelRequest: '', settled: false, approverRemarks: '' } as unknown as AdvanceRequest);
  assert.equal(ar.requestNumber, 'AR/2026/0024');
});

test('server fills identity: an employee cannot save as someone else; admin may create on behalf', async () => {
  const e = await mk('employee').saveDraft(newClaim({ id: 'c-x', employeeCode: '800003', employeeName: 'Fake' }));
  assert.equal(e.employeeCode, '800001');
  assert.equal(e.employeeName, 'Karthik R');
  const adm = mk('admin');
  const onBehalf = await adm.saveDraft(newClaim({ id: 'c-y', employeeCode: '800003' }));
  assert.equal(onBehalf.employeeCode, '800003');
  assert.equal(onBehalf.employeeName, 'Divya Sree');
  assert.equal(onBehalf.requestNumber, '800003/2026/0005');
  assert.equal(onBehalf.createdBy, '700010');
  await rejects(adm.saveDraft(newClaim({ id: 'c-z', employeeCode: '999999' })), 'validation', /valid employee code/);
  await rejects(adm.saveDraft({ ...onBehalf, employeeCode: '800004' } as ExpenseClaim), 'validation', /cannot be changed/);
});

test('draft save ignores client-supplied status, approver and approved amounts', async () => {
  const g = mk('employee');
  const saved = await g.saveDraft(newClaim({
    id: 'c-t', status: 'approved', approver: 'Me', approvedOn: '2026-10-01', submittedOn: '2026-10-01', rejectionReason: 'x', approverComments: 'ok',
    items: [{ ...line('l1', 'l_da', { date: '2026-10-01', amount: 250 }), approvedAmount: 250, approverRemarks: 'pre-approved' }],
  })) as ExpenseClaim;
  assert.equal(saved.status, 'draft');
  assert.equal(saved.approver, null);
  assert.equal(saved.approvedOn, null);
  assert.equal(saved.submittedOn, null);
  assert.equal(saved.rejectionReason, '');
  assert.equal(saved.approverComments, '');
  assert.equal(saved.items[0]!.approvedAmount, null);
  assert.equal(saved.items[0]!.approverRemarks, '');
});

test('fuel-by-km amount is recomputed server-side (client amount ignored)', async () => {
  const g = mk('employee');
  const s = await g.saveDraft(newClaim({ id: 'c-f', expenseType: 'fuel', items: [line('f1', 'l_fuel_4w', { date: '2026-10-01', fromLocation: 'A', toLocation: 'B', fromKm: 100, toKm: 142, nonAccountableKm: 2, amount: 999999, totalKm: 1 })] })) as ExpenseClaim;
  assert.equal(s.items[0]!.fields.totalKm, 40);
  assert.equal(s.items[0]!.fields.amount, 360);
});

test('approvers can correct only configured GST fields when approving a claim', async () => {
  const ref = buildReferenceData();
  const gstRef = {
    ...ref,
    types: ref.types.map((type) => ({
      ...type,
      items: type.items.map((item) => item.key === 'l_da'
        ? { ...item, fields: [...item.fields, ...GST_FIELD_KEYS] }
        : item),
    })),
  };
  setReferenceData(gstRef);
  try {
    const employee = mk('employee');
    const saved = await employee.saveDraft(newClaim({
      items: [line('gst-line', 'l_da', {
        date: '2026-10-01', amount: 100, gstNumber: 'OLDGST', state: 'Tamil Nadu', igst: '1', cgst: '0', sgst: '0',
      })],
    })) as ExpenseClaim;
    await employee.submit('claim', saved.id);
    employee.setSession('admin');
    const approved = await employee.approve('claim', saved.id, {
      lines: [{
        id: 'gst-line', approvedAmount: 100, approverRemarks: '',
        gstFields: { gstNumber: 'CORRECTEDGST', state: 'Karnataka', igst: '2', cgst: '', sgst: '1' },
      }],
    }) as ExpenseClaim;
    assert.deepEqual(
      GST_FIELD_KEYS.map((key) => approved.items[0]!.fields[key]),
      ['CORRECTEDGST', 'Karnataka', '2', '', '1'],
    );
  } finally {
    loadReferenceSchema();
  }
});

test('only drafts are editable/deletable, only by their owner', async () => {
  const g = mk('employee');
  const submitted = (await g.listRecords({ status: 'submitted', kind: 'claim' })).rows[0] as ExpenseClaim;
  await rejects(g.saveDraft({ ...submitted, purpose: 'tamper' }), 'conflict', /Only drafts/);
  await rejects(g.deleteDraft('claim', submitted.id), 'conflict');
  const adm = mk('admin');
  await rejects(adm.saveDraft({ ...submitted, purpose: 'tamper' }), 'conflict');
  const own = await g.saveDraft(newClaim({ id: 'c-own' }));
  await assert.doesNotReject(g.deleteDraft('claim', own.id));
  await rejects(g.getRecord('claim', own.id), 'not_found');
});

test('submit validates (purpose, lines, cost centre) and moves draft -> submitted once', async () => {
  const g = mk('employee');
  const d = await g.saveDraft(newClaim({ id: 'c-s', purpose: '', costCentre: '' as string }));
  const draft = (await g.getRecord('claim', d.id)) as ExpenseClaim;
  assert.equal(draft.costCentre, 'CC-101 · Engineering', 'server defaults the employee cost centre');
  const e = await rejects(g.submit('claim', d.id), 'validation');
  assert.match(JSON.stringify((e as ApiError).details), /Required to submit/);
  assert.match(JSON.stringify((e as ApiError).details), /Add at least one expense line/);
  await g.saveDraft({ ...draft, purpose: 'Vendor', items: [line('l1', 'l_da', { date: '2026-10-01', amount: 250 })] });
  const s = await g.submit('claim', d.id);
  assert.equal(s.status, 'submitted');
  assert.equal(s.submittedOn, '2026-10-15');
  await rejects(g.submit('claim', d.id), 'conflict');
});

test('submit validates every line (e.g. a medical line without a bill)', async () => {
  const g = mk('employee');
  const d = await g.saveDraft(newClaim({ id: 'c-m', expenseType: 'medical', purpose: 'Check-up', items: [line('m1', 's_med_lab', { date: '2026-10-01', amount: 500 })] }));
  const e = await rejects(g.submit('claim', d.id), 'validation', /Line 1/);
  assert.match(e.message, /Attach at least one bill/);
});

test('medical balance is enforced at submit (9800 left for Karthik)', async () => {
  const g = mk('employee');
  const bill = [{ name: 'b.pdf', size: 1, type: 'application/pdf' }];
  const d = await g.saveDraft(newClaim({ id: 'c-med', expenseType: 'medical', purpose: 'Dental', items: [
    line('a', 's_med_dental', { date: '2026-10-01', amount: 5000 }, bill), line('b', 's_med_rx', { date: '2026-10-01', amount: 5000 }, bill)] }));
  await rejects(g.submit('claim', d.id), 'validation', /exceeds the available medical balance of ₹9,800\.00/);
  await g.saveDraft({ ...(await g.getRecord('claim', d.id)), items: [line('a', 's_med_dental', { date: '2026-10-01', amount: 5000 }, bill), line('b', 's_med_rx', { date: '2026-10-01', amount: 4800 }, bill)] } as ExpenseClaim);
  assert.equal((await g.submit('claim', d.id)).status, 'submitted', 'exactly 9800 is allowed');
});

test('advance limit is enforced at submit and counts pending requests', async () => {
  const g = mk('employee');
  const base = { kind: 'advance', requestNumber: '', employeeCode: '800001', requestDate: '2026-10-15', periodFrom: '2026-11-01', periodTo: '2026-11-03', purpose: 'Training', remarks: '', alongWith: '', attachments: [], createLeave: false, travelRequest: '', settled: false, approverRemarks: '' };
  const big = await g.saveDraft({ ...base, id: 'adv1', amount: 4001 } as unknown as AdvanceRequest);
  await rejects(g.submit('advance', big.id), 'validation', /available advance balance of ₹4,000/);
  await g.saveDraft({ ...big, amount: 4000 } as AdvanceRequest);
  assert.equal((await g.submit('advance', big.id)).status, 'submitted');
  const second = await g.saveDraft({ ...base, id: 'adv2', amount: 1 } as unknown as AdvanceRequest);
  await rejects(g.submit('advance', second.id), 'validation', /balance of ₹0/);
});

test('only approvers can approve/reject; employees get 403, and cannot even read the queue', async () => {
  const e = mk('employee');
  const sub = (await e.listRecords({ status: 'submitted', kind: 'claim' })).rows[0] as ExpenseClaim;
  await rejects(e.approve('claim', sub.id, {}), 'forbidden');
  await rejects(e.reject('claim', sub.id, { rejectionReason: 'x' }), 'forbidden');
  await rejects(e.listPendingApprovals(), 'forbidden');
  await rejects(e.listApprovalHistory(30), 'forbidden');
  await rejects(e.lookupEmployees('a'), 'forbidden');
  assert.equal((await e.getRecord('claim', sub.id)).status, 'submitted', 'unchanged');
});

test('approving a claim needs an amount for every line, between 0 and the claimed amount, validated server-side', async () => {
  const a = mk('admin');
  const c = (await a.getRecord('claim', (await a.listRecords({ kind: 'claim', status: 'submitted', search: '800001/2026/0105' })).rows[0]!.id)) as ExpenseClaim;
  const full = c.items.map((it) => ({ id: it.id, approvedAmount: Number(it.fields.amount), approverRemarks: '' }));
  await rejects(a.approve('claim', c.id, { lines: full.slice(1) }), 'validation', /Approved Amount/);
  await rejects(a.approve('claim', c.id, { lines: full.map((l, i) => (i === 0 ? { ...l, approvedAmount: -1 } : l)) }), 'validation');
  await rejects(a.approve('claim', c.id, { lines: full.map((l, i) => (i === 0 ? { ...l, approvedAmount: l.approvedAmount + 0.01 } : l)) }), 'validation');
  assert.equal((await a.getRecord('claim', c.id)).status, 'submitted', 'failed attempts changed nothing');
  const lines = full.map((l, i) => (i === 1 ? { ...l, approvedAmount: 5000, approverRemarks: 'Capped' } : l));
  const done = (await a.approve('claim', c.id, { lines, approverComments: 'ok' })) as ExpenseClaim;
  assert.equal(done.status, 'approved');
  assert.equal(done.approver, 'Priya Natarajan');
  assert.equal(done.approvedOn, '2026-10-15');
  assert.equal(done.items[1]!.approvedAmount, 5000);
  assert.equal(done.items.reduce((s, it) => s + (it.approvedAmount ?? 0), 0), claimTotal(c) - 600);
  await rejects(a.approve('claim', c.id, { lines }), 'conflict', /submitted/);
  await rejects(a.reject('claim', c.id, { rejectionReason: 'late' }), 'conflict');
});

test('rejecting needs a reason; undecided lines become 0; employee can then copy the claim', async () => {
  const a = mk('admin');
  const c = (await a.listRecords({ kind: 'claim', status: 'submitted', search: '800003/2026/0004' })).rows[0] as ExpenseClaim;
  await rejects(a.reject('claim', c.id, { rejectionReason: '  ' }), 'validation', /Rejection Reason/);
  const r = (await a.reject('claim', c.id, { rejectionReason: 'Missing bill' })) as ExpenseClaim;
  assert.equal(r.status, 'rejected');
  assert.equal(r.rejectionReason, 'Missing bill');
  assert.ok(r.items.every((it) => it.approvedAmount === 0));
  const tr = (await a.listRecords({ kind: 'travel', status: 'submitted' })).rows[0] as TravelRequest;
  await rejects(a.reject('travel', tr.id, {}), 'validation', /Approver Remarks/);
  assert.equal((await a.reject('travel', tr.id, { approverRemarks: 'Dates clash' })).status, 'rejected');
  assert.equal(((await a.getRecord('travel', tr.id)) as TravelRequest).approverRemarks, 'Dates clash');
});

test('copy rejected claim: owner only, fresh draft with new number, original untouched', async () => {
  const e = mk('employee');
  const rej = (await e.listRecords({ kind: 'claim', status: 'rejected' })).rows[0] as ExpenseClaim;
  const copy = await e.copyRejectedClaim(rej.id);
  assert.equal(copy.status, 'draft');
  assert.equal(copy.requestNumber, '800001/2026/0107');
  assert.equal(copy.rejectionReason, '');
  assert.equal(((await e.getRecord('claim', rej.id)) as ExpenseClaim).status, 'rejected');
  await rejects(mk('admin').copyRejectedClaim(rej.id), 'forbidden');
  const approved = (await e.listRecords({ kind: 'claim', status: 'approved' })).rows[0]!;
  await rejects(e.copyRejectedClaim(approved.id), 'forbidden');
});

test('queue and history come from the approvals rules (oldest first; 30-day window)', async () => {
  const a = mk('admin');
  const pending = await a.listPendingApprovals();
  assert.ok(pending.length > 0 && pending.every((r) => r.status === 'submitted'));
  assert.deepEqual(pending.map((r) => r.submittedOn), pending.map((r) => r.submittedOn).sort());
  const hist = await a.listApprovalHistory(30);
  assert.ok(hist.length > 0 && hist.every((r) => String(r.approvedOn) >= '2026-09-15'));
  const narrower = await a.listApprovalHistory(10);
  assert.ok(narrower.every((r) => String(r.approvedOn) >= '2026-10-05'));
});

test('receipt box: approvers excluded; upload validates type/size; edit/delete blocked while on a claim', async () => {
  await rejects(mk('admin').listReceipts(), 'forbidden');
  const g = mk('employee');
  assert.equal((await g.listReceipts()).length, 5);
  await rejects(g.uploadReceipts([file('x.gif', 'image/gif')]), 'validation', /only PDF, JPG or PNG/);
  await rejects(g.uploadReceipts([file('big.pdf', 'application/pdf', 5 * 1024 * 1024 + 1)]), 'validation', /larger than 5 MB/);
  assert.equal((await g.listReceipts()).length, 5, 'nothing stored after a rejected batch');
  const up = await g.uploadReceipts([file('a.pdf'), file('b.png', 'image/png')]);
  assert.equal(up.length, 2);
  assert.ok(up.every((r) => r.employeeCode === '800001' && r.usedIn === null && r.date === ''));
  const edited = await g.updateReceipt({ ...up[0]!, billerName: 'Cafe', amount: 120, date: '2026-10-14', usedIn: { claimId: 'forged', requestNumber: 'x', lineId: 'y' }, employeeCode: '800002' });
  assert.equal(edited.billerName, 'Cafe');
  assert.equal(edited.usedIn, null, 'usage is server-owned');
  assert.equal(edited.employeeCode, '800001', 'owner is server-owned');
  await rejects(g.updateReceipt({ ...up[0]!, date: '2026-12-31' }), 'validation', /future/);
  await assert.doesNotReject(g.deleteReceipt(up[1]!.id));
  await rejects(g.deleteReceipt(up[1]!.id), 'not_found');
});

test('receipt link/release: saving links bills, removing a line or deleting the draft frees them, others cannot be touched', async () => {
  const g = mk('employee');
  const att = (id: string, name: string) => ({ name, size: 1, type: 'application/pdf', receiptId: id });
  const d = await g.saveDraft(newClaim({ id: 'c-r', items: [
    line('l1', 'l_conveyance', { date: '2026-10-05', modeOfTravel: 'Cab', fromLocation: 'A', toLocation: 'B', amount: 410 }, [att('rcpt-1', 'uber-trip-oct05.jpg')]),
    line('l2', 'l_food_lunch', { date: '2026-10-10', amount: 260 }, [att('rcpt-4', 'saravana-lunch-1010.jpg')])] }));
  let rc = await g.listReceipts();
  assert.equal(rc.find((r) => r.id === 'rcpt-1')!.usedIn!.requestNumber, d.requestNumber);
  assert.equal(rc.find((r) => r.id === 'rcpt-1')!.usedIn!.lineId, 'l1');
  await rejects(g.deleteReceipt('rcpt-1'), 'conflict');
  await rejects(g.updateReceipt({ ...rc.find((r) => r.id === 'rcpt-1')!, notes: 'n' }), 'conflict');
  // Another claim cannot take a bill that is already used.
  await rejects(g.saveDraft(newClaim({ id: 'c-r2', items: [line('z', 'l_conveyance', { date: '2026-10-05', amount: 1 }, [att('rcpt-1', 'x')])] })), 'conflict', /already on another claim/);
  // The same bill on two lines of one claim is rejected.
  await rejects(g.saveDraft(newClaim({ id: 'c-r3', items: [line('p', 'l_food_lunch', { date: '2026-10-05', amount: 1 }, [att('rcpt-2', 'x')]), line('q', 'l_food_lunch', { date: '2026-10-05', amount: 1 }, [att('rcpt-2', 'x')])] })), 'conflict', /more than one line/);
  // A bill that is not in my box (or does not exist) is rejected.
  await rejects(g.saveDraft(newClaim({ id: 'c-r4', items: [line('p', 'l_food_lunch', { date: '2026-10-05', amount: 1 }, [att('nope', 'x')])] })), 'validation', /not in your receipt box/);
  // Removing line 1 frees its bill; the other stays linked.
  await g.saveDraft({ ...(await g.getRecord('claim', d.id)) as ExpenseClaim, items: [(await g.getRecord('claim', d.id) as ExpenseClaim).items[1]!] });
  rc = await g.listReceipts();
  assert.equal(rc.find((r) => r.id === 'rcpt-1')!.usedIn, null);
  assert.ok(rc.find((r) => r.id === 'rcpt-4')!.usedIn);
  // Deleting the draft frees the rest.
  await g.deleteDraft('claim', d.id);
  assert.ok((await g.listReceipts()).every((r) => r.usedIn === null));
});

test('a bill that belongs to another employee cannot be attached to my claim', async () => {
  const g = mk('employee');
  // Divya (800003) has no seeded bills; use the admin to create a claim on her behalf referencing Karthik's bill.
  const adm = mk('admin');
  await rejects(adm.saveDraft(newClaim({ id: 'c-x1', employeeCode: '800003', items: [line('p', 'l_food_lunch', { date: '2026-10-05', amount: 1 }, [{ name: 'x', size: 1, type: 'application/pdf', receiptId: 'rcpt-1' }])] })), 'validation', /not in your receipt box/);
  assert.equal((await g.listReceipts()).find((r) => r.id === 'rcpt-1')!.usedIn, null);
});

test('copying a rejected claim does not steal bills still held by another claim', async () => {
  const g = mk('employee');
  const att = { name: 'u.jpg', size: 1, type: 'image/jpeg', receiptId: 'rcpt-1' };
  const d = await g.saveDraft(newClaim({ id: 'c-c', items: [line('l1', 'l_conveyance', { date: '2026-10-05', modeOfTravel: 'Cab', fromLocation: 'A', toLocation: 'B', amount: 410 }, [att])] }));
  assert.equal((await g.submit('claim', d.id)).status, 'submitted');
  g.setSession('admin');
  await g.reject('claim', d.id, { rejectionReason: 'Redo' });
  g.setSession('employee');
  const copy = await g.copyRejectedClaim(d.id);
  assert.deepEqual(copy.items[0]!.attachments, [], 'bill still linked to the original is not carried over');
  assert.equal(copy.items[0]!.fields.amount, 410, 'the rest of the line is kept');
  assert.equal((await g.listReceipts()).find((r) => r.id === 'rcpt-1')!.usedIn!.claimId, d.id, 'bill stays on the original claim');
});

test('attachments: type/size checked, only on editable own records; downloading is explicitly unsupported in demo', async () => {
  const g = mk('employee');
  const d = await g.saveDraft(newClaim({ id: 'c-at' }));
  const meta = await g.uploadAttachment(file('a.pdf'), { kind: 'claim', recordId: d.id });
  assert.deepEqual(meta, { name: 'a.pdf', size: 100, type: 'application/pdf' });
  await rejects(g.uploadAttachment(file('a.exe', 'application/octet-stream'), { kind: 'claim', recordId: d.id }), 'validation');
  const submitted = (await g.listRecords({ status: 'submitted', kind: 'claim' })).rows[0]!;
  await rejects(g.uploadAttachment(file('a.pdf'), { kind: 'claim', recordId: submitted.id }), 'forbidden');
  await rejects(g.openAttachment(meta), 'client', /file details only/);
});

test('employee lookup is approver-only and searches code, name and department', async () => {
  const a = mk('admin');
  assert.deepEqual((await a.lookupEmployees('divya')).map((e) => e.code), ['800003']);
  assert.deepEqual((await a.lookupEmployees('engineering')).map((e) => e.code).sort(), ['800001', '800004']);
  assert.equal((await a.lookupEmployees('800000'))[0]!.name, 'Selva Kumar');
});

test('state is isolated per instance, reset restores the seed, nothing touches localStorage', async () => {
  const g1 = mk('employee'); const g2 = mk('employee');
  await g1.saveDraft(newClaim({ id: 'iso' }));
  assert.equal((await g2.listRecords({ kind: 'claim' })).total, 6);
  assert.equal((await g1.listRecords({ kind: 'claim' })).total, 7);
  g1.reset();
  assert.equal((await g1.listRecords({ kind: 'claim' })).total, 6);
  assert.equal(typeof (globalThis as { localStorage?: unknown }).localStorage, 'undefined');
});
