import { DEFAULT_POLICY } from '../config/policy';
import { ApiError, type ApiErrorCode } from '../services/apiClient';
import type {
  ApprovalDecision, LocationPolicyLimit, Page, PolicySnapshot, RecordQuery, SessionUser, TravelClaimGateway,
} from '../services/ports';
import { SP as DEFAULT_SP, type ExecSp, type FileApi, type SpErrorPrefix } from '../services/spContract';
import type { AttachmentMeta, Employee, ExpenseClaim, Receipt, RecordKind, ReferenceData, Role, TrailEvent, TravelClaimRecord } from '../types/domain';

const PREFIX_TO_CODE: Record<SpErrorPrefix, ApiErrorCode> = {
  VALIDATION: 'validation', FORBIDDEN: 'forbidden', NOT_FOUND: 'not_found', CONFLICT: 'conflict', UNAUTHORIZED: 'unauthorized',
};
const STATUS: Partial<Record<ApiErrorCode, number>> = { validation: 422, forbidden: 403, not_found: 404, conflict: 409, unauthorized: 401 };

/** Turns an Error thrown by execSp into an ApiError: `[CODE] message` -> that code; anything else -> 'server'. */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const raw = e instanceof Error ? e.message : String(e);
  const m = /^\s*\[([A-Z_]+)\]\s*([\s\S]*)$/.exec(raw);
  const prefix = m?.[1] as SpErrorPrefix | undefined;
  if (prefix && prefix in PREFIX_TO_CODE) {
    const code = PREFIX_TO_CODE[prefix];
    const msg = (m?.[2] ?? '').trim() || raw;
    return new ApiError(code, msg, STATUS[code] ?? null, msg, { summary: [msg] });
  }
  return new ApiError('server', raw || 'The server hit an error. Try again later.', null, raw || null, null);
}

/**
 * Fields the SERVER owns. A draft save never sends them (defence in depth: the SP must also ignore them), so the browser
 * cannot even attempt to set a request number, status, approver or approved amount.
 */
export function toDraftPayload(r: TravelClaimRecord): Record<string, unknown> {
  const { requestNumber: _n, status: _s, submittedOn: _so, approvedOn: _ao, approver: _a, createdAt: _c, updatedAt: _u, ...rest } = r as unknown as Record<string, unknown>;
  void _n; void _s; void _so; void _ao; void _a; void _c; void _u;
  const out: Record<string, unknown> = { ...rest };
  if (r.kind === 'claim') {
    out.items = r.items.map(({ id, itemKey, fields, attachments }) => ({ id, itemKey, fields, attachments }));
    delete out.approverComments; delete out.rejectionReason;
  } else {
    delete out.approverRemarks;
    if (r.kind === 'advance') delete out.settled;
  }
  return out;
}

/**
 * The screens know two roles. The SERVER decides which one a person has (TA_usp_GetSession); the browser only reads it. Accepts the
 * spellings a procedure might plausibly return (any case) or an explicit isApprover/isAdmin flag; everything else is an employee.
 */
export function normalizeRole(raw: { role?: unknown; isApprover?: unknown; isAdmin?: unknown }): 'employee' | 'admin' {
  const flag = (v: unknown): boolean => v === true || v === 1 || String(v).toLowerCase() === 'true' || String(v) === '1';
  if (flag(raw.isApprover) || flag(raw.isAdmin)) return 'admin';
  const r = String(raw.role ?? '').trim().toLowerCase();
  return r === 'admin' || r === 'administrator' || r === 'approver' ? 'admin' : 'employee';
}

const asArray = <T,>(v: unknown, what: string): T[] => { if (!Array.isArray(v)) throw new ApiError('parse', `Unexpected response for ${what}.`, null, null, null); return v as T[]; };
const asObject = <T,>(v: unknown, what: string): T => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ApiError('parse', `Unexpected response for ${what}.`, null, null, null); return v as T; };

/**
 * TravelClaimGateway over stored procedures (execSp) and a multipart file route. Every method is one SP call; all rules are
 * enforced by the SPs (this class does not decide permissions). Errors are normalised to ApiError.
 */
export class SpGateway implements TravelClaimGateway {
  /** `names` replaces the PROPOSED procedure names with the ones whitelisted in the real backend (spWhitelist.js). */
  private readonly SP: Record<keyof typeof DEFAULT_SP, string>;
  private actAs: 'employee' | 'approver' = 'approver';
  constructor(private readonly execSp: ExecSp, private readonly files: FileApi, names: Partial<Record<keyof typeof DEFAULT_SP, string>> = {}) {
    this.SP = { ...DEFAULT_SP, ...names };
  }

  /** 'employee' makes the procedures treat an approver as a plain employee (own requests, receipt box). Sent only in that case. */
  setViewMode(mode: Role): void { this.actAs = mode === 'employee' ? 'employee' : 'approver'; }

  private async call(sp: string, params: Record<string, unknown> = {}): Promise<unknown> {
    try { return await this.execSp(sp, this.actAs === 'employee' ? { ...params, ActAs: 'employee' } : params); } catch (e) { throw toApiError(e); }
  }

  async getSession(): Promise<SessionUser> {
    const o = asObject<Partial<SessionUser> & { isApprover?: unknown; isAdmin?: unknown }>(await this.call(this.SP.getSession), 'session');
    if (!o.code || !o.name) throw new ApiError('parse', 'The session response had no employee code or name.', null, null, null);
    const role = normalizeRole(o);
    return { ...(o as SessionUser), code: String(o.code), role, isApprover: role === 'admin' };
  }

  async getPolicy(): Promise<PolicySnapshot | null> {
    const d = await this.call(this.SP.getPolicy);
    if (d == null) return null; // policy not configured on the server: callers fall back to the documented defaults explicitly
    const o = asObject<{ policy?: Partial<PolicySnapshot['policy']> }>(d, 'policy');
    return { policy: { ...DEFAULT_POLICY, ...(o.policy ?? {}) } };
  }

  async getLocationPolicyLimit(itemKey: string, stayLocation: string): Promise<LocationPolicyLimit | null> {
    const d = await this.call(this.SP.getLocationPolicyLimit, { ItemKey: itemKey, StayLocation: stayLocation });
    if (d == null) return null;
    const o = asObject<{ limit?: unknown; limitPer?: unknown; enforceEligibility?: unknown; EnforceEligibility?: unknown }>(d, 'location policy limit');
    if (o.limit !== null && (typeof o.limit !== 'number' || !Number.isFinite(o.limit) || o.limit < 0)) {
      throw new ApiError('parse', 'The location policy limit was not a valid amount.', null, null, null);
    }
    const limitPer = o.limitPer == null ? null : String(o.limitPer).toLowerCase();
    if (limitPer !== null && !['bill', 'day', 'night'].includes(limitPer)) {
      throw new ApiError('parse', 'The location policy limit had an invalid period.', null, null, null);
    }
    const rawFlag = o.enforceEligibility ?? o.EnforceEligibility;
    const enforceEligibility = rawFlag == null || rawFlag === '' ? undefined : String(rawFlag).trim().toUpperCase();
    if (enforceEligibility !== undefined && enforceEligibility !== 'Y' && enforceEligibility !== 'N') {
      throw new ApiError('parse', 'The location policy limit had an invalid enforce eligibility flag; expected Y or N.', null, null, null);
    }
    return {
      limit: o.limit as number | null,
      limitPer: limitPer as LocationPolicyLimit['limitPer'],
      ...(enforceEligibility ? { enforceEligibility } : {}),
    };
  }

  async getReferenceData(): Promise<ReferenceData> {
    const o = asObject<ReferenceData>(await this.call(this.SP.getReferenceData), 'reference data');
    asArray(o.fields, 'reference fields'); asArray(o.types, 'reference types');
    return { fields: o.fields, types: o.types, lookups: o.lookups ?? {} };
  }
  async getApprovalTrail(kind: RecordKind, id: string): Promise<TrailEvent[]> { return asArray<TrailEvent>(await this.call(this.SP.getApprovalTrail, { Kind: kind, Id: id }), 'approval trail'); }

  async listRecords(q: RecordQuery): Promise<Page<TravelClaimRecord>> {
    const d = await this.call(this.SP.listRequests, {
      Kind: q.kind, EmployeeCode: q.employeeCode, Status: q.status, Search: q.search, From: q.from, To: q.to,
      Page: q.page, PageSize: q.pageSize, SortKey: q.sortKey, SortDir: q.sortDir,
    });
    const o = asObject<{ rows?: unknown; total?: unknown }>(d, 'request list');
    const rows = asArray<TravelClaimRecord>(o.rows ?? [], 'request list');
    return { rows, total: typeof o.total === 'number' ? o.total : rows.length };
  }

  async getRecord(kind: RecordKind, id: string): Promise<TravelClaimRecord> { return asObject<TravelClaimRecord>(await this.call(this.SP.getRequest, { Kind: kind, Id: id }), 'request'); }
  async saveDraft(record: TravelClaimRecord): Promise<TravelClaimRecord> { return asObject<TravelClaimRecord>(await this.call(this.SP.saveRequestDraft, { Kind: record.kind, Request: toDraftPayload(record) }), 'saved request'); }
  async submit(kind: RecordKind, id: string): Promise<TravelClaimRecord> { return asObject<TravelClaimRecord>(await this.call(this.SP.submitRequest, { Kind: kind, Id: id }), 'submitted request'); }
  async deleteDraft(kind: RecordKind, id: string): Promise<void> { await this.call(this.SP.deleteDraft, { Kind: kind, Id: id }); }
  async copyRejectedClaim(id: string): Promise<ExpenseClaim> { return asObject<ExpenseClaim>(await this.call(this.SP.copyRejectedClaim, { Id: id }), 'copied claim'); }

  async approve(kind: RecordKind, id: string, d: ApprovalDecision): Promise<TravelClaimRecord> {
    return asObject<TravelClaimRecord>(await this.call(this.SP.approveRequest, { Kind: kind, Id: id, Lines: d.lines, ApproverComments: d.approverComments, ApproverRemarks: d.approverRemarks }), 'approved request');
  }
  async reject(kind: RecordKind, id: string, d: ApprovalDecision): Promise<TravelClaimRecord> {
    return asObject<TravelClaimRecord>(await this.call(this.SP.rejectRequest, { Kind: kind, Id: id, Lines: d.lines, ApproverComments: d.approverComments, ApproverRemarks: d.approverRemarks, RejectionReason: d.rejectionReason }), 'rejected request');
  }
  async listPendingApprovals(): Promise<TravelClaimRecord[]> { return asArray<TravelClaimRecord>(await this.call(this.SP.listPendingApprovals), 'approval queue'); }
  async listApprovalHistory(days: number): Promise<TravelClaimRecord[]> { return asArray<TravelClaimRecord>(await this.call(this.SP.listApprovalHistory, { Days: days }), 'approval history'); }

  async listReceipts(): Promise<Receipt[]> { return asArray<Receipt>(await this.call(this.SP.listReceipts), 'receipts'); }
  async uploadReceipts(files: File[]): Promise<Receipt[]> {
    // Upload first (multipart), then register the stored files as receipts in one SP call so the batch is all-or-nothing.
    const uploaded = [];
    for (const f of files) { try { uploaded.push(await this.files.upload(f, { kind: 'receipt' })); } catch (e) { throw toApiError(e); } }
    return asArray<Receipt>(await this.call(this.SP.createReceipts, { Files: uploaded.map((u) => ({ FileId: u.fileId, DocType: u.docType, Name: u.name, Size: u.size, Type: u.type })) }), 'created receipts');
  }
  async updateReceipt(r: Receipt): Promise<Receipt> {
    // Only descriptive fields are sent; the file, owner and usage are server-owned.
    return asObject<Receipt>(await this.call(this.SP.updateReceipt, { Receipt: { id: r.id, date: r.date, billerName: r.billerName, billNumber: r.billNumber, amount: r.amount, notes: r.notes } }), 'receipt');
  }
  async deleteReceipt(id: string): Promise<void> { await this.call(this.SP.deleteReceipt, { Id: id }); }

  async uploadAttachment(file: File, target?: { kind?: RecordKind; recordId?: string; lineId?: string }): Promise<AttachmentMeta> {
    try { const u = await this.files.upload(file, target); return { name: u.name, size: u.size, type: u.type, fileId: u.fileId, docType: u.docType }; } catch (e) { throw toApiError(e); }
  }
  async openAttachment(att: AttachmentMeta): Promise<Blob> {
    if (!att.fileId || !att.docType) throw new ApiError('client', 'This attachment has no stored file.', null, null, null);
    try { return await this.files.download({ fileId: att.fileId, docType: att.docType }); } catch (e) { throw toApiError(e); }
  }

  async lookupEmployees(query: string): Promise<Employee[]> { return asArray<Employee>(await this.call(this.SP.lookupEmployees, { Query: query }), 'employees'); }
}
