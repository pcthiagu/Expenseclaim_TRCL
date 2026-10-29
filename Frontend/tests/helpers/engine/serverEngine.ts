import { DEFAULT_POLICY, HISTORY_DAYS } from '@/config/policy';
import { applyFuel } from '@/domain/calc';
import { itemByKey } from '@/domain/expenseSchema';
import {
  emptyFilters, matchesNonStatus, paginate, sortRows, approvalsView,
} from '@/domain/lists';
import { linkReceipts } from '@/domain/receipts';
import {
  validateAdvance, validateApproval, validateClaimHeader, validateLine, validateTravel,
  zeroUndecidedOnReject, type ValidationResult,
} from '@/domain/validation';
import { canApprove, canDelete, canEdit, canView, copyClaimToDraft, nextStatus } from '@/domain/workflow';
import { checkAttachment, ApiError, type ApiErrorCode } from '@/services/apiClient';
import type {
  ApprovalDecision, LocationPolicyLimit, Page, PolicySnapshot, RecordQuery, SessionUser, TravelClaimGateway,
} from '@/services/ports';
import type {
  Actor, AdvanceRequest, AttachmentMeta, ClaimLine, Employee, ExpenseClaim, Receipt, RecordKind, ReferenceData,
  TrailEvent, TravelClaimRecord, TravelRequest,
} from '@/types/domain';
import { nowIso, today } from '@/utils/format';
import { buildReferenceData } from '../referenceData';
import { SEED_EMPLOYEES, SEED_RECEIPTS, SEED_RECORDS, SEED_USERS } from './engineSeed';

/**
 * TEST-ONLY. Not part of the application: it is the business logic behind the fake backend (tests/helpers/fakeBackend.ts) that the browser tests talk to.
 *
 * An in-memory stand-in for the stored procedures: state lives in this object and is lost on reload; nothing is
 * written to localStorage and no file bytes are kept. It deliberately behaves like a SERVER, not like the
 * prototype's store, so the UI is built against server semantics from day one:
 *  - the caller's identity comes from the gateway's session, never from fields in the payload;
 *  - requestNumber, status, approver and approved amounts are assigned/validated here, and client
 *    values for them are ignored on save;
 *  - ownership, state transitions, balances and receipt ownership are enforced and rejected with the
 *    same ApiError codes a real backend client would surface (forbidden, not_found, validation, conflict).
 * It is NOT proof that the real backend behaves this way.
 */

export interface ServerEngineOptions {
  /** Which seed user is signed in (the fake backend calls setSession() per request). */
  as?: 'employee' | 'admin';
  now?: () => Date;
  newId?: () => string;
  /** Artificial latency in ms (0 in tests). */
  latencyMs?: number;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function fail(code: ApiErrorCode, message: string, details: unknown = null): never {
  const status = { forbidden: 403, not_found: 404, validation: 422, conflict: 409, unauthorized: 401 }[code as 'forbidden'] ?? 400;
  throw new ApiError(code, message, status, message, details);
}

function validationFail(r: ValidationResult | { summary: string[]; errors?: Record<string, string>; lineErrors?: Record<string, string> }): never {
  const errors = 'errors' in r && r.errors ? r.errors : 'lineErrors' in r ? r.lineErrors : {};
  return fail('validation', r.summary[0] ?? 'Validation failed', { errors, summary: r.summary });
}

export class ServerEngine implements TravelClaimGateway {
  private records: TravelClaimRecord[] = clone(SEED_RECORDS);
  private receipts: Receipt[] = clone(SEED_RECEIPTS);
  private actor: Actor;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly latencyMs: number;
  private counter = 0;

  constructor(o: ServerEngineOptions = {}) {
    this.now = o.now ?? (() => new Date());
    this.newId = o.newId ?? (() => `seed-${Date.now().toString(36)}-${(this.counter++).toString(36)}`);
    this.latencyMs = o.latencyMs ?? 0;
    this.actor = this.actorFor(o.as ?? 'employee');
  }

  /* ---- test-only controls (not part of TravelClaimGateway) ------------------------------ */
  setSession(as: 'employee' | 'admin'): void { this.actor = this.actorFor(as); }
  reset(): void { this.records = clone(SEED_RECORDS); this.receipts = clone(SEED_RECEIPTS); }

  private actorFor(as: 'employee' | 'admin'): Actor {
    const u = SEED_USERS[as];
    return { role: u.role, code: u.code, name: u.name };
  }
  private async tick(): Promise<void> { if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs)); }
  private employeeExists = (code: string): boolean => SEED_EMPLOYEES.some((e) => e.code === String(code).trim());
  private employee(code: string): Employee | undefined { return SEED_EMPLOYEES.find((e) => e.code === String(code).trim()); }
  private isAdmin(): boolean { return this.actor.role === 'admin'; }

  private find(kind: RecordKind, id: string): TravelClaimRecord {
    const r = this.records.find((x) => x.id === id && x.kind === kind);
    // Unreadable and missing look the same, so existence of other people's records is not disclosed.
    if (!r || !canView(r, this.actor)) fail('not_found', 'Record not found');
    return r;
  }

  private nextNumber(kind: RecordKind, employeeCode: string): string {
    const year = this.now().getFullYear();
    const prefix = kind === 'claim' ? `${employeeCode}/${year}/` : `${kind === 'travel' ? 'TR' : 'AR'}/${year}/`;
    // Scans ALL records (not only the caller's visible ones): unique across users.
    let max = 0;
    for (const r of this.records) {
      if (r.requestNumber.startsWith(prefix)) max = Math.max(max, parseInt(r.requestNumber.slice(prefix.length), 10) || 0);
    }
    return prefix + String(max + 1).padStart(4, '0');
  }

  /* ---- session / policy ----------------------------------------------------------------- */
  async getSession(): Promise<SessionUser> {
    await this.tick();
    const u = SEED_USERS[this.actor.role];
    return { code: u.code, name: u.name, role: u.role, designation: u.designation, department: u.department, costCentre: u.costCentre };
  }

  async getPolicy(): Promise<PolicySnapshot | null> {
    await this.tick();
    return { policy: DEFAULT_POLICY };
  }

  async getLocationPolicyLimit(itemKey: string, stayLocation: string): Promise<LocationPolicyLimit | null> {
    await this.tick();
    if (!stayLocation) return null;
    const item = itemByKey('outside', itemKey);
    return item ? { limit: item.limit ?? null, limitPer: item.limitPer ?? null } : null;
  }

  /** What TA_usp_GetReferenceData returns: built from the SQL seed, so the engine runs on the data the database will hold. */
  async getReferenceData(): Promise<ReferenceData> {
    await this.tick();
    return buildReferenceData([...new Set([...SEED_EMPLOYEES.map((e) => e.costCentre), SEED_USERS.admin.costCentre])]);
  }

  /** Created, Submitted and the decision with its text: derived from the record, as the procedure derives them from the request and its history. */
  async getApprovalTrail(kind: RecordKind, id: string): Promise<TrailEvent[]> {
    await this.tick();
    const r = this.find(kind, id);
    const ev: TrailEvent[] = [{ action: 'Created', actedBy: r.createdBy ?? r.employeeCode, actedByName: r.employeeName, actedAt: r.createdAt ?? `${r.requestDate}T00:00:00`, details: null }];
    if (r.status !== 'draft' && r.submittedOn) ev.push({ action: 'Submitted', actedBy: r.employeeCode, actedByName: r.employeeName, actedAt: `${r.submittedOn}T00:00:00`, details: null });
    if ((r.status === 'approved' || r.status === 'rejected') && r.approvedOn) {
      const text = r.kind === 'claim' ? (r.status === 'rejected' ? r.rejectionReason : r.approverComments) : r.approverRemarks;
      ev.push({ action: r.status === 'approved' ? 'Approved' : 'Rejected', actedBy: SEED_USERS.admin.code, actedByName: r.approver ?? null, actedAt: `${r.approvedOn}T00:00:00`, details: text ? text : null });
    }
    return clone(ev);
  }

  /* ---- records -------------------------------------------------------------------------- */
  async listRecords(q: RecordQuery): Promise<Page<TravelClaimRecord>> {
    await this.tick();
    let rows = this.records.filter((r) => (!q.kind || r.kind === q.kind) && canView(r, this.actor));
    const f = { ...emptyFilters(), q: q.search ?? '', from: q.from ?? '', to: q.to ?? '' };
    // The employee filter is honoured for approvers only; employees only ever see their own rows anyway.
    if (this.isAdmin() && q.employeeCode) f.employee = q.employeeCode;
    rows = rows.filter((r) => matchesNonStatus(r, f, this.isAdmin()));
    if (q.status) rows = rows.filter((r) => r.status === q.status);
    rows = sortRows(rows, q.sortKey ? { key: q.sortKey, dir: q.sortDir ?? 'asc' } : { key: 'requestDate', dir: 'desc' });
    const total = rows.length;
    if (q.page && q.pageSize) rows = paginate(rows, q.page, q.pageSize).rows;
    await this.tick();
    return { rows: clone(rows), total };
  }

  async getRecord(kind: RecordKind, id: string): Promise<TravelClaimRecord> {
    await this.tick();
    return clone(this.find(kind, id));
  }

  async saveDraft(input: TravelClaimRecord): Promise<TravelClaimRecord> {
    await this.tick();
    const existing = this.records.find((x) => x.id === input.id);
    if (existing) {
      if (existing.kind !== input.kind) fail('validation', 'Record kind cannot change');
      if (!canView(existing, this.actor)) fail('not_found', 'Record not found');
      if (existing.status !== 'draft') fail('conflict', 'Only drafts can be edited');
      if (!canEdit(existing, this.actor)) fail('forbidden', 'You cannot edit this record');
    }
    // Ownership: an employee always saves for themself; only an approver may name another employee.
    const requested = String(input.employeeCode ?? '').trim();
    const employeeCode = this.isAdmin() ? (existing?.employeeCode ?? requested) : this.actor.code;
    if (this.isAdmin() && existing && requested && requested !== existing.employeeCode) fail('validation', 'Employee cannot be changed on a saved draft');
    if (!this.employeeExists(employeeCode)) fail('validation', 'Enter a valid employee code', { errors: { employeeCode: 'Enter a valid employee code' } });
    const emp = this.employee(employeeCode) as Employee;
    const now = this.now();
    const ts = nowIso(now);

    const base = {
      id: input.id || this.newId(),
      kind: input.kind,
      // Server-owned fields: kept from the stored record, never taken from the client.
      requestNumber: existing?.requestNumber ?? '',
      status: 'draft' as const,
      submittedOn: existing?.submittedOn ?? null,
      approvedOn: null,
      approver: null,
      createdBy: existing?.createdBy ?? this.actor.code,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
      employeeCode,
      employeeName: emp.name,
      costCentre: input.costCentre || emp.costCentre,
      requestDate: input.requestDate || today(now),
    };

    let next: TravelClaimRecord;
    if (input.kind === 'claim') {
      const c = input as ExpenseClaim;
      const prev = existing as ExpenseClaim | undefined;
      const items: ClaimLine[] = (c.items ?? []).map((it) => {
        const def = itemByKey(c.expenseType, it.itemKey);
        const fields = def?.compute === 'fuelKm' ? applyFuel(def, it.fields) : { ...it.fields };
        // Approver-only values are never accepted from a draft save.
        return { id: it.id, itemKey: it.itemKey, fields, attachments: clone(it.attachments ?? []), approvedAmount: null, approverRemarks: '' };
      });
      next = {
        ...base, kind: 'claim', expenseType: c.expenseType, purpose: c.purpose ?? '',
        ...(c.travelFrom !== undefined ? { travelFrom: c.travelFrom } : {}), ...(c.travelTo !== undefined ? { travelTo: c.travelTo } : {}),
        items, employeeComments: c.employeeComments ?? '', approverComments: prev?.approverComments ?? '', rejectionReason: prev?.rejectionReason ?? '',
      };
      this.assertReceiptsUsable(next as ExpenseClaim);
    } else if (input.kind === 'travel') {
      const t = input as TravelRequest;
      next = {
        ...base, kind: 'travel', purpose: t.purpose ?? '', remarks: t.remarks ?? '', fromLocation: t.fromLocation ?? '', toLocation: t.toLocation ?? '',
        periodFrom: t.periodFrom ?? '', periodTo: t.periodTo ?? '', items: clone(t.items ?? []), advanceRequired: t.advanceRequired ?? '',
        overallRemarks: t.overallRemarks ?? '', approverRemarks: (existing as TravelRequest | undefined)?.approverRemarks ?? '',
        alongWith: t.alongWith ?? '', attachments: clone(t.attachments ?? []), createLeave: !!t.createLeave,
      };
    } else {
      const a = input as AdvanceRequest;
      next = {
        ...base, kind: 'advance', periodFrom: a.periodFrom ?? '', periodTo: a.periodTo ?? '', amount: a.amount ?? '', purpose: a.purpose ?? '',
        remarks: a.remarks ?? '', alongWith: a.alongWith ?? '', attachments: clone(a.attachments ?? []), createLeave: !!a.createLeave,
        travelRequest: a.travelRequest ?? '', settled: (existing as AdvanceRequest | undefined)?.settled ?? false,
        approverRemarks: (existing as AdvanceRequest | undefined)?.approverRemarks ?? '',
      };
    }

    // A draft only needs a valid employee and request date (same as the prototype's Save Draft).
    const draftCheck = this.validate(next, false);
    if (!draftCheck.ok) validationFail(draftCheck);

    if (!next.requestNumber) next.requestNumber = this.nextNumber(next.kind, employeeCode);
    const idx = this.records.findIndex((x) => x.id === next.id);
    if (idx >= 0) this.records[idx] = next; else this.records.unshift(next);
    if (next.kind === 'claim') this.receipts = linkReceipts(this.receipts, next.id, next.requestNumber, next.items);
    return clone(next);
  }

  /** A claim may only reference receipts that belong to its employee and are not on another claim. */
  private assertReceiptsUsable(c: ExpenseClaim): void {
    const seen = new Set<string>();
    for (const it of c.items) {
      for (const a of it.attachments) {
        if (!a.receiptId) continue;
        const r = this.receipts.find((x) => x.id === a.receiptId);
        if (!r || r.employeeCode !== c.employeeCode) fail('validation', 'A selected bill is not in your receipt box');
        if (r.usedIn && r.usedIn.claimId !== c.id) fail('conflict', `Bill ${r.file.name} is already on another claim`);
        if (seen.has(r.id)) fail('conflict', `Bill ${r.file.name} is attached to more than one line`);
        seen.add(r.id);
      }
    }
  }

  private validate(r: TravelClaimRecord, forSubmit: boolean): ValidationResult {
    const ctx = { employeeExists: this.employeeExists, records: this.records.filter((x) => x.id !== r.id), now: this.now() };
    if (r.kind === 'claim') {
      const header = validateClaimHeader(r, forSubmit, ctx);
      if (!forSubmit) return header;
      const errors = { ...header.errors };
      const summary = [...header.summary];
      r.items.forEach((it, i) => {
        const lv = validateLine(it, r.expenseType, { now: this.now() });
        if (!lv.ok) { errors[`items.${i}`] = lv.summary.join('; '); summary.push(`Line ${i + 1}: ${lv.summary.join('; ')}`); }
      });
      return { errors, summary, ok: summary.length === 0 };
    }
    return r.kind === 'travel' ? validateTravel(r, forSubmit, ctx) : validateAdvance(r, forSubmit, ctx);
  }

  async submit(kind: RecordKind, id: string): Promise<TravelClaimRecord> {
    await this.tick();
    const r = this.find(kind, id);
    if (!canEdit(r, this.actor)) fail(r.status === 'draft' ? 'forbidden' : 'conflict', r.status === 'draft' ? 'You cannot submit this record' : 'Only drafts can be submitted');
    const to = nextStatus(r.status, 'submit');
    if (!to) fail('conflict', 'Only drafts can be submitted');
    const check = this.validate(r, true);
    if (!check.ok) validationFail(check);
    r.status = to;
    r.submittedOn = today(this.now());
    r.updatedAt = nowIso(this.now());
    return clone(r);
  }

  async deleteDraft(kind: RecordKind, id: string): Promise<void> {
    await this.tick();
    const r = this.find(kind, id);
    if (r.status !== 'draft') fail('conflict', 'Only drafts can be deleted');
    if (!canDelete(r, this.actor)) fail('forbidden', 'You cannot delete this record');
    this.records = this.records.filter((x) => x.id !== id);
    if (kind === 'claim') this.receipts = linkReceipts(this.receipts, id, null, []); // free its bills
  }

  async copyRejectedClaim(id: string): Promise<ExpenseClaim> {
    await this.tick();
    const r = this.find('claim', id) as ExpenseClaim;
    if (this.actor.role !== 'employee' || r.status !== 'rejected' || r.employeeCode !== this.actor.code) fail('forbidden', 'Only the owner can copy a rejected claim');
    const copy = copyClaimToDraft(r, this.actor, this.newId, this.now());
    copy.requestNumber = this.nextNumber('claim', copy.employeeCode);
    // A copied line must not drag along bills that are still attached to the original claim.
    copy.items = copy.items.map((it) => ({
      ...it,
      attachments: it.attachments.filter((a) => {
        if (!a.receiptId) return true;
        const rc = this.receipts.find((x) => x.id === a.receiptId);
        return !!rc && !rc.usedIn;
      }),
    }));
    this.records.unshift(copy);
    this.receipts = linkReceipts(this.receipts, copy.id, copy.requestNumber, copy.items);
    return clone(copy);
  }

  /* ---- approvals ------------------------------------------------------------------------ */
  private requireApprover(r: TravelClaimRecord): void {
    if (!this.isAdmin()) fail('forbidden', 'Only approvers can approve or reject');
    if (!canApprove(r, this.actor)) fail('conflict', 'Only submitted requests can be actioned');
  }

  async approve(kind: RecordKind, id: string, d: ApprovalDecision): Promise<TravelClaimRecord> {
    await this.tick();
    const r = this.find(kind, id);
    this.requireApprover(r);
    if (r.kind === 'claim') {
      const byId = new Map((d.lines ?? []).map((l) => [l.id, l] as const));
      const lines = r.items.map((it) => {
        const l = byId.get(it.id);
        return { ...it, approvedAmount: l ? l.approvedAmount : null, approverRemarks: l?.approverRemarks ?? '' };
      });
      const check = validateApproval(lines); // 0 <= approved <= claimed, enforced here, not trusted from the browser
      if (!check.ok) validationFail(check);
      r.items = lines;
      r.approverComments = d.approverComments ?? '';
      r.rejectionReason = '';
    } else {
      r.approverRemarks = d.approverRemarks ?? '';
    }
    r.status = nextStatus(r.status, 'approve') as 'approved';
    r.approvedOn = today(this.now());
    r.approver = this.actor.name;
    r.updatedAt = nowIso(this.now());
    return clone(r);
  }

  async reject(kind: RecordKind, id: string, d: ApprovalDecision): Promise<TravelClaimRecord> {
    await this.tick();
    const r = this.find(kind, id);
    this.requireApprover(r);
    const reason = (r.kind === 'claim' ? d.rejectionReason : d.approverRemarks) ?? '';
    if (!reason.trim()) fail('validation', r.kind === 'claim' ? 'Rejection Reason: required when rejecting' : 'Approver Remarks: required when rejecting');
    if (r.kind === 'claim') {
      const byId = new Map((d.lines ?? []).map((l) => [l.id, l] as const));
      r.items = zeroUndecidedOnReject(r.items.map((it) => {
        const l = byId.get(it.id);
        return l ? { ...it, approvedAmount: l.approvedAmount, approverRemarks: l.approverRemarks } : it;
      }));
      r.approverComments = d.approverComments ?? r.approverComments;
      r.rejectionReason = reason;
    } else {
      r.approverRemarks = reason;
    }
    r.status = nextStatus(r.status, 'reject') as 'rejected';
    r.approvedOn = today(this.now());
    r.approver = this.actor.name;
    r.updatedAt = nowIso(this.now());
    return clone(r);
  }

  async listPendingApprovals(): Promise<TravelClaimRecord[]> {
    await this.tick();
    if (!this.isAdmin()) fail('forbidden', 'Only approvers can view the approval queue');
    return clone(approvalsView(this.records.filter((r) => canView(r, this.actor)), this.now()).pending);
  }

  async listApprovalHistory(days: number): Promise<TravelClaimRecord[]> {
    await this.tick();
    if (!this.isAdmin()) fail('forbidden', 'Only approvers can view approval history');
    const view = approvalsView(this.records.filter((r) => canView(r, this.actor)), this.now());
    // approvalsView applies the standard 30-day window; narrow further when a smaller window is asked for.
    const cutoff = new Date(this.now().getTime());
    cutoff.setDate(cutoff.getDate() - Math.min(days, HISTORY_DAYS));
    const iso = today(cutoff);
    return clone(view.history.filter((r) => String(r.approvedOn) >= iso));
  }

  /* ---- receipt box ----------------------------------------------------------------------- */
  private requireEmployee(): void { if (this.isAdmin()) fail('forbidden', 'The receipt box is not available to approvers'); }
  private mine(id: string): Receipt {
    const r = this.receipts.find((x) => x.id === id && x.employeeCode === this.actor.code);
    if (!r) fail('not_found', 'Bill not found');
    return r;
  }

  async listReceipts(): Promise<Receipt[]> {
    await this.tick();
    this.requireEmployee();
    return clone(this.receipts.filter((r) => r.employeeCode === this.actor.code).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt))));
  }

  async uploadReceipts(files: File[]): Promise<Receipt[]> {
    await this.tick();
    this.requireEmployee();
    const errors = files.map((f) => checkAttachment(f, DEFAULT_POLICY)).filter((e): e is string => !!e);
    if (errors.length) fail('validation', errors[0] as string, { errors });
    const ts = nowIso(this.now());
    const created: Receipt[] = files.map((f) => ({
      id: this.newId(), employeeCode: this.actor.code, file: { name: f.name, size: f.size, type: f.type },
      uploadedAt: ts, date: '', billerName: '', billNumber: '', amount: '', notes: '', usedIn: null,
    }));
    this.receipts = [...created, ...this.receipts];
    return clone(created);
  }

  async updateReceipt(input: Receipt): Promise<Receipt> {
    await this.tick();
    this.requireEmployee();
    const cur = this.mine(input.id);
    if (cur.usedIn) fail('conflict', 'A bill on a claim cannot be edited');
    // Only the descriptive fields are editable; file, owner and usage are server-owned.
    const next: Receipt = { ...cur, date: input.date ?? '', billerName: input.billerName ?? '', billNumber: input.billNumber ?? '', amount: input.amount ?? '', notes: input.notes ?? '' };
    if (next.date && next.date > today(this.now())) fail('validation', 'Bill date cannot be in the future');
    this.receipts = this.receipts.map((r) => (r.id === next.id ? next : r));
    return clone(next);
  }

  async deleteReceipt(id: string): Promise<void> {
    await this.tick();
    this.requireEmployee();
    const cur = this.mine(id);
    if (cur.usedIn) fail('conflict', 'A bill on a claim cannot be deleted');
    this.receipts = this.receipts.filter((r) => r.id !== id);
  }

  /* ---- attachments / lookups -------------------------------------------------------------- */
  async uploadAttachment(file: File, target?: { kind?: RecordKind; recordId?: string; lineId?: string }): Promise<AttachmentMeta> {
    await this.tick();
    const err = checkAttachment(file, DEFAULT_POLICY);
    if (err) fail('validation', err);
    // A file may be uploaded before its request is first saved; when the request already exists the caller must be allowed to edit it.
    const existing = target?.recordId && target.kind ? this.records.find((x) => x.id === target.recordId && x.kind === target.kind) : undefined;
    if (existing && (!canView(existing, this.actor) || !canEdit(existing, this.actor))) fail('forbidden', 'You cannot attach files to this record');
    return { name: file.name, size: file.size, type: file.type };
  }

  async openAttachment(_att: AttachmentMeta): Promise<Blob> {
    await this.tick();
    // The engine keeps metadata only. Say so instead of faking a file.
    throw new ApiError('client', 'Demo mode stores file details only, not file contents.', 501, null, null);
  }

  async lookupEmployees(query: string): Promise<Employee[]> {
    await this.tick();
    if (!this.isAdmin()) fail('forbidden', 'Employee lookup is available to approvers only');
    const q = query.toLowerCase();
    return clone(SEED_EMPLOYEES.filter((e) => `${e.code} ${e.name} ${e.department}`.toLowerCase().includes(q)));
  }
}
