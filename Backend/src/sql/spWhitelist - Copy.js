// SECURITY: the /api/execute endpoint accepts a spName from the client.
// To avoid arbitrary stored-procedure execution, only names listed here
// are ever passed to SQL Server. Add new procedures here as screens are
// built.
//
// Phase G addition: each entry can optionally restrict WHICH roles are
// allowed to call it (checked against the caller's JWT role in
// execute.js). `roles: null` means any authenticated user may call it.
// This is real, enforced role-based authorization — item 5's
// requireRole() existed since Phase D but had nothing applying it until
// the Module Registration / User Rights screens gave a concrete need.

const ALLOWED_STORED_PROCEDURES = new Map([
  // --- General approval workflow — any authenticated user ---
  ["usp_GetPendingApprovals", { roles: null }],
  ["usp_GetApprovalRequestDetails", { roles: null }],
  ["usp_UpdateApprovalAction", { roles: null }],
  ["usp_GetApprovalDashboardCounts", { roles: null }],
  ["usp_GetApprovalDocuments", { roles: null }],
  ["usp_GetDocumentTree", { roles: null }],
  ["usp_ForwardApprovalRequest", { roles: null }],
  ["usp_WithdrawLastAction", { roles: null }],
  ["usp_SearchUsers", { roles: null }],
  ["usp_GetTransactionTypes", { roles: null }],
  ["usp_AddTransactionType", { roles: null }],
  ["usp_RequestClarification", { roles: null }],
  ["usp_RespondToClarification", { roles: null }],
  ["usp_SearchApprovalNumbers", { roles: null }],

  // New document-search screen: exposes ALL requests across every status,
  // not just what a user is currently approving — same company-wide
  // visibility precedent as usp_GetPendingApprovals (which also isn't
  // scoped to "your own"/"your department"), so left open to any
  // authenticated user for consistency. Worth reconsidering if this
  // should be tighter (e.g. Admin/Finance Head only) since it's more of
  // an audit/reporting tool than a day-to-day action screen — flagging
  // this rather than silently deciding it.
  ["usp_SearchApprovalDocuments", { roles: null }],

  // --- Raise Request screens (converted from the legacy ASP.NET
  // E_Approvals_Raise_screens app) — any authenticated user may raise a
  // request or look up an employee's org context; ExecutedBy is always
  // the server-forced caller identity (see execute.js), never trusted
  // from the client body. ---
  ["usp_GetEmployeeContext", { roles: null }],
  ["usp_SaveGeneralApproval", { roles: null }],
  ["usp_GetGeneralApprovalDetail", { roles: null }],
  ["usp_SaveMobilePhoneApproval", { roles: null }],
  ["usp_GetMobilePhoneApprovalDetail", { roles: null }],
  ["usp_AddWorkflowLevel", { roles: null }],
  ["usp_GetWorkflowDefinition", { roles: null }],
  ["usp_GetAttachments", { roles: null }],
  ["usp_UploadAttachment", { roles: null }],
  ["usp_GetAttachments", { roles: null }],

  // --- PDF scheduler internals — tightened to Admin. No ordinary user
  // action needs these; a regular authenticated client calling them
  // could otherwise mark arbitrary PDFs "generated" with a fake hash or
  // write arbitrary log rows. ---
  ["usp_GetRequestsNeedingPdfRegeneration", { roles: ["Admin"] }],
  ["usp_MarkPdfGenerated", { roles: ["Admin"] }],
  ["usp_LogPdfGeneration", { roles: ["Admin"] }],
   ["usp_LogPdfGeneration", { roles: ["Admin"] }],

  // --- Dynamic Menu (Phase G) ---
  // UserId for this one is force-overridden to the caller's own
  // employeeId in execute.js — never trust a client-supplied UserId for
  // "give me my own menu" — so no role restriction is needed here.
  ["usp_GetUserMenu", { roles: null }],

  // --- Module Registration screen — Admin only ---
  ["usp_GetModuleRegistry", { roles: ["Admin"] }],
  ["usp_RegisterModule", { roles: ["Admin"] }],
  ["usp_UpdateModule", { roles: ["Admin"] }],
  ["usp_ToggleModuleActive", { roles: ["Admin"] }],

  // --- User Rights screen — Admin only (operates on OTHER users'
  // UserId by design, so this is gated by role, not identity-forcing) ---
  ["usp_GetUserScreenRights", { roles: ["Admin"] }],
  ["usp_GetEffectiveUserPermissions", { roles: ["Admin"] }],
  ["usp_SaveUserScreenRight", { roles: ["Admin"] }],
  ["usp_ToggleUserScreenRight", { roles: ["Admin"] }],
  ["usp_RemoveUserScreenRight", { roles: ["Admin"] }],
]);

// SPs where a client-supplied identity field must never be trusted —
// execute.js force-overwrites this field with the caller's own
// employeeId from the verified JWT before the call reaches SQL Server.
const FORCE_OWN_USER_ID = new Map([["usp_GetUserMenu", "UserId"]]);

function isAllowed(spName) {
  return typeof spName === "string" && ALLOWED_STORED_PROCEDURES.has(spName);
}

function getRequiredRoles(spName) {
  return ALLOWED_STORED_PROCEDURES.get(spName)?.roles || null;
}

function getForcedUserIdField(spName) {
  return FORCE_OWN_USER_ID.get(spName) || null;
}

module.exports = { ALLOWED_STORED_PROCEDURES, isAllowed, getRequiredRoles, getForcedUserIdField };
