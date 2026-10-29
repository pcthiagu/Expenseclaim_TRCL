import type { AttachmentMeta, ClaimLine, ExpenseItemDef, LineFields, Receipt } from '../types/domain';
import { num } from '../utils/format';

/**
 * Receipt-box rules ported from js/store.js (linkReceipts) and js/screens/claimForm.js.
 * These are CLIENT-SIDE hints. Whether a receipt is "used" and by which claim must be decided by the
 * backend; the frontend must not be able to link a receipt to a claim that is not the caller's, and
 * the backend must prevent duplicate linking (same receipt on two lines/claims).
 */

/** Attachment metadata that points at a receipt-box bill. */
export const attachmentFromReceipt = (r: Receipt): AttachmentMeta => ({
  name: r.file.name, size: r.file.size, type: r.file.type, receiptId: r.id,
  // Keep the stored-file reference (when the server gave one) so the bill can be opened from the claim line too.
  ...(r.file.fileId ? { fileId: r.file.fileId } : {}), ...(r.file.docType ? { docType: r.file.docType } : {}),
});

/**
 * Marks the receipts a claim's lines use as used by that claim and frees any it no longer uses.
 * Pass no lines to free them all (draft deleted). Receipts used by OTHER claims are never touched.
 */
export function linkReceipts(
  receipts: readonly Receipt[], claimId: string, requestNumber: string | null, lines: readonly ClaimLine[] = [],
): Receipt[] {
  const used: Record<string, string> = {};
  for (const it of lines) for (const a of it.attachments ?? []) if (a.receiptId) used[a.receiptId] = it.id;
  return receipts.map((r) => {
    const lineId = used[r.id];
    if (lineId) return { ...r, usedIn: { claimId, requestNumber, lineId } };
    if (r.usedIn && r.usedIn.claimId === claimId) return { ...r, usedIn: null };
    return r;
  });
}

/** Receipt ids attached to lines of the form, optionally excluding one line. */
export function receiptIdsInForm(items: readonly ClaimLine[], exceptLineId: string | null): Record<string, true> {
  const ids: Record<string, true> = {};
  for (const it of items) {
    if (it.id === exceptLineId) continue;
    for (const a of it.attachments ?? []) if (a.receiptId) ids[a.receiptId] = true;
  }
  return ids;
}

/** Bills from the receipt box still waiting to be added to this (new) claim. */
export function pendingReceipts(
  pendingIds: readonly string[], all: readonly Receipt[], items: readonly ClaimLine[], claimId: string,
): Receipt[] {
  const inForm = receiptIdsInForm(items, null);
  const byId = new Map(all.map((r) => [r.id, r] as const));
  return pendingIds
    .map((id) => byId.get(id))
    .filter((r): r is Receipt => !!r && !inForm[r.id] && (!r.usedIn || r.usedIn.claimId === claimId));
}

/**
 * Receipt-box bills a single line may take: unused, or used by this claim but not by another line,
 * and not already on this line.
 */
export function pickableForLine(
  employeeReceipts: readonly Receipt[], items: readonly ClaimLine[], draft: Pick<ClaimLine, 'id' | 'attachments'>, claimId: string,
): Receipt[] {
  const inOtherLines = receiptIdsInForm(items, draft.id);
  const onLine: Record<string, true> = {};
  for (const a of draft.attachments) if (a.receiptId) onLine[a.receiptId] = true;
  return employeeReceipts.filter((r) => !inOtherLines[r.id] && !onLine[r.id] && (!r.usedIn || r.usedIn.claimId === claimId));
}

/**
 * Fills EMPTY fields from the attached receipts: date, biller and bill number from the first
 * receipt (bill numbers are joined with ', '); amount as the sum of all receipts (never for
 * fuel-by-km, whose amount is computed). Returns new fields.
 */
export function prefillFromReceipts(def: ExpenseItemDef | null, fields: LineFields, receipts: readonly Receipt[]): LineFields {
  if (!def || !receipts.length) return fields;
  const f: LineFields = { ...fields };
  const first = receipts[0] as Receipt;
  const has = (k: keyof LineFields): boolean => def.fields.includes(k);
  const blank = (k: keyof LineFields): boolean => f[k] === undefined || f[k] === null || f[k] === '';
  if (has('date') && blank('date') && first.date) f.date = first.date;
  if (has('billerName') && blank('billerName') && first.billerName) f.billerName = first.billerName;
  if (has('billNumber') && blank('billNumber')) {
    const nums = receipts.map((r) => r.billNumber).filter(Boolean);
    if (nums.length) f.billNumber = nums.join(', ');
  }
  if (has('amount') && def.compute !== 'fuelKm' && blank('amount')) {
    const amt = receipts.reduce((sm, r) => sm + num(r.amount), 0);
    if (amt > 0) f.amount = amt;
  }
  return f;
}
