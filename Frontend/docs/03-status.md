# Feature status

## What this is
A React + Vite + TypeScript application for travel expense claims, travel requests and advance requests. It talks ONLY to the existing Express backend (`POST /api/execute`, `/api/auth/*`, the protected file route) and, through it, to stored procedures. There is no demo or mock mode. Everything the screens know about expense types, items, fields, limits and option lists is read from the database at start-up (`TA_usp_GetReferenceData`).

## Verified (in the authoring sandbox, no SQL Server, no real backend)
| Area | Evidence |
|---|---|
| Type-check | `tsc` strict + `noUncheckedIndexedAccess` + `noUnused*`: exit 0 on all of `src` |
| Domain logic, validation, receipts, date-wise grid, lists, KPIs, gateway, auth transport, OCR parser/engines, SQL contract | **139 unit tests** (`tests/*.test.ts`). Parity with the original prototype is kept as **golden values** captured from it (`tests/fixtures/golden.json`); the prototype itself is no longer in the project |
| Every screen (dashboard, claims, receipt box, travel, advance, approvals, approval trail, reference data from the database) | **42 browser scenarios** (`npm run sandbox:e2e`): the real app in headless Chromium against a FAKE of the Express backend over the real login, token refresh and `/api/execute` |
| Sign-in, session restore, refresh, expiry, password flows, magic link, file upload/preview, employee/approver view switch, stale-database banner | **15 browser scenarios** (`npm run sandbox:e2e:api`) |
| SQL scripts | `npm run sql:lint` (balanced blocks/quotes/parentheses, batch rules, every referenced object and column exists) and `tests/sqlContract.test.ts` (names, JSON keys, reference data, the operation x view matrix, revision stamps), both **mutation-checked** (deliberately broken SQL is caught) |

## NOT verified
- **The SQL has never been executed** (`sql/TA/`). Static checks cannot prove it runs. Run `sql/TA/99_smoke_test.sql` on a development database first and expect to fix some slips.
- The fake backend is built from your `routes/*.js`, but it is not your server and not SQL Server. Nothing has run against the real backend.
- `vite build` / `npm run dev` on the current code, browsers other than Chromium, print output, and the IBM Plex fonts in the sandbox.
- OCR on real bills: the browser engine ran on your machine with partial accuracy; the later second pass has not been run in a real browser. OCR accuracy on your bills is unmeasured.
- Vitest / React Testing Library: not written.

## Open items
- Install and smoke-test the SQL (`sql/TA/README.md`); replace the employee view with your HR table; fill `TA_Approver`; apply the backend snippets (`docs/TA_backend_snippets.js`).
- Business decisions: approvers are not scoped (any approver sees and can act on every employee's non-draft requests), advance settlement does not exist, placeholder policy figures, and the prototype quirks listed at the end of `docs/05-sp-contract.md`.
- OCR: an external reading service as a fallback when local reading fails (planned; the remote engine already exists).
- Backend findings from the review of your source: `docs/07-integration-plan.md`.

## Known deviations from the original prototype
- Hash router written in `src/app/router.tsx` instead of React Router (isolated to router.tsx and App.tsx).
- The Status column now carries a one-line summary and a trail icon (the approval trail); uploaded bills in the claim table are listed one per line and open in a new tab; the approver has a "View as" switch.
