# Travel Claim (TA_): SQL Server objects

Tables, functions and the procedures the app calls (plus `TA_usp_CanViewAttachment` for the file route and one internal helper). Generated from the screens and the contract in `docs/05-sp-contract.md`.

`TA_usp_GetLocationPolicyLimit` is installed as a compile-ready stub. It accepts `ItemKey`, an optional `StayLocation`, and an optional `IsBillAvailable` (`Yes`/`No`); at least one of the latter two is required. It currently returns a null limit and the item's `EnforceEligibility` flag; replace the limit lookup in `04_procs_session_files.sql` with the approved location/bill-availability policy lookup when ready.

> **Status: written but NEVER EXECUTED.** There was no SQL Server where this was authored. What was done: a static checker (`npm run sql:lint`: balanced blocks/quotes/parentheses, CREATE-first-in-batch, every referenced object and `alias.Column` exists), a contract test (`tests/sqlContract.test.ts`: names, JSON keys, reference data, required server-side rules) and a smoke-test script. **Run `99_smoke_test.sql` on a development database first and expect to fix some syntax or logic slips.**

Requires **SQL Server 2017 or later** (`STRING_AGG`, JSON functions with variable paths, `CREATE OR ALTER`).

## Install (in order, on the Travel Claim database)
| File | What |
|---|---|
| `01_tables.sql` | tables, constraints, indexes; dev stub for employees and `TA_vw_Employee` |
| `02_seed_reference.sql` | field definitions, expense types, items, lookup lists and settings. **Hand-maintained** and the single source of the reference data (the app and the tests both read it). Re-running refreshes definitions; limits, lookups and settings edited in the database are kept. Limits and rates are the prototype's placeholders |
| `03_functions.sql` | visibility rule, balances, request/receipt JSON builders, list view |
| `04_procs_session_files.sql` | session, policy, employee lookup, upload registration, file access check |
| `05_procs_requests.sql` | list, get, save draft, delete, copy rejected claim, submit (+ numbering helper) |
| `06_procs_approvals.sql` | approve, reject, queue, history |
| `07_procs_receipts.sql` | receipt box |
| `99_smoke_test.sql` | **development only**: end-to-end checks with assertions; cleans up after itself |

All files are re-runnable (or run `install_all.sqlcmd.sql` in SQLCMD mode). Each code script stamps its revision in `TA_SchemaVersion`; the app shows a banner naming any script that is missing or older than it expects.

**Already installed (earlier revision)?** Re-run **01, 02, 03, 04, 05, 06 and 07** (02 matters: item field lists changed from comma-separated text to a JSON array and the new reference tables need their rows), and set the self-approval rule explicitly (the seed only inserts missing settings): `UPDATE dbo.TA_Setting SET SettingValue = N'N' WHERE SettingKey = N'AllowSelfApproval';` Then add the names to the whitelist and patch `execProcedure.js` as in `docs/TA_backend_snippets.js`.

## What you must adapt
0. **Test users.** There is no demo data any more. Put your own employees in the employee view and list at least one approver in `TA_Approver`; `99_smoke_test.sql` creates and removes its own test users (T9001, T9002).
1. **Employees.** The module reads `dbo.TA_vw_Employee (EmployeeCode, Name, Department, Designation, CostCentre, Grade, IsActive)`. Replace the view body with a SELECT from your real employee master (the stub table is only for development).
2. **Approvers.** `TA_Approver` lists who may approve (role `admin` in the screens). Fill it from your real approver list. Any approver can act on any submitted request (the prototype's rule); set `TA_Setting 'AllowSelfApproval'` to `N` to forbid acting on one's own request.
3. **Policy.** Rates and limits in `TA_Setting` / `TA_ExpenseItem` are the prototype's placeholders. The app reads them through `TA_usp_GetPolicy`.
4. **Time zone.** "Today" is `SYSDATETIME()` of the SQL Server. It should be the users' local date (India).

## Employee and approver views
`TA_usp_GetSession` returns `role` + `isApprover`. Approvers (rows in `TA_Approver`) can act in two views; the app sends `ActAs: employee` to narrow a call to the ordinary employee experience (see `TA_fn_ActsAsApprover`). The hint can only narrow, never grant.

## Reference data and the approval trail
Expense types, items, field definitions and option lists are rows (`TA_FieldDef`, `TA_ExpenseType`, `TA_ExpenseItem`, `TA_Lookup`) read by `TA_usp_GetReferenceData`; the approval trail is `TA_usp_GetApprovalTrail`. See `docs/09-reference-data-and-trail.md`.

For each expense item that needs the bill-availability choice, add `"isBillAvailable"` to its JSON `TA_ExpenseItem.FieldList`. The `TA_FieldDef` and Yes/No options are seeded by `02_seed_reference.sql`.

## How it works (short)
- Caller = `ExecutedBy` (set by the server from the token). The browser's role, employee code, status, number, approver and approved amounts are never trusted.
- One header table `TA_Request` + detail tables per kind; claim lines keep their item-specific fields as JSON (`FieldsJson`) with `Amount`/`LineDate` extracted. Request numbers come from `TA_Counter` inside the save transaction.
- A file is stored once (`TA_Attachment`); `TA_AttachmentLink` shows it on a request/line; `TA_Receipt` is a file plus bill details and is "used" by at most one claim line.
- Errors: `THROW 50000, N'[CODE] message'` with `[VALIDATION] [FORBIDDEN] [NOT_FOUND] [CONFLICT] [UNAUTHORIZED]`. Submit returns every problem, one per line.

## Known limits and decisions left open
- **Not built:** orphan-file clean-up job (uploads never linked, deleted receipts and drafts leave files on disk), advance settlement (`TA_Advance.IsSettled` is never set by any procedure), leave application creation (only the `CreateLeave` flag is stored), e-mail/notifications, reports, PDF generation.
- **Performance:** list procedures build each row's JSON with a scalar function. Use paging (`Page`/`PageSize`); measure before using unpaged lists on large data.
- **Numbering** uses a locked counter row: in rare races a session is chosen as a deadlock victim and the call must be retried.
- **Concurrency:** state changes are guarded by status checks; `TA_Request.RowVer` exists but is not used for optimistic locking yet.
- **Business decisions** inherited from the prototype are listed at the end of `docs/05-sp-contract.md` (double-counted advances, 3 vs 5 day thresholds, placeholder limits).
