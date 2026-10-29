// Central place for every Phase D (Authentication & Security) setting.
// Everything here is overridable via .env — see .env.example for the
// full list with comments. Nothing here should be hard-coded in
// production; these are safe local-dev fallbacks only.

function requireInProd(name, fallback) {
  if (process.env.NODE_ENV === "production" && !process.env[name]) {
    throw new Error(`${name} must be set via environment variable in production.`);
  }
  return process.env[name] || fallback;
}

const authConfig = {
  jwt: {
    accessTokenSecret: requireInProd("JWT_ACCESS_SECRET", "dev-access-secret-change-me"),
    refreshTokenSecret: requireInProd("JWT_REFRESH_SECRET", "dev-refresh-secret-change-me"),
    // Item 5: short-lived access token forces frequent silent refreshes;
    // the refresh token is what actually controls the real session length.
    accessTokenExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
    refreshTokenExpiresInDays: Number(process.env.JWT_REFRESH_EXPIRES_DAYS || 7),
    issuer: process.env.JWT_ISSUER || "hrms-e-approval",
  },

  // Item 5: brute-force login protection.
  lockout: {
    maxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS || 5),
    lockoutMinutes: Number(process.env.LOGIN_LOCKOUT_MINUTES || 15),
  },

  // Item 6: password reset link lifetime.
  passwordReset: {
    tokenExpiryMinutes: Number(process.env.PASSWORD_RESET_EXPIRY_MINUTES || 30),
    // Where the emailed reset link points — your frontend's reset page.
    resetUrlBase: process.env.PASSWORD_RESET_URL_BASE || "http://localhost:5173/reset-password",
  },

  // Item 11 (Phase F): magic link lifetime. Short by design — it's meant
  // to be clicked within minutes of the notification email arriving.
  magicLink: {
    tokenExpiryMinutes: Number(process.env.MAGIC_LINK_EXPIRY_MINUTES || 15),
  },

  // SMTP — configured here from .env as requested. Used only for password
  // reset emails; magic-link emails are sent by your existing Auto Mailer
  // service and are out of scope here (see README's Phase F notes).
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true", // true for port 465, false for 587/25
    user: process.env.SMTP_USER || "",
    password: process.env.SMTP_PASSWORD || "",
    fromAddress: process.env.SMTP_FROM || "no-reply@example.com",
    fromName: process.env.SMTP_FROM_NAME || "HRMS e-Approval",
  },

  // Item 5: session/cookie behavior for the refresh token.
  cookies: {
    refreshTokenName: "hrms_refresh_token",
    // SameSite=Strict is the strongest CSRF defense but breaks the cookie
    // if your frontend and API ever end up on different registrable
    // domains (not just different ports) — switch to 'lax' if you hit that.
    sameSite: process.env.COOKIE_SAME_SITE || "strict",
    secure: process.env.NODE_ENV === "production", // requires HTTPS in prod
  },
};

module.exports = authConfig;
