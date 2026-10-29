# Integration with the existing Express backend

Source of truth: the backend you attached (`server.js`, `routes/auth.js`, `routes/execute.js`, `middleware/auth.js`, `sql/execProcedure.js`, `sql/spWhitelist.js`, `config/authConfig.js`). The frontend follows it exactly. Decisions you gave: **new `TA_` procedures for all transactions (existing `usp_*` are not used)**, backend work is not part of this delivery, OCR stays as it is (an external API fallback comes later).

## What is implemented in the frontend
| Concern | Backend fact (verified in source) | Frontend |
|---|---|---|
| Data | `POST /api/execute {spName,params}` -> `{success,data,message}`; whitelist -> 403; `ExecutedBy` forced from the JWT | `execSp` (src/services/execSp.ts) sends no identity; one silent refresh on `TOKEN_EXPIRED`; typed errors; internals never shown |
| Sign in | `POST /api/auth/login {employeeId,password}` -> `{accessToken,user{employeeId,name,role,mustChangePassword}}` + cookie `hrms_refresh_token` (httpOnly, Path=/api/auth, SameSite=strict) | Sign-in page; token in memory only; wrong password / locked (423) / empty fields explained |
| Session restore | `POST /api/auth/refresh` (cookie), rotation, reuse revokes all | on load the app restores the session from the cookie; if it cannot, shows sign-in |
| Sign out | `POST /api/auth/logout` | account menu; session cleared even if the call fails |
| Passwords | `/change-password`, `/forgot-password`, `/reset-password` (link `.../reset-password?token=`), policy: 10+ chars, upper, lower, digit, special | change-password dialog; forgot page; reset page (path `/reset-password?token=`); forced screen when `mustChangePassword`; policy mirrored client-side |
| Magic link | `GET /api/auth/magic-login?guid=` -> tokens + `transactionNo` | signs in, removes the token from the address bar, opens the request with that number |
| Files | upload = `usp_UploadAttachment`-style base64 through `/api/execute` (special-cased by name); view = `GET /api/attachment/view/:docType/:fileName` | uploads via `TA_usp_UploadAttachment`; previews fetched with the token and shown from a blob URL; path segments encoded; view path configurable |
| Procedures | `@JsonParam` in, one `JsonResult` column out | `SpGateway` + `docs/05-sp-contract.md` (all `TA_usp_*`) |

Verified by tests: 131 unit tests (including 12 for execSp/auth transport against a fake server) and **12 real-mode browser scenarios** (`npm run sandbox:e2e:api`) in which the real frontend talks to a fake of YOUR Express API (`tests/helpers/fakeBackend.ts`, built from the source you sent): sign-in errors, session restore after reload, sign-out, silent refresh, hard expiry, approver vs employee, upload and preview of a stored file (byte-for-byte), server-error display, forgot/reset/change password, forced password change, locked account, magic link. **The fake is not your server and not SQL Server**: nothing has run against the real backend.

## What you must do on the backend (not done by me)
1. Write the `TA_usp_*` procedures from `docs/05-sp-contract.md`, and add them to the whitelist (`docs/TA_backend_snippets.js`).
2. Special-case `TA_usp_UploadAttachment` in `execProcedure.js` (snippet provided).
3. Decide who is an approver: `TA_usp_GetSession` must return `role: 'employee' | 'admin'` (approver). The JWT `role` (`Admin`, ...) is not used by this app.
4. Confirm CORS: `CLIENT_ORIGIN` must be the frontend origin (default `http://localhost:5173`, which matches Vite); `credentials: true` is already set. The refresh cookie is `SameSite=strict`: it works when frontend and API are the same site (e.g. `localhost` ports); for different sites in production set `COOKIE_SAME_SITE`/hosting accordingly.
5. Rate limits: `/api` allows 120 requests/minute per client and `/api/auth` only 20 per 15 minutes (login, refresh and logout all count). The dashboard makes several calls per load; each page load that restores a session uses one `/refresh`. Raise the limits if real use hits them.

## Security findings in the backend you sent (please review; I changed nothing)
1. **Token secrets.** `config/authConfig.js` reads `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` and falls back to `dev-access-secret-change-me` unless `NODE_ENV=production`; the `.env` you sent defines `JWT_SECRET` (not read) and a `DEV_HARDCODED_TOKEN`. Unless those variables are set elsewhere, access tokens are signed with a **publicly known default secret** and can be forged. Set strong `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` and `NODE_ENV=production`.
2. **Secrets in the archive.** `src/.env` (database credentials, JWT secret) was inside the zip. Rotate them and keep `.env` out of archives and source control.
3. **Attachment view route.** `GET /api/attachment/view/:docType/:fileName` joins decoded parameters into a path: `..%2F` sequences can reach files outside the attachment folder, and any signed-in user can read any stored file by name. `GET /api/approval-pdf/view/:transaction` also has no ownership check. Fix suggested in the snippets file.
4. **`/pdf-storage` is served without authentication** (`express.static`), so generated PDFs are readable by anyone who can guess or learn the file name.
5. **Uploads.** `saveAttachment` keeps the client's file extension (no allow-list, no content check), so an `.html`/`.svg` upload could be served inline from the API origin; the stored name uses the client-supplied `RequestedBy`; `uploadedFile` is assigned without being declared.
6. **Error text.** `/api/execute` returns `err.message` of database errors on HTTP 500. The frontend hides anything that looks like internals, but the server should log it and return a controlled message.

## Open questions
- The brief names `/api/taattachment/view` and `/uploadattachment*`; the attached server has `/api/attachment/view` and no upload route (upload is `usp_UploadAttachment` through execute). I followed the source; set `VITE_ATTACHMENT_VIEW_PATH` if your running server differs.
- "Return" action: your first brief lists approve, reject and return; this app's flow has no return. Say if it is required.
- Menus, permissions-driven navigation, administrative screens and reports: there are no such screens in the migrated prototype, so nothing was built (the existing `usp_GetUserMenu` etc. are for the e-Approval app).
