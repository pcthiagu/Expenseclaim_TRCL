const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { execProcedure } = require("../sql/execProcedure");
const { signAccessToken } = require("../utils/jwt");
const { generateRefreshToken, hashToken } = require("../utils/refreshToken");
const { validatePasswordComplexity } = require("../utils/passwordPolicy");
const { sendPasswordResetEmail } = require("../utils/mailer");
const { checkAuth } = require("../middleware/auth");
const authConfig = require("../config/authConfig");

const router = express.Router();

// Item 5: stricter, dedicated rate limit on top of the general API limiter
// — brute-force protection at the network layer, complementing the
// DB-tracked per-account lockout below.
// const authLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   limit: 20,
//   standardHeaders: true,
//   legacyHeaders: false,
//   message: { success: false, message: "Too many attempts, please try again later." },
// });
// router.use(authLimiter);

const authLimiter = rateLimit({
  skip: () => true,
});

router.use(authLimiter);

function audit(employeeId, action, details, req) {
  return execProcedure("ExpenseClaimDB","usp_LogAudit", {
    EmployeeId: employeeId,
    Action: action,
    Details: details || null,
    IpAddress: req.ip,
    UserAgent: req.headers["user-agent"] || null,
  }).catch((err) => console.error("[audit] failed to log:", err.message));
}

function setRefreshCookie(res, rawToken) {
  res.cookie(authConfig.cookies.refreshTokenName, rawToken, {
    httpOnly: true,
    secure: authConfig.cookies.secure,
    sameSite: authConfig.cookies.sameSite,
    path: "/api/auth", // only sent back to auth endpoints, never the general API
    maxAge: authConfig.jwt.refreshTokenExpiresInDays * 24 * 60 * 60 * 1000,
  });
}

async function issueTokenPair(user, req, res) {
  const accessToken = signAccessToken(user);
  const rawRefreshToken = generateRefreshToken();
  const refreshTokenHash = hashToken(rawRefreshToken);
  const expiresAt = new Date(Date.now() + authConfig.jwt.refreshTokenExpiresInDays * 86400000);

  await execProcedure("ExpenseClaimDB","usp_AuthInsertRefreshToken", {
    EmployeeId: user.employeeId,
    TokenHash: refreshTokenHash,
    ExpiresAt: expiresAt.toISOString(),
    CreatedByIp: req.ip,
  });

  setRefreshCookie(res, rawRefreshToken);
  return accessToken;
}

// ---------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------
router.post("/login", async (req, res) => {
  const { employeeId, password } = req.body || {};
  if (!employeeId || !password) {
    return res.status(400).json({ success: false, message: "Employee ID and password are required." });
  }

  try {
    const user = await execProcedure("ExpenseClaimDB","usp_AuthGetUserForLogin", { EmployeeId: employeeId });


    // Dynamic lockout check from the users table
    if (user && Number(user.failedLoginAttempts) >= 3) {
      return res.status(429).json({
        success: false,
        message: "Your account is locked due to 3 failed login attempts. Please contact your HR administrator.",
      });
    }

    // if (user?.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    // return res.status(423).json({
    //   success: false,
    //   message: `Account temporarily locked until ${new Date(user.lockedUntil).toLocaleTimeString()}.`,
    // });

    // Deliberately generic message + roughly-constant response shape
    // whether the account exists or not, to resist user enumeration
    // (VAPT best practice) — the SAME message covers "no such user",
    // "wrong password", and "no password set yet".
    const genericFail = () => res.status(401).json({ success: false, message: "Invalid employee ID or password." });

    if (!user || !user.isActive || !user.passwordHash) {
      if (user) await audit(employeeId, "LoginFailed", "Account inactive or has no password set", req);
      return genericFail();
    }

    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      await audit(employeeId, "LoginFailed", "Account currently locked", req);
      return res.status(423).json({
        success: false,
        message: `Account temporarily locked until ${new Date(user.lockedUntil).toLocaleTimeString()}.`,
      });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      const outcome = await execProcedure("ExpenseClaimDB","usp_AuthLoginOutcome", {
        EmployeeId: employeeId,
        Success: false,
        MaxAttempts: authConfig.lockout.maxAttempts,
        LockoutMinutes: authConfig.lockout.lockoutMinutes,
      });
      await audit(employeeId, outcome?.locked ? "AccountLocked" : "LoginFailed", "Incorrect password", req);
      return genericFail();
    }

    await execProcedure("ExpenseClaimDB","usp_AuthLoginOutcome", { EmployeeId: employeeId, Success: true });
    await audit(employeeId, "Login", null, req);

    const accessToken = await issueTokenPair(user, req, res);
    return res.json({
      success: true,
      data: {
        accessToken,
        user: {
          employeeId: user.employeeId,
          name: user.employeeName,
          role: user.role,
          mustChangePassword: !!user.mustChangePassword,
        },
      },
    });
  } catch (err) {
    console.error("[auth/login] error:", err.message);
    return res.status(500).json({ success: false, message: "Login failed. Please try again." });
  }
});

// ---------------------------------------------------------------------
// POST /api/auth/refresh — item 5: token rotation + reuse detection
// ---------------------------------------------------------------------
router.post("/refresh", async (req, res) => {
  const rawToken = req.cookies?.[authConfig.cookies.refreshTokenName];
  if (!rawToken) {
    return res.status(401).json({ success: false, message: "No refresh token." });
  }

  try {
    const tokenHash = hashToken(rawToken);
    const stored = await execProcedure("ExpenseClaimDB","usp_AuthGetRefreshToken", { TokenHash: tokenHash });

    if (!stored) {
      return res.status(401).json({ success: false, message: "Invalid refresh token." });
    }

    if (stored.revokedAt) {
      // A revoked (already-rotated) token being presented again means
      // someone is replaying a stolen refresh token — the legitimate
      // owner already moved on to its replacement. Nuke every session
      // for this user as a defensive measure.
      await execProcedure("ExpenseClaimDB","usp_AuthRevokeAllRefreshTokensForUser", { EmployeeId: stored.employeeId });
      await audit(stored.employeeId, "LoginFailed", "Refresh token reuse detected — all sessions revoked", req);
      res.clearCookie(authConfig.cookies.refreshTokenName, { path: "/api/auth" });
      return res.status(401).json({ success: false, message: "Session invalidated, please log in again." });
    }

    if (new Date(stored.expiresAt) < new Date()) {
      return res.status(401).json({ success: false, message: "Refresh token expired, please log in again." });
    }

    const user = await execProcedure("ExpenseClaimDB","usp_AuthGetUserForLogin", { EmployeeId: stored.employeeId });
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: "Account no longer active." });
    }

    const newRawToken = generateRefreshToken();
    const newHash = hashToken(newRawToken);
    const newExpiresAt = new Date(Date.now() + authConfig.jwt.refreshTokenExpiresInDays * 86400000);

    await execProcedure("ExpenseClaimDB","usp_AuthRotateRefreshToken", {
      OldTokenHash: tokenHash,
      NewTokenHash: newHash,
      NewExpiresAt: newExpiresAt.toISOString(),
      CreatedByIp: req.ip,
    });

    setRefreshCookie(res, newRawToken);
    const accessToken = signAccessToken(user);

    return res.json({
      success: true,
      data: {
        accessToken,
        user: { employeeId: user.employeeId, name: user.employeeName, role: user.role },
      },
    });
  } catch (err) {
    console.error("[auth/refresh] error:", err.message);
    return res.status(500).json({ success: false, message: "Could not refresh session." });
  }
});

// ---------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------
router.post("/logout", async (req, res) => {
  const rawToken = req.cookies?.[authConfig.cookies.refreshTokenName];
  if (rawToken) {
    try {
      await execProcedure("ExpenseClaimDB","usp_AuthRevokeRefreshToken", { TokenHash: hashToken(rawToken) });
    } catch (err) {
      console.error("[auth/logout] failed to revoke token:", err.message);
    }
  }
  if (req.user) await audit(req.user.employeeId, "Logout", null, req);
  res.clearCookie(authConfig.cookies.refreshTokenName, { path: "/api/auth" });
  return res.json({ success: true, message: "Logged out." });
});

// ---------------------------------------------------------------------
// GET /api/auth/me — restores session state on app load
// ---------------------------------------------------------------------
router.get("/me", checkAuth, (req, res) => {
  res.json({ success: true, data: { user: req.user } });
});

// ---------------------------------------------------------------------
// POST /api/auth/change-password (authenticated)
// ---------------------------------------------------------------------
router.post("/change-password", checkAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: "Current and new password are required." });
  }

  const complexity = validatePasswordComplexity(newPassword);
  if (!complexity.valid) {
    return res.status(400).json({ success: false, message: complexity.errors.join(" ") });
  }

  try {
    const user = await execProcedure("ExpenseClaimDB","usp_AuthGetUserForLogin", { EmployeeId: req.user.employeeId });
    const matches = user?.passwordHash && (await bcrypt.compare(currentPassword, user.passwordHash));
    if (!matches) {
      return res.status(401).json({ success: false, message: "Current password is incorrect." });
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await execProcedure("ExpenseClaimDB","usp_AuthChangePassword", { EmployeeId: req.user.employeeId, NewPasswordHash: newHash });
    await audit(req.user.employeeId, "PasswordChanged", null, req);

    // Password change revokes every refresh token (including this
    // session's) — clear the cookie so the frontend doesn't keep trying
    // a now-dead one.
    res.clearCookie(authConfig.cookies.refreshTokenName, { path: "/api/auth" });
    return res.json({ success: true, message: "Password changed. Please log in again." });
  } catch (err) {
    console.error("[auth/change-password] error:", err.message);
    return res.status(500).json({ success: false, message: "Could not change password." });
  }
});

// ---------------------------------------------------------------------
// POST /api/auth/forgot-password
// ---------------------------------------------------------------------
router.post("/forgot-password", async (req, res) => {
  const { employeeId } = req.body || {};
  // Always the same response, whether or not the account exists — item 5
  // VAPT best practice, prevents account enumeration via this endpoint.
  const genericResponse = () =>
    res.json({ success: true, message: "If that account exists, a reset link has been sent to its email." });

  if (!employeeId) return genericResponse();

  try {
    const user = await execProcedure("ExpenseClaimDB","usp_AuthGetUserForLogin", { EmployeeId: employeeId });
    if (!user || !user.isActive || !user.email) {
      return genericResponse();
    }

    const { tokenGuid } = await execProcedure("ExpenseClaimDB","usp_AuthCreatePasswordResetToken", {
      EmployeeId: employeeId,
      ExpiryMinutes: authConfig.passwordReset.tokenExpiryMinutes,
    });

    const resetUrl = `${authConfig.passwordReset.resetUrlBase}?token=${tokenGuid}`;
    await sendPasswordResetEmail(user.email, user.employeeName, resetUrl);
    await audit(employeeId, "PasswordResetRequested", null, req);

    return genericResponse();
  } catch (err) {
    console.error("[auth/forgot-password] error:", err.message);
    // Still return the generic message — don't leak that something broke
    // server-side vs. the account not existing.
    return genericResponse();
  }
});

// ---------------------------------------------------------------------
// POST /api/auth/reset-password
// ---------------------------------------------------------------------
router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) {
    return res.status(400).json({ success: false, message: "Token and new password are required." });
  }

  const complexity = validatePasswordComplexity(newPassword);
  if (!complexity.valid) {
    return res.status(400).json({ success: false, message: complexity.errors.join(" ") });
  }

  try {
    const record = await execProcedure("ExpenseClaimDB","usp_AuthGetPasswordResetToken", { TokenGuid: token });
    if (!record) {
      return res.status(400).json({ success: false, message: "This reset link is invalid." });
    }
    if (record.status !== "Active") {
      return res.status(400).json({ success: false, message: "This reset link has already been used or is no longer valid." });
    }
    if (new Date(record.expiresAt) < new Date()) {
      return res.status(400).json({ success: false, message: "This reset link has expired." });
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await execProcedure("ExpenseClaimDB","usp_AuthCompletePasswordReset", { TokenGuid: token, NewPasswordHash: newHash });
    await audit(record.employeeId, "PasswordResetCompleted", null, req);

    return res.json({ success: true, message: "Password reset. You can now log in." });
  } catch (err) {
    console.error("[auth/reset-password] error:", err.message);
    return res.status(500).json({ success: false, message: "Could not reset password." });
  }
});

// ---------------------------------------------------------------------
// GET /api/auth/magic-login (Phase F)
// Consumes a single-use GUID from an email link and logs the user in.
// ---------------------------------------------------------------------
router.get("/magic-login", async (req, res) => {
  const { guid } = req.query;
  if (!guid) {
    return res.status(400).json({ success: false, message: "Missing token." });
  }

  try {
    const result = await execProcedure("ExpenseClaimDB","usp_ValidateAndConsumeMagicLink", {
      TokenGuid: guid,
      IpAddress: req.ip,
      BrowserInfo: req.headers["user-agent"] || null,
    });

    if (!result?.valid) {
      await audit(null, "LoginFailed", `Magic link rejected: ${result?.reason || "unknown"}`, req);
      return res.status(401).json({ success: false, message: "This login link is invalid, used, or expired." });
    }

    const user = await execProcedure("ExpenseClaimDB","usp_AuthGetUserForLogin", { EmployeeId: result.employeeId });
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: "Account no longer active." });
    }

    await audit(user.employeeId, "MagicLinkLogin", null, req);
    const accessToken = await issueTokenPair(user, req, res);

    return res.json({
      success: true,
      data: {
        accessToken,
        user: { employeeId: user.employeeId, name: user.employeeName, role: user.role },
        transactionNo: result.transactionNo,
        redirectUrl: result.redirectUrl,
      },
    });
  } catch (err) {
    console.error("[auth/magic-login] error:", err.message);
    return res.status(500).json({ success: false, message: "Could not complete magic-link login." });
  }
});

module.exports = router;