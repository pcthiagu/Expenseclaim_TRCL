> Historical: the migration is complete and the demo gateway mentioned below no longer exists in the product (a test-only engine remains under `tests/helpers/engine/`). Reference data now lives in the database (`docs/09-reference-data-and-trail.md`).

# Migration map (legacy module → target)

| Legacy | Target | Status |
|---|---|---|
| `js/data.js` CONFIG | `src/config/policy.ts` | Done, parity-tested |
| `js/data.js` FIELD_DEFS / EXPENSE_TYPES / GRID_COLUMNS / STATUSES / KINDS | `src/domain/expenseSchema.ts` | Done, parity-tested |
| `js/data.js` SEED, SEED_RECEIPTS, USERS, EMPLOYEES | demo gateway (explicit dev mode only) / backend | Pending |
| `js/store.js` fmt | `src/utils/format.ts` | Done, parity-tested |
| `js/store.js` calc | `src/domain/calc.ts` | Done, parity-tested |
| `js/store.js` perm, canView, statusLabel | `src/domain/workflow.ts` | Done, parity-tested (UI hints only) |
| `js/store.js` save/load/upsert/remove/nextRequestNumber/linkReceipts | gateway (backend); `linkReceipts` logic in `src/domain/receipts.ts` | Logic done; persistence blocked on API |
| `js/ui.js` | `src/components/common/*` (Button, Badge, Tag, Field, Modal, Toast, Tabs, Pagination, Alert, EmptyState, Meter, Stat, Icon) | Pending |
| `js/views.js` sort/list | `src/domain/lists.ts`; tables → `src/components/tables/*` | Logic done; components pending |
| `js/app.js` shell/router | `src/app/App.tsx`, `router.tsx`, `components/layout/*` | Pending |
| `screens/dashboard.js` | `pages/dashboard` + `lists.ts` KPIs | Logic done |
| `screens/claims.js` | `pages/expense-claims` + `components/filters` | Logic done |
| `screens/claimForm.js` (kit) | `components/forms/*`, `validation.ts`, `workflow.ts` | Logic done; UI pending |
| `claimForm.js` date-wise grid | `src/domain/dateWise.ts` + drawer component | Logic done; UI pending |
| `claimForm.js` line modal | `validation.ts`, `receipts.ts` + modal component | Logic done; UI pending |
| `screens/travelForm.js`, `advanceForm.js` | `pages/travel-requests`, `pages/advance-requests`, `validation.ts` | Logic done; UI pending |
| `screens/approvals.js` | `pages/approvals` + `lists.ts approvalsView` | Logic done |
| `screens/receipts.js` | `pages/receipt-box` + `receipts.ts` | Logic done; UI pending |
| `css/*`, `assets/*` | `src/styles/*`, `public/assets/*` | Done, byte-identical |
| `serve.js`, `vercel.json` | Replaced by Vite; keep `vercel.json` rewrites for SPA if deploying there | Pending |

## Update: all screens migrated
dashboard.js -> `pages/dashboard/DashboardPage.tsx`; claims.js + generic list -> `pages/shared/RecordList.tsx` (claims, travel, advance, embedded dashboard list); travelForm.js -> `pages/travel-requests/TravelFormPage.tsx`; advanceForm.js -> `pages/advance-requests/AdvanceFormPage.tsx`; approvals.js -> `pages/approvals/ApprovalsPage.tsx`; receipts.js -> `pages/receipt-box/ReceiptBoxPage.tsx` (+ OCR); formKit -> `components/forms/FormKit.tsx` + `pages/shared/useRecordForm.ts`.
