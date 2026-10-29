# Employee / approver views and data security: review

## Why "The receipt box is not available to approvers" appeared
That wording belongs to the OLD procedures. The current ones say "The receipt box is for employees: switch to the Employee view". The database was still running older scripts, so the view hint was not understood. Two changes make this impossible to miss again: every install script now **stamps its revision** in `TA_SchemaVersion`, and the app compares the stamps with the revision it expects and shows a banner naming the scripts to re-run. `install_all.sqlcmd.sql` runs everything in order.

## Three layers, and who decides what
1. **Capability: decided by the SERVER.** `TA_usp_GetSession` returns `isApprover` (a person with an active row in `TA_Approver`). Nothing the browser sends can create or remove it.
2. **View: chosen by the person, can only NARROW.** An approver may act as an employee. The app sends `ActAs: employee`; procedures call `TA_fn_ActsAsApprover(@JsonParam)`: true only for a genuine approver who did not ask for the employee view. A non-approver sending `ActAs: approver` stays an employee (tested).
3. **Screens: UI hints only.** Routes and buttons follow the chosen view; the server enforces the same rules again.

## Operation x view (enforced in SQL; locked by `tests/sqlContract.test.ts`)
| Operation | Employee view | Approver view |
|---|---|---|
| List / open requests | own requests only | every non-draft request + drafts they created |
| Save / delete / submit draft | own drafts (always for themself, whatever code is typed) | own-created drafts; may create for another existing employee |
| Copy a rejected claim | owner only | refused |
| Receipt box (list, create, edit, delete) | own bills | refused |
| Approve / reject | refused | any submitted request, except their own when `AllowSelfApproval = N` |
| Approvals queue and history | refused | allowed |
| Employee lookup (Help / filter) | refused | allowed |
| Upload a file | allowed | allowed (a file is owned by its uploader) |

Routes follow the same table: in the Employee view `#/approvals` redirects to the dashboard; in the Approver view `#/receipts` does (both tested in a browser).

## Findings fixed in this review
1. **Policy was never loaded by the app.** `TA_usp_GetPolicy` existed but nothing called it, so limits, balances and the self-approval rule edited in the database had no effect on screen. Now loaded at start-up: item limits (including limits REMOVED in the database) replace the built-in ones, balances use the database values, and a failure to load falls back to the prototype values.
2. **Self-approval.** Because an approver can now also claim, "approve your own request" became a real segregation-of-duties hole. The database default is now `AllowSelfApproval = N` (the old default was `Y`); the screens hide Approve/Reject on your own request when it is off, and the procedures refuse it. **Existing databases keep their current value: run `UPDATE dbo.TA_Setting SET SettingValue = N'N' WHERE SettingKey = N'AllowSelfApproval';`** unless the business decides otherwise.
3. **Stale database** is detected and named (above).
4. **Role spelling** from the session is normalised; an unreadable session is an error, not a silent employee.
5. **Silent failures:** the employee dropdown now shows its error.

## Risks that need a business or backend decision (not fixable in the screens)
- **Approvers are not scoped.** Any approver sees and can act on every employee's non-draft request, including medical claims. If that is wrong (department, cost centre, reporting line), a scope table (for example `TA_ApproverScope`) is needed; it is a change to `TA_fn_Visible` and the approve/reject checks.
- **File access follows the approver CAPABILITY, not the current view** (`TA_usp_CanViewAttachment`): an approver who is in the Employee view can still open a file of any request they could see as an approver. Same data, same person; tighten if you want the views fully separated.
- **Backend file route and secrets** (path traversal, public `/pdf-storage`, default token secrets): see `docs/07-integration-plan.md`; none of it is fixed here because the backend is out of scope.
- **The SQL has not been executed anywhere.** Everything above for the database is verified only by the static checker, text-level contract tests (mutation-checked) and the unrun smoke test.

## How to check it yourself on a development database
1. `SELECT * FROM dbo.TA_SchemaVersion;` every row at the revision in `src/config/schemaRev.ts`.
2. Sign in as a person in `TA_Approver`: the "View as" dropdown shows; the Employee view opens the receipt box and lists only their own requests; the Approver view opens the queue and refuses the receipt box.
3. Sign in as a person who is not an approver: no dropdown; `#/approvals` redirects.
4. `sql/TA/99_smoke_test.sql` (section 14 covers the views).
