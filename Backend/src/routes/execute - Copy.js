const express = require("express");
const { isAllowed, getRequiredRoles, getForcedUserIdField } = require("../sql/spWhitelist");
const { execProcedure } = require("../sql/execProcedure");

const router = express.Router();

/**
 * POST /api/execute
 * body: { spName: "usp_GetPendingApprovals", params: { ...any JSON... } }
 *
 * This is the ONLY data endpoint in the whole app. Every screen (list,
 * details, approve/reject/return, dashboards, documents, menus, admin
 * screens) calls through here with a different spName + params payload.
 */
router.post("/execute", async (req, res) => {
  const { spName, params } = req.body || {};

  if (!spName) {
    return res.status(400).json({ success: false, message: "spName is required" });
  }

  if (!isAllowed(spName)) {
    return res.status(403).json({ success: false, message: `Stored procedure '${spName}' is not permitted` });
  }

  // Phase G: real role-based authorization at the SP boundary.
  const requiredRoles = getRequiredRoles(spName);
  if (requiredRoles && !requiredRoles.includes(req.user?.role)) {
    return res.status(403).json({ success: false, message: "Forbidden — insufficient role" });
  }

  const finalParams = { ...params, ExecutedBy: req.user?.employeeId };

  // Never trust a client-supplied identity field for "give me my own
  // data" calls — force it to the verified caller's own employeeId.
  const forcedField = getForcedUserIdField(spName);
  if (forcedField) {
    finalParams[forcedField] = req.user?.employeeId;
  }

  try {
    const data = await execProcedure(spName, finalParams);
    return res.json({ success: true, data, message: "OK" });
  } catch (err) {
    console.error(`[execute] ${spName} failed:`, err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
