import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpGateway, normalizeRole, toApiError, toDraftPayload } from '../src/services/SpGateway.ts';
import { SP, type ExecSp, type FileApi } from '../src/services/spContract.ts';
import { createGateway } from '../src/services/index.ts';
import { ApiError } from '../src/services/apiClient.ts';
import type { AdvanceRequest, ExpenseClaim, Receipt, TravelRequest } from '../src/types/domain.ts';

type Call = { sp: string; params: Record<string, unknown> };
function setup(reply: (sp: string, params: Record<string, unknown>) => unknown = () => ({})) {
  const calls: Call[] = []; const uploads: string[] = [];
  const execSp: ExecSp = async (sp, params = {}) => { calls.push({ sp, params }); const r = reply(sp, params); if (r instanceof Error) throw r; return r; };
  const files: FileApi = {
    upload: async (f, t) => { if (f.name.startsWith('bad')) throw new Error('[VALIDATION] Only PDF, JPG or PNG files are accepted.'); uploads.push(f.name + ':' + (t?.kind ?? '')); return { fileId: 'S-' + f.name, docType: t?.kind === 'receipt' ? 'TA_RECEIPT' : 'TA_CLAIM', name: f.name, size: f.size, type: f.type }; },
    download: async (a) => new Blob([a.docType + '/' + a.fileId]),
  };
  return { g: new SpGateway(execSp, files), calls, uploads };
}
const claim = (): ExpenseClaim => ({
  id: 'c1', kind: 'claim', requestNumber: 'HACK/1', employeeCode: '800001', employeeName: 'K', costCentre: 'CC', requestDate: '2026-10-01', status: 'approved', submittedOn: 'x', approvedOn: 'y', approver: 'Me', createdAt: 'a', updatedAt: 'b',
  expenseType: 'local', purpose: 'p', items: [{ id: 'l1', itemKey: 'l_da', fields: { date: '2026-10-01', amount: 250 }, attachments: [{ name: 'a.pdf', size: 1, type: 'application/pdf', fileId: 'S1', docType: 'TA_CLAIM' }], approvedAmount: 250, approverRemarks: 'x' }],
  employeeComments: 'c', approverComments: 'ac', rejectionReason: 'rr',
});

test('draft payloads never carry server-owned fields (request number, status, approver, dates, approved amounts, rejection text)', () => {
  const p = toDraftPayload(claim()) as Record<string, any>;
  for (const k of ['requestNumber', 'status', 'submittedOn', 'approvedOn', 'approver', 'createdAt', 'updatedAt', 'approverComments', 'rejectionReason']) assert.ok(!(k in p), k);
  assert.deepEqual(Object.keys(p.items[0]).sort(), ['attachments', 'fields', 'id', 'itemKey']);
  assert.equal(p.purpose, 'p'); assert.equal(p.employeeComments, 'c'); assert.equal(p.items[0].attachments[0].fileId, 'S1', 'file references are kept'); assert.equal(p.items[0].attachments[0].docType, 'TA_CLAIM');
  const t = toDraftPayload({ id: 't', kind: 'travel', requestNumber: 'TR/1', status: 'approved', approverRemarks: 'ok', purpose: 'Audit' } as unknown as TravelRequest) as Record<string, any>;
  assert.deepEqual(Object.keys(t).sort(), ['id', 'kind', 'purpose']);
  const a = toDraftPayload({ id: 'a', kind: 'advance', settled: true, approverRemarks: 'ok', amount: 5 } as unknown as AdvanceRequest) as Record<string, any>;
  assert.deepEqual(Object.keys(a).sort(), ['amount', 'id', 'kind'], 'an advance cannot mark itself settled');
});

test('each operation calls its stored procedure with the agreed PascalCase parameters', async () => {
  const { g, calls } = setup((sp) => (sp === SP.getSession ? { code: '800001', name: 'K', role: 'employee' } : sp === SP.listRequests ? { rows: [], total: 0 } : [ SP.listPendingApprovals, SP.listApprovalHistory, SP.listReceipts, SP.lookupEmployees ].includes(sp as never) ? [] : { id: 'x', kind: 'claim' }));
  await g.getSession(); await g.listRecords({ kind: 'claim', employeeCode: '800002', status: 'submitted', search: 's', from: '2026-01-01', to: '2026-02-01', page: 2, pageSize: 10, sortKey: 'total', sortDir: 'desc' });
  await g.getRecord('travel', 'T1'); await g.submit('advance', 'A1'); await g.deleteDraft('claim', 'C1'); await g.copyRejectedClaim('C2');
  await g.approve('claim', 'C3', { lines: [{ id: 'l1', approvedAmount: 5, approverRemarks: 'r' }], approverComments: 'ok' });
  await g.reject('travel', 'T2', { approverRemarks: 'no' }); await g.reject('claim', 'C4', { rejectionReason: 'bad' });
  await g.listPendingApprovals(); await g.listApprovalHistory(30); await g.listReceipts(); await g.deleteReceipt('R1'); await g.lookupEmployees('div');
  const by = (sp: string) => calls.filter((c) => c.sp === sp).map((c) => c.params);
  assert.deepEqual(by(SP.getSession), [{}]);
  assert.deepEqual(by(SP.listRequests), [{ Kind: 'claim', EmployeeCode: '800002', Status: 'submitted', Search: 's', From: '2026-01-01', To: '2026-02-01', Page: 2, PageSize: 10, SortKey: 'total', SortDir: 'desc' }]);
  assert.deepEqual(by(SP.getRequest), [{ Kind: 'travel', Id: 'T1' }]);
  assert.deepEqual(by(SP.submitRequest), [{ Kind: 'advance', Id: 'A1' }]);
  assert.deepEqual(by(SP.deleteDraft), [{ Kind: 'claim', Id: 'C1' }]);
  assert.deepEqual(by(SP.copyRejectedClaim), [{ Id: 'C2' }]);
  assert.deepEqual(by(SP.approveRequest), [{ Kind: 'claim', Id: 'C3', Lines: [{ id: 'l1', approvedAmount: 5, approverRemarks: 'r' }], ApproverComments: 'ok', ApproverRemarks: undefined }]);
  assert.deepEqual(by(SP.rejectRequest).map((p) => [p.Kind, p.ApproverRemarks, p.RejectionReason]), [['travel', 'no', undefined], ['claim', undefined, 'bad']]);
  assert.deepEqual([by(SP.listApprovalHistory), by(SP.deleteReceipt), by(SP.lookupEmployees)], [[{ Days: 30 }], [{ Id: 'R1' }], [{ Query: 'div' }]]);
  for (const c of calls) { for (const k of ['RequestedBy', 'Role', 'role', 'EmployeeId']) assert.ok(!(k in c.params), `${c.sp} must not send ${k}: identity comes from the token`); }
});

test('saveDraft sends only the draft payload; the SP result is returned as the saved request', async () => {
  const { g, calls } = setup(() => ({ id: 'c1', kind: 'claim', requestNumber: '800001/2026/0107', status: 'draft' }));
  const saved = await g.saveDraft(claim());
  assert.equal(saved.requestNumber, '800001/2026/0107');
  assert.equal(calls[0]!.sp, SP.saveRequestDraft); assert.equal(calls[0]!.params.Kind, 'claim');
  assert.ok(!('status' in (calls[0]!.params.Request as object)));
});

test('SP errors are mapped by their [CODE] prefix; unknown errors become server errors', async () => {
  const cases: Array<[string, string, number | null]> = [
    ['[FORBIDDEN] You cannot edit this request', 'forbidden', 403], ['[VALIDATION] Amount: Required', 'validation', 422], ['[NOT_FOUND] Record not found', 'not_found', 404],
    ['[CONFLICT] Only drafts can be edited', 'conflict', 409], ['[UNAUTHORIZED] Session expired', 'unauthorized', 401], ['Timeout expired. The timeout period elapsed', 'server', null], ['[WHATEVER] x', 'server', null],
  ];
  for (const [msg, code, status] of cases) {
    const { g } = setup(() => new Error(msg));
    const caught = await g.getRecord('claim', 'x').then(() => null, (x: unknown) => x);
    if (!(caught instanceof ApiError)) throw new Error(`expected an ApiError for ${msg}`);
    const e: ApiError = caught;
    assert.deepEqual([e.code, e.status], [code, status], msg);
    if (code !== 'server') { assert.equal(e.message, msg.replace(/^\[[A-Z_]+\]\s*/, '')); assert.deepEqual(e.details, { summary: [e.message] }, 'shown in the form summary'); }
  }
  assert.equal(toApiError(new ApiError('conflict', 'c', 409, 'c', null)).code, 'conflict', 'ApiErrors pass through');
});

test('malformed SP responses are parse errors, not silent garbage', async () => {
  for (const [call, reply] of [
    [(g: SpGateway) => g.listPendingApprovals(), { not: 'an array' }], [(g: SpGateway) => g.listReceipts(), null], [(g: SpGateway) => g.getSession(), 'text'],
    [(g: SpGateway) => g.getRecord('claim', 'x'), []], [(g: SpGateway) => g.listRecords({}), [1, 2]],
  ] as const) {
    const { g } = setup(() => reply);
    const e = await call(g).then(() => null, (x: unknown) => x as ApiError);
    assert.equal(e?.code, 'parse');
  }
});

test('listRecords falls back to rows.length when the SP omits a total; policy null stays null and partial policy merges over the documented fallback values', async () => {
  assert.equal((await setup(() => ({ rows: [{ id: 'a' }, { id: 'b' }] })).g.listRecords({})).total, 2);
  assert.equal(await setup(() => null).g.getPolicy(), null);
  const p = await setup(() => ({ policy: { medicalAnnualLimit: 20000 } })).g.getPolicy();
  assert.deepEqual([p?.policy.medicalAnnualLimit, p?.policy.advanceLimit], [20000, 15000]);
});

test('location policy limit calls its SP with item, optional stay location, and optional bill availability', async () => {
  const { g, calls } = setup((sp) => sp === SP.getLocationPolicyLimit ? { limit: 4500, limitPer: 'night', enforceEligibility: 'Y' } : {});
  assert.deepEqual(await g.getLocationPolicyLimit('o_lodge', 'Mumbai'), { limit: 4500, limitPer: 'night', enforceEligibility: 'Y' });
  assert.deepEqual(await g.getLocationPolicyLimit('l_food_dinner', '', 'No'), { limit: 4500, limitPer: 'night', enforceEligibility: 'Y' });
  assert.deepEqual(calls, [
    { sp: SP.getLocationPolicyLimit, params: { ItemKey: 'o_lodge', StayLocation: 'Mumbai' } },
    { sp: SP.getLocationPolicyLimit, params: { ItemKey: 'l_food_dinner', IsBillAvailable: 'No' } },
  ]);
  assert.equal(await setup(() => null).g.getLocationPolicyLimit('o_lodge', 'Mumbai'), null);
  assert.deepEqual(await setup((sp) => sp === SP.getLocationPolicyLimit ? { limit: 4500, EnforceEligibility: 'n' } : {}).g.getLocationPolicyLimit('o_lodge', 'Mumbai'),
    { limit: 4500, limitPer: null, enforceEligibility: 'N' });
  await assert.rejects(setup(() => ({ limit: 100, enforceEligibility: 'yes' })).g.getLocationPolicyLimit('o_lodge', 'Mumbai'),
    (e: unknown) => e instanceof ApiError && e.code === 'parse');
});

test('receipt upload is all-or-nothing: files are uploaded first; one bad file means no SP call; otherwise ONE register call', async () => {
  const f = (n: string) => new File(['x'], n, { type: 'application/pdf' });
  const bad = setup();
  await assert.rejects(bad.g.uploadReceipts([f('a.pdf'), f('bad.pdf')]), (e: unknown) => e instanceof ApiError && e.code === 'validation');
  assert.equal(bad.calls.length, 0, 'nothing registered when any upload failed');
  const ok = setup(() => [{ id: 'r1' }, { id: 'r2' }]);
  const r = await ok.g.uploadReceipts([f('a.pdf'), f('b.pdf')]);
  assert.equal(r.length, 2); assert.deepEqual(ok.uploads, ['a.pdf:receipt', 'b.pdf:receipt']);
  assert.equal(ok.calls.length, 1); assert.equal(ok.calls[0]!.sp, SP.createReceipts);
  assert.deepEqual(ok.calls[0]!.params, { Files: [{ FileId: 'S-a.pdf', DocType: 'TA_RECEIPT', Name: 'a.pdf', Size: 1, Type: 'application/pdf' }, { FileId: 'S-b.pdf', DocType: 'TA_RECEIPT', Name: 'b.pdf', Size: 1, Type: 'application/pdf' }] });
});

test('receipt update sends descriptive fields only (file, owner and usage are server-owned)', async () => {
  const { g, calls } = setup(() => ({ id: 'r1' }));
  await g.updateReceipt({ id: 'r1', employeeCode: '999', file: { name: 'x', size: 1, type: 't' }, uploadedAt: 'u', date: '2026-10-01', billerName: 'B', billNumber: 'N', amount: 10, notes: 'n', usedIn: { claimId: 'forged', requestNumber: 'x', lineId: 'y' } } as Receipt);
  assert.deepEqual(calls[0]!.params, { Receipt: { id: 'r1', date: '2026-10-01', billerName: 'B', billNumber: 'N', amount: 10, notes: 'n' } });
});

test('attachments: upload returns metadata with the stored fileId; download needs a fileId', async () => {
  const { g } = setup();
  const meta = await g.uploadAttachment(new File(['abc'], 'a.pdf', { type: 'application/pdf' }), { kind: 'claim', recordId: 'c1', lineId: 'l1' });
  assert.deepEqual(meta, { name: 'a.pdf', size: 3, type: 'application/pdf', fileId: 'S-a.pdf', docType: 'TA_CLAIM' });
  assert.equal(await (await g.openAttachment(meta)).text(), 'TA_CLAIM/S-a.pdf');
  await assert.rejects(g.openAttachment({ name: 'x', size: 1, type: 't', fileId: 'only-id' }), (e: unknown) => e instanceof ApiError && /no stored file/.test(e.message));
  await assert.rejects(g.uploadAttachment(new File(['x'], 'bad.pdf', { type: 'application/pdf' }), { kind: 'claim', recordId: 'c' }), (e: unknown) => e instanceof ApiError && e.code === 'validation');
});

test('factory: createGateway wraps the shared execSp and the file client in an SpGateway', async () => {
  const gw = createGateway({ execSp: async () => ({ code: '1', name: 'N', role: 'employee' }), files: { upload: async () => ({ fileId: 'f', docType: 'TA_CLAIM', name: 'n', size: 1, type: 't' }), download: async () => new Blob() },
    auth: {} as never, store: {} as never, restore: async () => true });
  assert.ok(gw instanceof SpGateway);
  assert.equal((await gw.getSession()).role, 'employee');
});

test('the role is decided by the server and normalised: admin/approver in any case or an isApprover flag => admin, anything else => employee', async () => {
  for (const [raw, want] of [[{ role: 'admin' }, 'admin'], [{ role: 'Admin' }, 'admin'], [{ role: ' APPROVER ' }, 'admin'], [{ role: 'Administrator' }, 'admin'],
    [{ role: 'employee' }, 'employee'], [{ role: 'Employee' }, 'employee'], [{ role: 'Finance Head' }, 'employee'], [{}, 'employee'], [{ role: 'employee', isApprover: true }, 'admin'],
    [{ role: 'employee', isAdmin: 1 }, 'admin'], [{ role: 'employee', isApprover: 'false' }, 'employee'], [{ role: null }, 'employee']] as const) {
    assert.equal(normalizeRole(raw), want, JSON.stringify(raw));
  }
  const { g } = setup(() => ({ code: 800001, name: 'K', role: 'Admin' }));
  const s = await g.getSession();
  assert.deepEqual([s.role, s.code], ['admin', '800001'], 'the session role is normalised and the code is a string');
  await assert.rejects(setup(() => ({ role: 'admin' })).g.getSession(), (e: unknown) => e instanceof ApiError && e.code === 'parse');
});

test('view mode: an approver in the employee view sends ActAs=employee on every call (and nothing in the approver view); the session reports the capability', async () => {
  const { g, calls } = setup((sp) => (sp === SP.getSession ? { code: '700010', name: 'P', role: 'Admin' } : sp === SP.listReceipts ? [] : { id: 'x' }));
  const s = await g.getSession();
  assert.deepEqual([s.role, s.isApprover], ['admin', true]);
  await g.listReceipts();
  assert.equal('ActAs' in calls.at(-1)!.params, false, 'default (approver) view sends no hint');
  g.setViewMode('employee');
  await g.listReceipts(); await g.getRecord('claim', 'c1'); await g.submit('claim', 'c1');
  for (const c of calls.slice(-3)) assert.equal(c.params.ActAs, 'employee', c.sp);
  g.setViewMode('admin');
  await g.listReceipts();
  assert.equal('ActAs' in calls.at(-1)!.params, false);
  const emp = await setup(() => ({ code: '800001', name: 'K', role: 'employee' })).g.getSession();
  assert.deepEqual([emp.role, emp.isApprover], ['employee', false]);
});
