// SNIPPETS FOR THE BACKEND DEVELOPER. Nothing here has been applied to your server (the backend was out of scope).

// 1) sql/spWhitelist.js: add to ALLOWED_STORED_PROCEDURES. Approver rights are enforced INSIDE the procedures from ExecutedBy.
["TA_usp_GetSession",          { roles: null }],
["TA_usp_GetPolicy",           { roles: null }],
["TA_usp_GetLocationPolicyLimit", { roles: null }], // {ItemKey, StayLocation?, IsBillAvailable?, AlongWith: [employeeCode, ...]} -> {limit, limitPer}; stub returns null until policy lookup is added
["TA_usp_GetReferenceData",    { roles: null }],
["TA_usp_GetApprovalTrail",    { roles: null }],
["TA_usp_ListRequests",        { roles: null }],
["TA_usp_GetRequest",          { roles: null }],
["TA_usp_SaveRequestDraft",    { roles: null }],
["TA_usp_SubmitRequest",       { roles: null }],
["TA_usp_DeleteDraft",         { roles: null }],
["TA_usp_CopyRejectedClaim",   { roles: null }],
["TA_usp_ApproveRequest",      { roles: null }],
["TA_usp_RejectRequest",       { roles: null }],
["TA_usp_ListPendingApprovals",{ roles: null }],
["TA_usp_ListApprovalHistory", { roles: null }],
["TA_usp_ListReceipts",        { roles: null }],
["TA_usp_CreateReceipts",      { roles: null }],
["TA_usp_UpdateReceipt",       { roles: null }],
["TA_usp_DeleteReceipt",       { roles: null }],
["TA_usp_LookupEmployees",     { roles: null }],
["TA_usp_UploadAttachment",    { roles: null }],

// 2) sql/execProcedure.js: handle the new upload procedure exactly like usp_UploadAttachment, and use the SERVER-forced identity.
//    (Also fix: `uploadedFile` is assigned without being declared; reject extensions other than .pdf/.jpg/.jpeg/.png; use ExecutedBy,
//    not the client-supplied RequestedBy, for the stored-file prefix.)
// IMPORTANT for TA_usp_UploadAttachment (sql/TA/04): validate BEFORE writing to disk and report the REAL size, because the SP can only trust what it is given:
//   const ext = path.extname(params.FileName || "").toLowerCase();
//   if (![".pdf", ".jpg", ".jpeg", ".png"].includes(ext)) throw new Error("[VALIDATION] Only PDF, JPG or PNG files are accepted.");
//   const buffer = Buffer.from(params.Base64Content, "base64");
//   if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) throw new Error("[VALIDATION] The file must be between 1 byte and 5 MB.");
//   (check the leading bytes too: %PDF, FF D8 FF, 89 50 4E 47)   then   params.Size = buffer.length;
const UPLOAD_SPS = new Set(["usp_UploadAttachment", "TA_usp_UploadAttachment"]);
async function execProcedure(spName, paramsObject) {
  if (UPLOAD_SPS.has(spName)) {
    const saved = await saveAttachment(paramsObject);        // in saveAttachment: employeeId = (params.ExecutedBy || "SYSTEM")...
    paramsObject.StoredFileName = saved.storedFileName;
    paramsObject.FilePath = saved.fullPath;
    delete paramsObject.Base64Content;
  }
  // ...rest unchanged
}

// 3) routes: harden the preview route (path traversal + authorisation). `req.params` values are URL-DECODED, so ..%2F..%2F reaches path.join.
const ALLOWED_DOC_TYPES = /^[A-Z0-9_]{1,40}$/;
app.get("/api/attachment/view/:docType/:fileName", checkAuth, async (req, res) => {
  const docType = String(req.params.docType).toUpperCase();
  const fileName = path.basename(String(req.params.fileName));           // no directories
  if (!ALLOWED_DOC_TYPES.test(docType) || fileName !== req.params.fileName) return res.status(400).json({ success: false, message: "Invalid file" });
  const root = path.resolve(process.env.ATTACHMENT_ROOT || "D:\\HRMS\\Attachments");
  const full = path.resolve(root, docType, fileName);
  if (!full.startsWith(path.join(root, docType) + path.sep)) return res.status(400).json({ success: false, message: "Invalid file" });
  if (docType.startsWith("TA_")) {
    // sql/TA/04 provides TA_usp_CanViewAttachment: {ExecutedBy, DocType, FileName} -> {"allowed":true|false}. Call it with execProcedure (not through the whitelist).
    const verdict = await execProcedure("TA_usp_CanViewAttachment", { ExecutedBy: req.user.employeeId, DocType: docType, FileName: fileName });
    if (!verdict || !verdict.allowed) return res.status(404).json({ success: false, message: "File not found" });   // same answer as a missing file
  }
  if (!fs.existsSync(full)) return res.status(404).json({ success: false, message: "File not found" });
  res.setHeader("Content-Disposition", "inline"); res.setHeader("X-Content-Type-Options", "nosniff");
  return res.sendFile(full);
});
