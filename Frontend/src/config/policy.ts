import type { RateKey } from '../types/domain';

/**
 * Policy assumptions carried over from the prototype (js/data.js -> TC.CONFIG).
 *
 * SOURCE / STATUS: these are PLACEHOLDER values from the prototype. The README states the
 * source plan ("Travel Module_PLN.xlsx") "did not carry figures". They are NOT confirmed company
 * policy. The values in the database (TA_Setting, via TA_usp_GetPolicy) replace these at start-up; per-item limits are part of the reference data
 * (TA_ExpenseItem, via TA_usp_GetReferenceData).
 */
export interface PolicyConfig {
  locale: string;
  currency: string;
  rates: Record<RateKey, number>;
  medicalAnnualLimit: number;
  advanceLimit: number;
  attachmentMaxBytes: number;
  attachmentTypes: readonly string[];
  /** False hides Approve/Reject on a request raised by the approver themself (the server enforces it too). */
  allowSelfApproval: boolean;
}

export const DEFAULT_POLICY: PolicyConfig = {
  locale: 'en-IN',
  currency: 'INR',
  rates: { twoWheelerPerKm: 4, fourWheelerPerKm: 9 },
  medicalAnnualLimit: 15000,
  advanceLimit: 15000,
  attachmentMaxBytes: 5 * 1024 * 1024,
  attachmentTypes: ['application/pdf', 'image/jpeg', 'image/png'],
  allowSelfApproval: true,   // the prototype's behaviour; the database default is N (segregation of duties) and is loaded from TA_usp_GetPolicy
};

/** An approval is flagged "needs attention" on the dashboard after this many days (dashboard.js). */
export const ATTENTION_DAYS = 3;
/** The approvals screen colours "Oldest waiting" as a warning after this many days (approvals.js).
 *  NOTE: differs from ATTENTION_DAYS in the prototype; preserved as-is, flagged in docs. */
export const APPROVALS_OLDEST_WARN_DAYS = 5;
/** Approvals history window and size (approvals.js). */
export const HISTORY_DAYS = 30;
export const HISTORY_MAX_ROWS = 10;
/** Date-wise entry limit (claimForm.js GRID_MAX_DAYS). */
export const GRID_MAX_DAYS = 31;
