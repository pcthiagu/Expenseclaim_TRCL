/**
 * Domain types for the Travel Claim module.
 * Source of truth: js/data.js, js/store.js and js/screens/*.js of the original prototype.
 * These describe the UI-facing model. The wire format of the real backend is NOT known yet
 * (see docs/02-api-gaps.md); a mapping layer in src/services must translate to/from it.
 */

export type RecordKind = 'claim' | 'travel' | 'advance';
export type RequestStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
export type Role = 'employee' | 'admin';

export type ExpenseTypeKey = 'fuel' | 'local' | 'medical' | 'other' | 'outside';

/** Colour family used for expense-type tags (Fuel=orange, Local=bluelight, Medical=freshgreen, Other=turquoise, Outside=purple). */
export type ColourFamily = 'orange' | 'bluelight' | 'freshgreen' | 'turquoise' | 'purple';

export type FieldKey =
  | 'date' | 'fromDate' | 'toDate' | 'fromTime' | 'toTime' | 'time'
  | 'modeOfTravel' | 'stayLocation' | 'fromLocation' | 'toLocation'
  | 'billerName' | 'billNumber' | 'isBillAvailable'
  | 'fromKm' | 'toKm' | 'totalKm' | 'nonAccountableKm' | 'qty'
  | 'amount' | 'limit' | 'remarks' | 'alongWith'
  | 'gstNumber' | 'state' | 'igst' | 'cgst' | 'sgst' | 'attachment';
export type GstFieldKey = 'gstNumber' | 'state' | 'igst' | 'cgst' | 'sgst';
export type GstFields = Partial<Record<GstFieldKey, string>>;

export type FieldType = 'date' | 'time' | 'select' | 'text' | 'number' | 'money' | 'textarea' | 'file';
/** Which option list a select shows: a TA_Lookup.ListKey (MODES, CITIES, ...) delivered by the database. */
export type OptionsKey = string;

export interface FieldDef {
  label: string;
  type: FieldType;
  required?: boolean;
  full?: boolean;
  readonly?: boolean;
  computed?: boolean;
  options?: OptionsKey;
  placeholder?: string;
  helper?: string;
  min?: number;
  step?: number;
}

export type LimitPer = 'bill' | 'day' | 'night';
export type EligibilityEnforcement = 'Y' | 'N';
export type RateKey = 'twoWheelerPerKm' | 'fourWheelerPerKm';

export interface ExpenseItemDef {
  key: string;
  label: string;
  /** Column heading in the date-wise grid. */
  short?: string;
  /** Dynamic fields, in display order. */
  fields: readonly FieldKey[];
  /** 'fuelKm' => amount is computed from odometer readings. */
  compute?: 'fuelKm';
  rate?: RateKey;
  /** Per-unit policy ceiling in INR; null means "no fixed limit - approver discretion". */
  limit?: number | null;
  limitPer?: LimitPer;
  enforceEligibility?: EligibilityEnforcement;
  /** Quantity cap in litres (fuel by litres). */
  limitQty?: number;
  /** Flat per-day items shown as columns of the date-wise grid. */
  fixed?: boolean;
  /** When true a bill is optional; otherwise at least one bill is required. */
  attachmentOptional?: boolean;
  helper?: string;
}

export interface ExpenseTypeDef {
  key: ExpenseTypeKey;
  label: string;
  short: string;
  family: ColourFamily;
  description: string;
  items: readonly ExpenseItemDef[];
  showBalance?: boolean;
  travelPeriod?: boolean;
}

export type FieldValue = string | number;
export type LineFields = Partial<Record<FieldKey, FieldValue>>;

/** File metadata only. The prototype never kept file contents. */
export interface AttachmentMeta {
  name: string;
  size: number;
  type: string;
  /** Present when the bill came from the receipt box. */
  receiptId?: string;
  /** Stored file name on the server (set once the file has been uploaded). */
  fileId?: string;
  /** Server folder of the stored file (e.g. TA_CLAIM); needed with fileId to open it. */
  docType?: string;
}

export interface ClaimLine {
  id: string;
  itemKey: string;
  fields: LineFields;
  attachments: AttachmentMeta[];
  /** null = not yet decided by the approver. */
  approvedAmount: number | null;
  approverRemarks: string;
}

export interface BaseRecord {
  id: string;
  kind: RecordKind;
  /** Assigned by the backend on first save. Empty string for an unsaved draft. */
  requestNumber: string;
  employeeCode: string;
  employeeName: string;
  costCentre: string;
  requestDate: string;
  status: RequestStatus;
  submittedOn: string | null;
  approvedOn: string | null;
  approver: string | null;
  /** Multi-level workflow: 'Level 2 - I00456' while pending, 'Authorized' when approved, 'Rejected' when rejected (null for drafts). */
  currentApprovalLevel?: string | null;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseClaim extends BaseRecord {
  kind: 'claim';
  expenseType: ExpenseTypeKey;
  purpose: string;
  travelFrom?: string;
  travelTo?: string;
  items: ClaimLine[];
  employeeComments: string;
  approverComments: string;
  rejectionReason: string;
}

export interface TravelEstimateLine {
  id: string;
  item: string;
  /** '' while the user is still typing. */
  amount: number | '';
  remarks: string;
}

export interface TravelRequest extends BaseRecord {
  kind: 'travel';
  purpose: string;
  remarks: string;
  fromLocation: string;
  toLocation: string;
  /** datetime-local strings, e.g. 2026-09-23T06:00 */
  periodFrom: string;
  periodTo: string;
  items: TravelEstimateLine[];
  advanceRequired: number | '';
  overallRemarks: string;
  approverRemarks: string;
  alongWith: string;
  attachments: AttachmentMeta[];
  createLeave: boolean;
}

export interface AdvanceRequest extends BaseRecord {
  kind: 'advance';
  periodFrom: string;
  periodTo: string;
  amount: number | '';
  purpose: string;
  remarks: string;
  alongWith: string;
  attachments: AttachmentMeta[];
  createLeave: boolean;
  /** Request number of the linked travel request, or ''. */
  travelRequest: string;
  /** True once the advance has been adjusted against an expense claim. */
  settled: boolean;
  approverRemarks: string;
}

export type TravelClaimRecord = ExpenseClaim | TravelRequest | AdvanceRequest;

export interface ReceiptUsage {
  claimId: string;
  requestNumber: string | null;
  lineId: string;
}

export interface Receipt {
  id: string;
  employeeCode: string;
  file: AttachmentMeta;
  uploadedAt: string;
  date: string;
  billerName: string;
  billNumber: string;
  amount: number | '';
  notes: string;
  usedIn: ReceiptUsage | null;
}

export interface Employee {
  code: string;
  name: string;
  department: string;
  costCentre: string;
  grade: string;
}

/** The signed-in actor. In production this MUST come from the backend/auth system, never from the browser. */
export interface Actor {
  role: Role;
  code: string;
  name: string;
}

export interface LimitInfo {
  /** INR ceiling for the line, or null when there is no fixed limit. */
  amount?: number | null;
  /** Litres cap (quantity-limited items). */
  qty?: number;
  units?: number;
  per?: LimitPer;
  text: string;
}

export interface MedicalUsage { limit: number; approved: number; pending: number; used: number; balance: number }
export interface AdvanceUsage { limit: number; outstanding: number; pending: number; used: number; balance: number }

/** Everything the screens need to know about expense types and items: delivered by TA_usp_GetReferenceData, never hard-coded in the app. */
export interface ReferenceFieldRow {
  key: string; label: string; type: FieldType; required?: boolean; computed?: boolean; full?: boolean; readonly?: boolean;
  options?: OptionsKey; placeholder?: string; helper?: string; min?: number; step?: number;
}
export interface ReferenceData {
  fields: ReferenceFieldRow[];
  types: ExpenseTypeDef[];
  /** MODES, CITIES, GST_STATES, TRAVEL_PURPOSE, ESTIMATE_ITEM, COST_CENTRE, ... */
  lookups: Record<string, string[]>;
}

/** One step of a request's approval trail (TA_usp_GetApprovalTrail). */
export interface TrailEvent {
  action: 'Created' | 'Submitted' | 'LevelApproved' | 'Approved' | 'Rejected' | 'Copied';
  actedBy: string;
  actedByName: string | null;
  actedAt: string;
  details: string | null;
}
