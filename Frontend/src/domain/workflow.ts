import { STATUSES } from '../domain/expenseSchema';
import type { Actor, ExpenseClaim, RequestStatus, Role, TravelClaimRecord } from '../types/domain';
import { nowIso, today } from '../utils/format';

/**
 * SECURITY NOTE: everything in this file is a UI HINT used to show/hide controls. The prototype
 * derived the role from a browser-side selector. In production the actor (role, employee code) must
 * come from the authenticated session on the backend, and EVERY rule below must also be enforced
 * server-side. Never trust a role, employee code or approved amount sent from the browser.
 */

/** Ported from store.js TC.store.canView. */
export function canView(r: TravelClaimRecord | null | undefined, actor: Actor): boolean {
  if (!r) return false;
  if (actor.role === 'admin') return r.status !== 'draft' || r.createdBy === actor.code;
  return r.employeeCode === actor.code;
}

/** Ported from TC.perm.canEdit: drafts only; an admin may edit drafts (which canView limits to ones they created). */
export function canEdit(r: TravelClaimRecord | null | undefined, actor: Actor): boolean {
  if (!r || r.status !== 'draft') return false;
  if (actor.role === 'admin') return true;
  return r.employeeCode === actor.code;
}

/** Approver view, submitted request; and (when the policy forbids it) not one raised for the approver themself. The server enforces the same rules. */
export const canApprove = (r: TravelClaimRecord | null | undefined, actor: Actor, opts: { allowSelfApproval?: boolean } = {}): boolean =>
  !!r && actor.role === 'admin' && r.status === 'submitted' && !(opts.allowSelfApproval === false && r.employeeCode === actor.code);

/** Delete needs an editable draft that has been saved at least once (has a request number). */
export const canDelete = (r: TravelClaimRecord | null | undefined, actor: Actor): boolean =>
  canEdit(r, actor) && !!r?.requestNumber;

/** Rejected claims can be copied into a new draft by their own employee (employee role only). */
export const canCopy = (r: TravelClaimRecord | null | undefined, actor: Actor): boolean =>
  !!r && actor.role === 'employee' && r.kind === 'claim' && r.status === 'rejected' && r.employeeCode === actor.code;

/** An approver reads a submitted request as "Pending Approval". */
export function statusLabel(key: RequestStatus, role: Role): string {
  if (key === 'submitted' && role === 'admin') return 'Pending Approval';
  return STATUSES[key]?.label ?? String(key);
}

/* ---- Status flow: Draft -> Submitted -> Approved | Rejected ------------------------------ */

export type WorkflowAction = 'submit' | 'approve' | 'reject';

const TRANSITIONS: Record<WorkflowAction, { from: RequestStatus; to: RequestStatus }> = {
  submit: { from: 'draft', to: 'submitted' },
  approve: { from: 'submitted', to: 'approved' },
  reject: { from: 'submitted', to: 'rejected' },
};

export function nextStatus(current: RequestStatus, action: WorkflowAction): RequestStatus | null {
  const t = TRANSITIONS[action];
  return t.from === current ? t.to : null;
}

export function canTransition(current: RequestStatus, action: WorkflowAction): boolean {
  return nextStatus(current, action) !== null;
}

/**
 * Copy a (rejected) claim into a new draft. Mirrors claimForm.js copyToDraft except that the
 * request number is left blank: the backend assigns it on first save (the prototype generated it
 * client-side, which cannot be concurrency-safe).
 */
export function copyClaimToDraft(
  claim: ExpenseClaim, actor: Actor, newId: () => string, now: Date = new Date(),
): ExpenseClaim {
  const copy: ExpenseClaim = JSON.parse(JSON.stringify(claim)) as ExpenseClaim;
  copy.id = newId();
  copy.status = 'draft';
  copy.requestDate = today(now);
  copy.submittedOn = null;
  copy.approvedOn = null;
  copy.approver = null;
  copy.approverComments = '';
  copy.rejectionReason = '';
  copy.requestNumber = '';
  copy.items = copy.items.map((it) => ({ ...it, id: newId(), approvedAmount: null, approverRemarks: '' }));
  copy.createdBy = actor.code;
  copy.createdAt = nowIso(now);
  copy.updatedAt = nowIso(now);
  return copy;
}
