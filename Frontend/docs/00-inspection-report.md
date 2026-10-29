> Historical: written when the HTML prototype was inspected. The prototype (`legacy/prototype/`) has since been removed from the project; its computed values live on as golden fixtures (`tests/fixtures/golden.json`).

# Phase 1 — Inspection report

Source: `Travel_Claim.zip` (33 files, ~600 KB). Plain HTML/CSS/JS, no build step, hash router, zero dependencies.

## Inventory
| # | Item | Findings |
|---|---|---|
| 1 | Screens | Dashboard (`#/dashboard`), Claims list/form (`#/claims`, `/new`, `/:id`), Travel list/form, Advance list/form, Approvals (admin only), Receipt box (employee only). Lists are the same generic component with a request-type tab strip. |
| 2 | Shared UI | `js/ui.js`: icons, button, badge, tag, count, field (text/select/textarea/money/checkbox/file/search), readonly, kv, stat, meter, bars, alert, empty state, segmented, pagination, tabs, modal (+confirm, drawer), toast, two-way `data-bind` helper. `js/views.js`: tables/cards for claims, requests, queue, history. `TC.formKit` (in claimForm.js): page header, employee fields, request-number "Get", status field, attachments, employee picker, banners, action bar. |
| 3 | Data structures | Records of kind `claim`/`travel`/`advance`, claim lines with `fields`/`attachments`/`approvedAmount`; receipts with `usedIn`. Typed in `src/types/domain.ts`. |
| 4 | Calculations | Fuel by km, litres cap, limit × nights/days, medical annual balance, advance balance, claim/approved totals, date-wise totals, fill-within-limits. Ported in `src/domain/*`. |
| 5 | localStorage | One key `travel-claim.v2` = `{role, records, receipts}`. Seeded from `data.js` when absent. |
| 6 | API calls | **None.** No fetch/XHR anywhere. |
| 7 | Roles | `employee` (800001) and `admin` (700010) chosen from a browser dropdown. Admin sees all non-draft records plus drafts they created; can create on behalf of an employee. |
| 8 | Validation/limits | See `src/domain/validation.ts`; limits in `expenseSchema.ts`. |
| 9 | Status flow | draft → submitted → approved/rejected; rejected claim can be copied to a new draft. |
| 10 | Attachments | Metadata only (name/size/type); no file bytes kept. PDF/JPG/PNG ≤ 5 MB checked client-side. |
| 11 | Responsive/print | Desktop ≥ 901 tables; ≤ 900 card lists; ≤ 767 mobile/full-screen drawers; `@media print` hides chrome. 841-line `app.css`, 145-line `tokens.css`. |
| 12 | Dependencies | None. Google Fonts CDN (IBM Plex Sans/Mono). `Intl`, `ResizeObserver` (optional), `Promise`. |

## Findings (behaviour preserved, not changed)
1. `settled` is never set true → approved advances stay "outstanding" forever.
2. Travel-form advance check and a linked Advance Request are both counted against the ₹15,000 limit (seed TR/2026/0048 fails its own check).
3. "Needs attention" is >3 days (dashboard) vs >5 days (approvals "Oldest waiting").
4. Request numbers are generated client-side (max+1 over locally visible records) — collision-prone; backend must own them. Copy-to-draft also assigns a number immediately.
5. Floating-point money; rounding only on fuel amount and date-wise cells (`Math.round(x*100)/100`).
6. Role/permissions are browser-side only.
7. Policy numbers are placeholders (README: source plan carried no figures).
8. `TC.app.setBack(fn, predicate)` — second argument is ignored.
9. Date-wise apply sorts lines by date; "No changes" is decided by the add/update/remove counts (callers must discard the result when all are 0).
10. **Security:** `.env.local` in the ZIP holds a Vercel OIDC token. Not copied. Rotate it.

## Plan
Logic layer (done, tested) → React shell/router/layout → screens in order: claim form + line modal, date-wise drawer, receipt box, lists/dashboard, travel, advance, approvals → gateway implementation once the API contract is known → RTL/regression tests → deployment notes.
