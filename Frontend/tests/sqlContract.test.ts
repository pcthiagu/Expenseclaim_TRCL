import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SP } from '../src/services/spContract.ts';
import { DEFAULT_POLICY } from '../src/config/policy.ts';
import { buildReferenceData, parseSeed } from './helpers/referenceData.ts';
import { EXPECTED_SCHEMA_REV, SCHEMA_SCRIPTS } from '../src/config/schemaRev.ts';

/**
 * Contract between the app and the SQL in sql/TA. These tests read the SQL as TEXT: they do not run it (there is no SQL Server here), but they stop
 * the two sides drifting apart: names, JSON keys, reference data and the rules that must be enforced server-side.
 */
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../sql/TA');
const read = (f: string): string => fs.readFileSync(path.join(dir, f), 'utf8');
// Only the install files that DEFINE behaviour (01-07): the dev seed and the smoke test quote the same messages, which would hide a deleted rule.
const all = fs.readdirSync(dir).filter((f) => /^0[1-7]_.*\.sql$/.test(f)).map(read).join('\n');
const fn = read('03_functions.sql');
const snippets = fs.readFileSync(path.resolve(dir, '../../docs/TA_backend_snippets.js'), 'utf8');
test('every procedure the app calls is installed and whitelisted for the backend', () => {
  for (const name of Object.values(SP)) {
    assert.match(all, new RegExp(`CREATE OR ALTER PROCEDURE dbo\\.${name}\\b`), `${name} is not created`);
    assert.ok(snippets.includes(`"${name}"`), `${name} is missing from docs/TA_backend_snippets.js (whitelist)`);
  }
  assert.equal(Object.values(SP).length, 21);
});

test('every procedure follows the backend convention: @JsonParam in, caller from ExecutedBy, one JsonResult column out', () => {
  const procs = [...all.matchAll(/CREATE OR ALTER PROCEDURE dbo\.(TA_usp_\w+)([\s\S]*?)\nGO/g)];
  assert.ok(procs.length >= 19);
  for (const [, name, body] of procs) {
    if (name === 'TA_usp_Internal_NextNumber') continue;               // internal helper, never whitelisted or called from the API
    assert.match(body!, /@JsonParam NVARCHAR\(MAX\)/, `${name}: @JsonParam`);
    assert.match(body!, /JSON_VALUE\(@JsonParam, '\$\.ExecutedBy'\)/, `${name}: caller must come from ExecutedBy`);
    assert.match(body!, /AS JsonResult/, `${name}: result column must be JsonResult`);
    assert.doesNotMatch(body!, /\$\.RequestedBy|\$\.Role\b|\$\.EmployeeId\b/i, `${name}: must not read a browser-supplied identity`);
  }
  assert.ok(!snippets.includes('"TA_usp_Internal_NextNumber"'));
});

test('the JSON builders emit every key the screens read (src/types/domain.ts), per request kind', () => {
  const section = (kind: string): string => {
    const start = fn.indexOf(`IF @kind = N'${kind}'`) >= 0 ? fn.indexOf(`IF @kind = N'${kind}'`) : fn.indexOf(`ELSE IF @kind = N'${kind}'`);
    const next = ['claim', 'travel', 'advance'].map((k) => fn.indexOf(`@kind = N'${k}'`, start + 10)).filter((i) => i > start).sort((a, b) => a - b)[0] ?? fn.indexOf('RETURN @j');
    return fn.slice(start, next);
  };
  const base = ['id', 'kind', 'requestNumber', 'employeeCode', 'employeeName', 'costCentre', 'requestDate', 'status', 'submittedOn', 'approvedOn', 'approver', 'createdBy', 'createdAt', 'updatedAt'];
  const keys: Record<string, string[]> = {
    claim: [...base, 'expenseType', 'purpose', 'travelFrom', 'travelTo', 'items', 'employeeComments', 'approverComments', 'rejectionReason', 'fields', 'attachments', 'approvedAmount', 'approverRemarks', 'itemKey'],
    travel: [...base, 'purpose', 'remarks', 'fromLocation', 'toLocation', 'periodFrom', 'periodTo', 'items', 'advanceRequired', 'overallRemarks', 'approverRemarks', 'alongWith', 'attachments', 'createLeave', 'item', 'amount'],
    advance: [...base, 'periodFrom', 'periodTo', 'amount', 'purpose', 'remarks', 'alongWith', 'attachments', 'createLeave', 'travelRequest', 'settled', 'approverRemarks'],
  };
  for (const [kind, list] of Object.entries(keys)) {
    const sec = section(kind);
    assert.ok(sec.length > 200, `${kind}: section found`);
    for (const k of list) assert.match(sec, new RegExp(`\\bAS ${k}\\b`), `${kind}: JSON key "${k}" is missing`);
    assert.match(sec, /INCLUDE_NULL_VALUES/, `${kind}: explicit nulls (an undecided approved amount must be null, not missing)`);
  }
  const rc = fn.slice(fn.indexOf('TA_fn_ReceiptJson'), fn.indexOf('TA_fn_RequestJson'));
  for (const k of ['id', 'employeeCode', 'file', 'uploadedAt', 'date', 'billerName', 'billNumber', 'amount', 'notes', 'usedIn', 'claimId', 'requestNumber', 'lineId']) assert.match(rc, new RegExp(`\\bAS \\[?${k}\\]?\\b`), `receipt key ${k}`);
});

test('the SQL seed is the single source of the reference data: complete, consistent and loadable by the app', () => {
  const seed = parseSeed();
  const ref = buildReferenceData(['CC-1']);
  assert.equal(ref.types.length, 5);
  assert.deepEqual(ref.types.map((t) => t.key), ['fuel', 'local', 'medical', 'other', 'outside'], 'expense types in the order the dropdown shows them');
  assert.equal(ref.types.reduce((n, t) => n + t.items.length, 0), 32);
  assert.equal(ref.fields.length, 22);
  const fieldKeys = new Set(ref.fields.map((f) => f.key));
  const itemKeys = new Set<string>();
  for (const t of ref.types) for (const i of t.items) {
    assert.ok(!itemKeys.has(i.key), `item ${i.key} is unique`); itemKeys.add(i.key);
    assert.ok(i.fields.length > 0, `${i.key} has fields`);
    for (const f of i.fields) assert.ok(fieldKeys.has(f), `${i.key} uses undefined field ${f}`);
    if (i.compute) assert.ok(i.rate, `${i.key}: a computed item needs a rate key`);
  }
  for (const f of ref.fields) if (f.options) assert.ok(ref.lookups[f.options]?.length, `field ${f.key} points at the option list ${f.options}`);
  for (const k of ['MODES', 'CITIES', 'TRAVEL_PURPOSE', 'ESTIMATE_ITEM']) assert.ok((ref.lookups[k] ?? []).length > 0, `option list ${k}`);
  assert.deepEqual(ref.lookups.COST_CENTRE, ['CC-1'], 'cost centres come from the employee view, not the seed');
  assert.equal(seed.TA_Setting!.length, 7);
  // Policy settings the procedures read by name must exist in the seed.
  const names = new Set(seed.TA_Setting!.map((r) => r.SettingKey));
  for (const k of ['RateTwoWheelerPerKm', 'RateFourWheelerPerKm', 'MedicalAnnualLimit', 'AdvanceLimit', 'AttachmentMaxBytes', 'AttachmentTypes', 'AllowSelfApproval']) assert.ok(names.has(k), `setting ${k}`);
  assert.equal(String(seed.TA_Setting!.find((r) => r.SettingKey === 'RateFourWheelerPerKm')!.SettingValue), String(DEFAULT_POLICY.rates.fourWheelerPerKm));
  // The registry in the app accepts it (this is what runs at start-up).
  assert.doesNotThrow(() => buildReferenceData());
});

test('GetReferenceData returns everything the screens read, and the tables/columns it needs exist', () => {
  const proc = all.slice(all.indexOf('CREATE OR ALTER PROCEDURE dbo.TA_usp_GetReferenceData'), all.indexOf('CREATE OR ALTER PROCEDURE dbo.TA_usp_LookupEmployees'));
  for (const k of ['key', 'label', 'type', 'required', 'computed', 'full', 'readonly', 'options', 'placeholder', 'helper', 'min', 'step', 'short', 'family', 'description', 'showBalance', 'travelPeriod', 'items', 'fields', 'compute', 'rate', 'limit', 'limitPer', 'limitQty', 'fixed', 'attachmentOptional'])
    assert.match(proc, new RegExp(`AS \\[${k}\\]`), `key ${k}`);
  assert.match(proc, /FROM dbo\.TA_Lookup/); assert.match(proc, /FROM dbo\.TA_vw_Employee/); assert.match(proc, /"COST_CENTRE"/);
  assert.match(all, /JSON array of FieldKeys/, 'FieldList is a JSON array (order preserved)');
});

test('the approval trail procedure returns who/what/when and is allowed in both views', () => {
  const proc = all.slice(all.indexOf('CREATE OR ALTER PROCEDURE dbo.TA_usp_GetApprovalTrail'));
  for (const k of ['action', 'actedBy', 'actedByName', 'actedAt', 'details']) assert.match(proc, new RegExp(`AS \\[?${k}\\]?`), `trail key ${k}`);
  assert.match(proc, /N'Created'/); assert.match(proc, /N'Submitted', N'Approved', N'Rejected', N'Copied'/);
  assert.match(proc, /TA_fn_Visible\(@me, @asApprover\)/);
});

test('server-side rules the screens rely on are present in the SQL (not just in the browser)', () => {
  const must: Array<[string, RegExp]> = [
    ['request numbers are generated in the database, concurrency-safe', /UPDATE dbo\.TA_Counter WITH \(UPDLOCK, HOLDLOCK\) SET @n = LastValue = LastValue \+ 1/],
    ['client status/number/approver are never read on save', /status, approver, dates, approved amounts/],
    ['fuel is recomputed server-side', /twoWheelerPerKm/],
    ['a receipt cannot be used twice', /already on another claim/],
    ['approved amount must lie between 0 and the claimed amount', /a\.Amt < 0 OR a\.Amt > l\.Amount/],
    ['reject zeroes undecided lines', /SET ApprovedAmount = 0 WHERE RequestId = @id AND ApprovedAmount IS NULL/],
    ['medical balance', /exceeds the available medical balance/],
    ['advance balance', /available advance balance/],
    ['only drafts are editable', /Only drafts can be edited/],
    ['unreadable and missing look the same', /\[NOT_FOUND\] Record not found/],
    ['sort key is whitelisted', /IF @sortKey NOT IN/],
    ['approvers only on the queue', /Only approvers can view the approval queue/],
    ['optimistic status guard on approve', /AND Status = N'submitted'/],
  ];
  for (const [what, re] of must) assert.match(all, re, what);
});

test('approver rights depend on the VIEW the call acts in (ActAs), never on the browser alone: no procedure calls IsApprover(@me) directly except session and file access', () => {
  assert.match(fn, /CREATE OR ALTER FUNCTION dbo\.TA_fn_ActsAsApprover/);
  assert.match(fn, /dbo\.TA_fn_IsApprover\([\s\S]*?\) = 1\s+AND ISNULL\(LOWER\(JSON_VALUE\(@JsonParam, '\$\.ActAs'\)\), N'approver'\) <> N'employee'/, 'ActAs can only narrow a genuine approver');
  assert.match(fn, /CREATE OR ALTER FUNCTION dbo\.TA_fn_Visible \(@Me NVARCHAR\(30\), @AsApprover BIT\)/);
  const procs = [...all.matchAll(/CREATE OR ALTER PROCEDURE dbo\.(TA_usp_\w+)([\s\S]*?)\nGO/g)];
  const capability = new Set(['TA_usp_GetSession', 'TA_usp_CanViewAttachment', 'TA_usp_Internal_NextNumber', 'TA_usp_GetPolicy', 'TA_usp_GetLocationPolicyLimit', 'TA_usp_GetReferenceData', 'TA_usp_UploadAttachment']);
  for (const [, name, body] of procs) {
    if (capability.has(name!)) continue;
    assert.doesNotMatch(body!, /TA_fn_IsApprover\(@me\)/, `${name}: must use the acting view, not the raw capability`);
    assert.match(body!, /TA_fn_ActsAsApprover\(@JsonParam\)/, `${name}: must derive the view from ActAs`);
    assert.doesNotMatch(body!, /TA_fn_Visible\(@me\)/, `${name}: visibility needs the acting view`);
  }
  const session = all.slice(all.indexOf('CREATE OR ALTER PROCEDURE dbo.TA_usp_GetSession'), all.indexOf('CREATE OR ALTER PROCEDURE dbo.TA_usp_GetPolicy'));
  assert.match(session, /AS isApprover/, 'the session reports the approver CAPABILITY so the app can offer the view switch');
});

test('every code script stamps its revision, and it is the revision this build of the app expects (so a stale database is detected, not guessed)', () => {
  for (const name of SCHEMA_SCRIPTS) {
    assert.ok(read(`${name}.sql`).includes(`(N'${name}', N'${EXPECTED_SCHEMA_REV}')`), `${name}.sql must stamp revision ${EXPECTED_SCHEMA_REV}`);
  }
  const session = all.slice(all.indexOf('CREATE OR ALTER PROCEDURE dbo.TA_usp_GetSession'), all.indexOf('CREATE OR ALTER PROCEDURE dbo.TA_usp_GetPolicy'));
  assert.match(session, /FROM dbo\.TA_SchemaVersion/);
  assert.match(session, /AS \[schema\]/);
});

test('the policy procedure returns the settings and the self-approval rule (item limits are reference data now)', () => {
  const policy = all.slice(all.indexOf('CREATE OR ALTER PROCEDURE dbo.TA_usp_GetPolicy'), all.indexOf('CREATE OR ALTER PROCEDURE dbo.TA_usp_GetReferenceData'));
  assert.doesNotMatch(policy, /itemLimits/);
  assert.match(policy, /"allowSelfApproval"/);
  assert.match(read('02_seed_reference.sql'), /\(N'AllowSelfApproval', N'N', /, 'segregation of duties is the safe default');
});

/**
 * THE OPERATION x VIEW MATRIX. Every procedure is one of three kinds; the SQL must match what the screens assume:
 *   employee-only  : refuses the Approver view  (receipt box, copy a rejected claim)
 *   approver-only  : refuses the Employee view  (approve, reject, queue, history, employee lookup)
 *   both           : scoped by the view through TA_fn_Visible (list/get/save/delete/submit)
 */
test('operation x view matrix: each procedure refuses exactly the view it must refuse', () => {
  const body = (name: string): string => {
    const m = new RegExp(`CREATE OR ALTER PROCEDURE dbo\\.${name}\\b([\\s\\S]*?)\\nGO`).exec(all);
    assert.ok(m, name);
    return m![1]!;
  };
  const employeeOnly = ['TA_usp_ListReceipts', 'TA_usp_CreateReceipts', 'TA_usp_UpdateReceipt', 'TA_usp_DeleteReceipt', 'TA_usp_CopyRejectedClaim'];
  const approverOnly = ['TA_usp_LookupEmployees', 'TA_usp_ApproveRequest', 'TA_usp_RejectRequest', 'TA_usp_ListPendingApprovals', 'TA_usp_ListApprovalHistory'];
  const both = ['TA_usp_ListRequests', 'TA_usp_GetRequest', 'TA_usp_SaveRequestDraft', 'TA_usp_DeleteDraft', 'TA_usp_SubmitRequest', 'TA_usp_GetApprovalTrail'];
  for (const n of employeeOnly) assert.match(body(n), /@asApprover = 1 THROW 50000, N'\[FORBIDDEN\]/, `${n}: must refuse the approver view`);
  for (const n of approverOnly) assert.match(body(n), /@asApprover = 0 THROW 50000, N'\[FORBIDDEN\]/, `${n}: must refuse the employee view`);
  for (const n of both) {
    const b = body(n);
    assert.doesNotMatch(b, /@(asApprover|isApprover) = [01] THROW 50000, N'\[FORBIDDEN\]/, `${n}: works in both views`);
    assert.match(b, /TA_fn_Visible\(@me, @(asApprover|isApprover)\)/, `${n}: scoped by the acting view`);
  }
  assert.equal(employeeOnly.length + approverOnly.length + both.length + 5 /* session, policy, reference data, upload, location policy */, Object.values(SP).length, 'every procedure the app calls is classified');
  // Approving or rejecting one's own request is a separate, configurable rule (segregation of duties).
  for (const n of ['TA_usp_ApproveRequest', 'TA_usp_RejectRequest']) assert.match(body(n), /AllowSelfApproval/, `${n}: self-approval rule`);
});
