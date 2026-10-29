/**
 * Stored-procedure contract for the Travel Claim module (names and parameter shapes are PROPOSED by the frontend; the SP
 * logic is yet to be written; all new, prefixed TA_, and NOT reusing the existing usp_* procedures). Transport is the shared
 * execSp(spName, params) -> POST /api/execute. The server adds `ExecutedBy` (the employeeId from the verified token): procedures
 * MUST identify the caller from `$.ExecutedBy` only. See docs/05-sp-contract.md for the rules each procedure must enforce.
 *
 * Result shapes are the UI types in src/types/domain.ts serialised as camelCase JSON (e.g. FOR JSON PATH).
 */
export const SP = {
  getSession: 'TA_usp_GetSession',
  getPolicy: 'TA_usp_GetPolicy',
  getLocationPolicyLimit: 'TA_usp_GetLocationPolicyLimit',
  getReferenceData: 'TA_usp_GetReferenceData',
  getApprovalTrail: 'TA_usp_GetApprovalTrail',
  listRequests: 'TA_usp_ListRequests',
  getRequest: 'TA_usp_GetRequest',
  saveRequestDraft: 'TA_usp_SaveRequestDraft',
  submitRequest: 'TA_usp_SubmitRequest',
  deleteDraft: 'TA_usp_DeleteDraft',
  copyRejectedClaim: 'TA_usp_CopyRejectedClaim',
  approveRequest: 'TA_usp_ApproveRequest',
  rejectRequest: 'TA_usp_RejectRequest',
  listPendingApprovals: 'TA_usp_ListPendingApprovals',
  listApprovalHistory: 'TA_usp_ListApprovalHistory',
  listReceipts: 'TA_usp_ListReceipts',
  createReceipts: 'TA_usp_CreateReceipts',
  updateReceipt: 'TA_usp_UpdateReceipt',
  deleteReceipt: 'TA_usp_DeleteReceipt',
  lookupEmployees: 'TA_usp_LookupEmployees',
  /** Handled by name in execProcedure.js (base64 -> file on disk -> SP). The backend must special-case this name like usp_UploadAttachment. */
  uploadAttachment: 'TA_usp_UploadAttachment',
} as const;
export type SpName = (typeof SP)[keyof typeof SP];

/** The shared transport (the project's execSp). Resolves with the SP's `data`; rejects with Error(message). */
export type ExecSp = (spName: string, params?: Record<string, unknown>) => Promise<unknown>;

/** A stored file: `fileId` is the stored file name, `docType` the folder it lives in (e.g. TA_CLAIM). Requests reference files by both. */
export interface UploadedFile { fileId: string; docType: string; name: string; size: number; type: string }
export interface FileApi {
  /** Uploads one file (base64 through TA_usp_UploadAttachment). The server validates type (PDF/JPG/PNG) and size (<= 5 MB). */
  upload(file: File, target?: { kind?: string; recordId?: string; lineId?: string }): Promise<UploadedFile>;
  /** Fetches the stored file through the protected view route (token + cookies); the server must authorise the caller. */
  download(att: { fileId: string; docType: string }): Promise<Blob>;
}

/** Folder (docType) per kind of file; the server upper-cases it and keeps it under the attachment root. */
export const TA_DOC_TYPES = { claim: 'TA_CLAIM', receipt: 'TA_RECEIPT', travel: 'TA_TRAVEL', advance: 'TA_ADVANCE' } as const;
export const docTypeFor = (kind?: string): string => (kind === 'claim' || kind === 'receipt' || kind === 'travel' || kind === 'advance' ? TA_DOC_TYPES[kind] : TA_DOC_TYPES.claim);

/** Error codes an SP signals by prefixing the RAISERROR/THROW message, e.g. `[FORBIDDEN] You cannot edit this request`. */
export const SP_ERROR_PREFIXES = ['VALIDATION', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'UNAUTHORIZED'] as const;
export type SpErrorPrefix = (typeof SP_ERROR_PREFIXES)[number];
