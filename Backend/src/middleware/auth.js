// Phase D: real JWT-based auth, replacing the earlier hardcoded token.
// The rest of the app (routes, execute.js) is unaffected — req.user still
// gets populated the same way, just from a verified token instead of a
// constant.

const { verifyAccessToken } = require("../utils/jwt");

function checkAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { employeeId: payload.employeeId, role: payload.role, name: payload.name };
    next();
  } catch (err) {
    // Item 5: distinguish an expired token so the frontend knows to try a
    // silent refresh instead of bouncing straight to the login page.
    const expired = err.name === "TokenExpiredError";
    return res.status(401).json({
      success: false,
      message: expired ? "Access token expired" : "Invalid access token",
      code: expired ? "TOKEN_EXPIRED" : "TOKEN_INVALID",
    });
  }
}

// Item 5: role-based authorization. Usage: requireRole('Admin') or
// requireRole('Admin', 'Finance Head').
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Forbidden — insufficient role" });
    }
    next();
  };
}

module.exports = { checkAuth, requireRole };
