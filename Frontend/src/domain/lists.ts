import { APPROVALS_OLDEST_WARN_DAYS, ATTENTION_DAYS, HISTORY_DAYS, HISTORY_MAX_ROWS } from '../config/policy';
import { claimApproved, claimTotal, recordAmount, recordApproved } from '../domain/calc';
import { typeByKey } from '../domain/expenseSchema';
import type { RecordKind, RequestStatus, TravelClaimRecord } from '../types/domain';
import { daysAgo, num, today } from '../utils/format';

/**
 * Dashboard, list and approvals-queue logic ported from js/screens/{dashboard,claims,approvals}.js
 * and js/views.js. In production the backend should do filtering/sorting/paging for large data;
 * these functions define the expected semantics (and power client-side behaviour on small pages).
 */

const sum = (rows: readonly TravelClaimRecord[], fn: (r: TravelClaimRecord) => number | null): number =>
  rows.reduce((s, r) => s + num(fn(r)), 0);
const isStatus = (st: RequestStatus) => (r: TravelClaimRecord): boolean => r.status === st;

/* ---- Employee dashboard KPIs (claims only) ------------------------------------------------- */
export interface EmployeeKpis {
  totalClaims: number;
  claimedAmount: number;
  approvedAmount: number;
  approvedCount: number;
  drafts: number;
  rejected: number;
  attention: number;
}

export function employeeKpis(visibleClaims: readonly TravelClaimRecord[]): EmployeeKpis {
  const claims = visibleClaims.filter((r) => r.kind === 'claim');
  const drafts = claims.filter(isStatus('draft'));
  const submittedAll = claims.filter((c) => c.status !== 'draft');
  const approved = claims.filter(isStatus('approved'));
  const rejected = claims.filter(isStatus('rejected'));
  return {
    totalClaims: claims.length,
    claimedAmount: sum(submittedAll, (r) => (r.kind === 'claim' ? claimTotal(r) : 0)),
    approvedAmount: sum(approved, (r) => (r.kind === 'claim' ? claimApproved(r) : 0)),
    approvedCount: approved.length,
    drafts: drafts.length,
    rejected: rejected.length,
    attention: drafts.length + rejected.length,
  };
}

/* ---- Approver dashboard KPIs (all kinds) -------------------------------------------------- */
export interface AdminKpis {
  pendingCount: number;
  pendingByKind: Record<RecordKind, number>;
  pendingAmount: number;
  approvedAmount: number;
  approvedCount: number;
  overdueCount: number;
  oldestDays: number;
}

/** A submitted request waiting more than ATTENTION_DAYS needs attention. */
export const waitingLong = (r: TravelClaimRecord, now: Date): boolean =>
  r.status === 'submitted' && daysAgo(r.submittedOn, now) > ATTENTION_DAYS;

export function adminKpis(visible: readonly TravelClaimRecord[], now: Date = new Date()): AdminKpis {
  const pending = visible.filter(isStatus('submitted'));
  const byKind = (k: RecordKind): number => pending.filter((r) => r.kind === k).length;
  const approved = visible.filter(isStatus('approved'));
  return {
    pendingCount: pending.length,
    pendingByKind: { claim: byKind('claim'), travel: byKind('travel'), advance: byKind('advance') },
    pendingAmount: sum(pending, recordAmount),
    approvedAmount: sum(approved, recordApproved),
    approvedCount: approved.length,
    overdueCount: visible.filter((r) => waitingLong(r, now)).length,
    oldestDays: pending.reduce((m, r) => Math.max(m, daysAgo(r.submittedOn, now)), 0),
  };
}

/* ---- List filtering & sorting ----------------------------------------------------------- */
export interface ListFilters {
  q: string;
  status: RequestStatus | '';
  type: string;
  employee: string;
  from: string;
  to: string;
}

export const emptyFilters = (): ListFilters => ({ q: '', status: '', type: '', employee: '', from: '', to: '' });

/** Search haystack as in claims.js: request no., employee, purpose, remarks, destination, type label. */
function haystack(r: TravelClaimRecord): string {
  const typeLabel = r.kind === 'claim' ? typeByKey(r.expenseType)?.label : undefined;
  const remarks = r.kind === 'travel' || r.kind === 'advance' ? r.remarks : undefined;
  const to = r.kind === 'travel' ? r.toLocation : undefined;
  return [r.requestNumber, r.employeeName, r.employeeCode, r.kind === 'claim' || r.kind === 'travel' || r.kind === 'advance' ? r.purpose : '', remarks, to, typeLabel]
    .join(' ').toLowerCase();
}

export function matchesNonStatus(r: TravelClaimRecord, f: ListFilters, isAdmin: boolean): boolean {
  const q = f.q.trim().toLowerCase();
  if (q && !haystack(r).includes(q)) return false;
  if (r.kind === 'claim' && f.type && r.expenseType !== f.type) return false;
  if (isAdmin && f.employee && r.employeeCode !== f.employee) return false;
  if (f.from && String(r.requestDate) < f.from) return false;
  if (f.to && String(r.requestDate) > f.to) return false;
  return true;
}

export interface Sort { key: string; dir: 'asc' | 'desc' }
const STATUS_ORDER: RequestStatus[] = ['draft', 'submitted', 'approved', 'rejected'];

function sortValue(r: TravelClaimRecord, key: string): number | string {
  switch (key) {
    case 'total': return recordAmount(r);
    case 'approved': { const a = recordApproved(r); return a == null ? -1 : a; }
    case 'expenseType': return r.kind === 'claim' ? (typeByKey(r.expenseType)?.short ?? '') : '';
    case 'status': return STATUS_ORDER.indexOf(r.status);
    default: { const v = (r as unknown as Record<string, unknown>)[key]; return v == null ? '' : (v as number | string); }
  }
}

export function sortRows<T extends TravelClaimRecord>(rows: readonly T[], sort: Sort | null | undefined): T[] {
  if (!sort || !sort.key) return rows.slice();
  const dir = sort.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const va = sortValue(a, sort.key);
    const vb = sortValue(b, sort.key);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
}

/** First click on a column sorts ascending, except date/amount columns which start descending. */
export const defaultSortDir = (key: string): 'asc' | 'desc' =>
  key === 'requestDate' || key === 'submittedOn' || key === 'approvedOn' || key === 'total' ? 'desc' : 'asc';

export interface PageResult<T> { rows: T[]; total: number; page: number; pages: number; start: number; end: number }

export function paginate<T>(rows: readonly T[], page: number, pageSize: number): PageResult<T> {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((p - 1) * pageSize, p * pageSize), total, page: p, pages, start: total ? (p - 1) * pageSize + 1 : 0, end: Math.min(total, p * pageSize) };
}

/* ---- Approvals queue ------------------------------------------------------------------- */
export interface ApprovalsView {
  pending: TravelClaimRecord[];
  byKind: Record<RecordKind, TravelClaimRecord[]>;
  amounts: Record<RecordKind, number>;
  pendingAmount: number;
  oldestDays: number;
  oldestRequestNumber: string | null;
  oldestWarn: boolean;
  history: TravelClaimRecord[];
}

export function approvalsView(visible: readonly TravelClaimRecord[], now: Date = new Date()): ApprovalsView {
  const pending = visible.filter(isStatus('submitted')).sort((a, b) => String(a.submittedOn).localeCompare(String(b.submittedOn)));
  const byKind: Record<RecordKind, TravelClaimRecord[]> = { claim: [], travel: [], advance: [] };
  for (const r of pending) byKind[r.kind].push(r);
  const total = (rows: readonly TravelClaimRecord[]): number => rows.reduce((s, r) => s + recordAmount(r), 0);
  const cutoff = new Date(now.getTime());
  cutoff.setDate(cutoff.getDate() - HISTORY_DAYS);
  const cutoffIso = today(cutoff);
  const history = visible
    .filter((r) => (r.status === 'approved' || r.status === 'rejected') && String(r.approvedOn) >= cutoffIso)
    .sort((a, b) => String(b.approvedOn).localeCompare(String(a.approvedOn)) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, HISTORY_MAX_ROWS);
  const oldest = pending[0];
  const oldestDays = oldest ? daysAgo(oldest.submittedOn, now) : 0;
  return {
    pending, byKind,
    amounts: { claim: total(byKind.claim), travel: total(byKind.travel), advance: total(byKind.advance) },
    pendingAmount: total(pending),
    oldestDays,
    oldestRequestNumber: oldest?.requestNumber ?? null,
    oldestWarn: oldestDays > APPROVALS_OLDEST_WARN_DAYS,
    history,
  };
}
