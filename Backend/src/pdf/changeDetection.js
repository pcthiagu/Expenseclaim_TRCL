const crypto = require("crypto");

// Item 10.6: hash exactly the data that feeds the template, so any change
// to status, comments, workflow history, approval levels, or transaction
// fields is detected. Deliberately excludes the caching fields themselves
// (pdfPath/pdfDataHash/pdfGeneratedAt/pdfRegenerationNeeded) — those
// describe the cache's own state, not content that should be *in* the PDF,
// so including them would make the hash change every time we save it.
function computeDataHash(details) {
  const { pdfPath, pdfDataHash, pdfGeneratedAt, pdfRegenerationNeeded, ...contentOnly } = details || {};
  // Note: the replacer array only orders top-level keys — nested objects
  // (employeeInfo, requestInfo, approvalLevels[], etc.) stringify in
  // whatever order usp_GetApprovalRequestDetails' FOR JSON PATH produced
  // them, which is deterministic run-to-run since it's always the same
  // query. That's sufficient here: we're detecting real content changes,
  // not guarding against a JSON serializer producing different key orders
  // for identical data.
  const canonical = JSON.stringify(contentOnly, Object.keys(contentOnly).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

module.exports = { computeDataHash };
