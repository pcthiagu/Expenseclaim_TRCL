# Stored-procedure contract: new `TA_usp_*` procedures

> The tables and procedures described here are now written in `sql/TA/` (see its README). They have **not been executed**: run `sql/TA/99_smoke_test.sql` on a development database first.

Transport: the shared `execSp(spName, params)` → `POST /api/execute` → `EXEC <spName> @JsonParam = '<json>'`, result `{ success, data, message }`.
Code: `src/services/spContract.ts` (names, types) and `src/services/SpGateway.ts` (the only place that calls them). Behaviour reference for the tests: `tests/helpers/engine/serverEngine.ts` (an in-memory server that enforces these rules; it powers the fake backend of the browser tests). **It is a model, not proof the real procedures behave the same.**

## How the existing backend calls a procedure (read from `routes/execute.js`, `sql/execProcedure.js`, `sql/spWhitelist.js`)
- `POST /api/execute {spName, params}` -> `isAllowed(spName)` (whitelist, else **403** `Stored procedure 'X' is not permitted`) -> role check -> `finalParams = {...params, ExecutedBy: <employeeId from the verified JWT>}` -> `EXEC spName @JsonParam = '<json>'`.
- **Identity: use `JSON_VALUE(@JsonParam,'$.ExecutedBy')` only.** The browser sends no identity (it used to send `RequestedBy`; that has been removed). Never read an employee id from any other field to decide who the caller is.
- **Result: return ONE column named `JsonResult`** (`SELECT (... FOR JSON PATH[, WITHOUT_ARRAY_WRAPPER]) AS JsonResult`); the server parses it. No rows / NULL -> `null`. Lists are JSON arrays; single objects use `WITHOUT_ARRAY_WRAPPER`.
- **Errors arrive as HTTP 500 `{success:false, message: <SP error text>}`** for every failure, so the HTTP status cannot carry the error class. SPs therefore prefix the message: `THROW 50000, N'[FORBIDDEN] You cannot edit this request', 1`. Codes: `[VALIDATION]` `[FORBIDDEN]` `[NOT_FOUND]` `[CONFLICT]` `[UNAUTHORIZED]`. The frontend maps the prefix to its error class and shows the text after it. Messages without a prefix are shown only if they are short and do not look like database internals (otherwise a generic message is shown).
- **Add every `TA_usp_*` name to `ALLOWED_STORED_PROCEDURES`** (snippet: `docs/TA_backend_snippets.js`). Use `roles: null` and enforce approver rights **inside the SP** (the whitelist role is the JWT role, e.g. `Admin`, which is not the same as "approver of travel requests").
- Do **not** call existing `usp_*` procedures for transactions; the TA_ module is self-contained (its own tables, numbering, workflow, receipts).

## Employee view vs Approver view (`ActAs`)
Everyone is an employee; people listed in `TA_Approver` are ALSO approvers and the app shows them a **View as: Employee / Approver** switch.
- `TA_usp_GetSession` reports the **capability** (`role: 'admin'`, `isApprover: true` for an approver).
- In the Employee view the app adds `"ActAs":"employee"` to the params of every call (nothing is sent in the Approver view). Procedures call `dbo.TA_fn_ActsAsApprover(@JsonParam)`: true only for a **genuine** approver whose `ActAs` is not `employee`. So the hint can only **narrow** an approver to the employee experience (own requests, receipt box, copy a rejected claim, always saving for themself); it can never grant approver rights, and a plain employee sending `ActAs:"approver"` stays an employee.
- Approver-only procedures (approve, reject, queue, history, employee lookup) refuse the Employee view; the receipt box and copy-rejected-claim refuse the Approver view.
- `/api/execute` already forwards `params` untouched to the procedure, so no backend change is needed for this.

## Non-negotiables (security)
1. Authorise inside every SP from `$.ExecutedBy`: ownership, approver rights, status transition, limits. Unreadable and missing records both return `[NOT_FOUND]`.
2. Never build dynamic SQL from JSON values (`OPENJSON ... WITH (...)`); `SortKey` must be mapped from a whitelist.
3. Request numbers are generated **inside the SP**, concurrency-safe (counter table with `UPDLOCK, HOLDLOCK`, or `SEQUENCE`): claims `EMPCODE/YYYY/NNNN` (per employee code and year), travel `TR/YYYY/NNNN`, advance `AR/YYYY/NNNN`.

## Procedures
| SP | Params (JSON) | Returns | Must enforce |
|---|---|---|---|
| `TA_usp_GetSession` | `{}` | `SessionUser` `{code,name,role,designation,department,costCentre}` | `code` = `$.ExecutedBy`; `role` is **`employee` or `admin` (approver) as decided by the SP** (the app also accepts any case, `approver`, or an `isApprover: true` flag; anything else is treated as `employee`) from the workflow/permissions, NOT the JWT role |
| `TA_usp_GetPolicy` | `{}` | `{ policy: { rates, medicalAnnualLimit, advanceLimit, attachmentMaxBytes, attachmentTypes, allowSelfApproval } }` | Settings from `TA_Setting`, not hard-coded. The app falls back to documented defaults only if this cannot be read. Item limits are NOT here any more (see GetReferenceData) |
| `TA_usp_GetLocationPolicyLimit` | `{ItemKey,StayLocation}` | `{limit,limitPer,enforceEligibility}` or `null` | Currently a compile-ready stub returning a null limit and `enforceEligibility:"N"`. Replace its final SELECT with the approved location lookup; location eligibility takes precedence over reference-data limits. `enforceEligibility` must be `"Y"` or `"N"`. Called when an expense item with `stayLocation` receives a location. Use `$.ExecutedBy` for any employee-specific policy. |
| `TA_usp_GetReferenceData` | `{}` | `{ fields:[...], types:[{ ..., items:[...] }], lookups:{ MODES, CITIES, TRAVEL_PURPOSE, ESTIMATE_ITEM, COST_CENTRE } }` | Everything the screens know about expense types, items, fields and option lists (see `docs/09-reference-data-and-trail.md`). Item `fields` is an ordered array; each item includes `enforceEligibility:"Y"` or `"N"`. Optional properties are omitted when NULL |
| `TA_usp_GetApprovalTrail` | `{Kind,Id}` | `[{action,actedBy,actedByName,actedAt,details}]` oldest first | any request the caller can see, in both views, else `[NOT_FOUND]`; action is Created, Submitted, Approved, Rejected or Copied |
| `TA_usp_ListRequests` | `{Kind?,EmployeeCode?,Status?,Search?,From?,To?,Page?,PageSize?,SortKey?,SortDir?}` | `{rows:[Request], total}` | Employee: own records only (ignore `EmployeeCode`). Approver: every non-draft record + drafts they created. `Search` over request no., employee name/code, purpose, remarks, destination, expense-type label. Paging/sorting in SQL for big data |
| `TA_usp_GetRequest` | `{Kind,Id}` | `Request` | visibility as above, else `[NOT_FOUND]` |
| `TA_usp_SaveRequestDraft` | `{Kind, Request:{...}}` | saved `Request` | see **Save** below |
| `TA_usp_SubmitRequest` | `{Kind,Id}` | `Request` | see **Submit** below |
| `TA_usp_DeleteDraft` | `{Kind,Id}` | `null` | only own saved draft (`[CONFLICT]` if not a draft); frees the claim's receipts |
| `TA_usp_CopyRejectedClaim` | `{Id}` | new draft `ExpenseClaim` | owner employee only, source must be rejected; new number; new line ids; approved amounts/remarks/rejection reset; request date = today; **do not carry receipts still linked to another claim** |
| `TA_usp_ApproveRequest` | `{Kind,Id,Lines?,ApproverComments?,ApproverRemarks?}` | `Request` | approver only; status must be `submitted`; claims: a line entry for **every** line with `0 <= approvedAmount <= claimed` (else `[VALIDATION]`); sets status, `approvedOn`=today, `approver`=caller name; clears rejection reason |
| `TA_usp_RejectRequest` | `{Kind,Id,Lines?,ApproverComments?,ApproverRemarks?,RejectionReason?}` | `Request` | approver only; submitted only; claim: `RejectionReason` required; travel/advance: `ApproverRemarks` required; undecided claim lines get approved amount 0 |
| `TA_usp_ListPendingApprovals` | `{}` | `[Request]` oldest `submittedOn` first | approver only |
| `TA_usp_ListApprovalHistory` | `{Days}` | `[Request]` (approved/rejected, `approvedOn` within the last `Days` (max 30), newest first, **max 10 rows**) | approver only |
| `TA_usp_ListReceipts` | `{}` | `[Receipt]` newest upload first | employee only (approvers: `[FORBIDDEN]`); own receipts |
| `TA_usp_CreateReceipts` | `{Files:[{FileId,Name,Size,Type}]}` | `[Receipt]` | files must exist, belong to the caller and be unlinked; all-or-nothing |
| `TA_usp_UpdateReceipt` | `{Receipt:{id,date,billerName,billNumber,amount,notes}}` | `Receipt` | own; not if `usedIn` (`[CONFLICT]`); date not in the future; file/owner/usage are server-owned |
| `TA_usp_DeleteReceipt` | `{Id}` | `null` | own; not if on a claim (`[CONFLICT]`); delete the stored file too |
| `TA_usp_LookupEmployees` | `{Query}` | `[Employee]` | approver only; matches code, name, department |
| `TA_usp_UploadAttachment` | `{DocType,FileName,MimeType,Size,Base64Content,Kind?,RecordId?,LineId?}` | `{storedFileName}` | **special-cased by name in `execProcedure.js` like `usp_UploadAttachment`** (base64 -> file under `ATTACHMENT_ROOT/<DOCTYPE>/` -> SP). Allow only PDF/JPG/PNG (check the real content, not just the extension), size <= 5 MB, store under a server-generated name, record the owner (`ExecutedBy`), return the stored name |

### Save (draft) rules
- Create or update; **only drafts** (`[CONFLICT]` otherwise) and only by the owner (an approver may create on behalf of an existing employee; the employee cannot change after first save). Employee name and default cost centre come from the employee master.
- Assign the request number on first save. Ignore any client `requestNumber`, `status`, `approver`, dates, `approvedAmount`, `settled`.
- Claims: recompute fuel-by-km lines — `totalKm = max(0, toKm-fromKm)`, `amount = round2(max(0,totalKm-nonAccountableKm) × rate)` (rates 4 / 9 ₹/km are placeholders).
- Receipt links: every `attachments[].receiptId` must belong to the request's employee and not be on another request; the same receipt cannot be on two lines (`[CONFLICT]`). Set `usedIn` for linked receipts and release receipts no longer referenced by this claim.
- A draft needs only a valid employee and request date.

### Submit rules (re-validate everything; the browser checks are conveniences)
- **Claim**: purpose, cost centre, ≥ 1 line; outside-travel needs `travelFrom ≤ travelTo`; request date not in the future; each line: required fields of its item, amount > 0 (fuel: `toKm > fromKm`, non-accountable ≤ total, claimable > 0), litres > 0 where applicable, `toDate ≥ fromDate`, `date` not in the future, **a bill unless the item allows none**; **medical**: total ≤ remaining annual balance (limit − approved − submitted claims of the same employee in the same calendar year, excluding this one).
- **Travel**: purpose, from/to, period end after start, ≥ 1 estimate line with item and amount > 0, advance ≥ 0, ≤ estimate and ≤ advance balance.
- **Advance**: purpose, period (end ≥ start), amount > 0 and ≤ advance balance (limit − approved-and-unsettled − submitted, excluding this one).
- Then draft → submitted, `submittedOn` = today. Status flow is only Draft → Submitted → Approved \| Rejected.

## Files
- **Upload**: `TA_usp_UploadAttachment` through `/api/execute` (base64, as the existing app does; the 10 MB JSON limit allows a 5 MB file). DocTypes used: `TA_CLAIM`, `TA_RECEIPT`, `TA_TRAVEL`, `TA_ADVANCE` (folders under `ATTACHMENT_ROOT`). The stored name goes back to the browser as `fileId` and is saved in `attachments[]` with its `docType`; one line, request or receipt can carry many files.
- **Preview**: `GET {VITE_ATTACHMENT_VIEW_PATH}/:docType/:fileName` with the access token (default `/api/attachment/view`, which is what the attached server implements; your brief says `/api/taattachment/view`, set the variable if that is the route you run). The browser fetches it with the token + cookies and shows it from a blob URL; every path segment is percent-encoded.
- **The view route must authorise TA_ files** (owner, or an approver of the request the file belongs to); see the security notes in `docs/07-integration-plan.md`.

## Open decisions for the business owner (behaviour carried over from the prototype)
1. Nothing ever sets an advance to **settled**, so approved advances count as outstanding forever. A settlement SP/process is needed (not part of the UI yet).
2. A travel request's advance and its linked advance request are **both** counted against the ₹15,000 limit (double count).
3. "Needs attention" is > 3 days on the dashboard but > 5 days for "Oldest waiting" on Approvals.
4. All policy figures (rates, limits, medical annual limit, advance limit) are placeholders from the prototype.
5. `#/approvals` has no link in the original UI (reachable only by URL).
