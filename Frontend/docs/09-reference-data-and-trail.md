# Reference data (expense types, items, fields, lists) and the approval trail

## Where the expense types and items live
Not in the app. The app reads them at start-up from `TA_usp_GetReferenceData`, which returns:

| Part | Table | Notes |
|---|---|---|
| Field definitions | `TA_FieldDef` | label, input type, required, computed, full width, read-only, option list (`OptionsKey`), placeholder, helper, min, step, display order |
| Expense types | `TA_ExpenseType` | label, short label, colour family, description, `ShowBalance` (medical balance), `TravelPeriod` (outside travel dates), order |
| Expense items | `TA_ExpenseItem` | label, `FieldList` (a JSON array of field keys **in display order**), `Compute` + `RateKey` (fuel by km), `LimitAmount`/`LimitPer`/`LimitQty`, `EnforceEligibility` (`Y` blocks amounts over eligibility; `N` allows them and flags them in the claim line grid), `IsFixed` (a column of the date-wise grid), `AttachmentOptional`, helper, order |
| Option lists | `TA_Lookup` | `MODES`, `CITIES`, `GST_STATES`, `TRAVEL_PURPOSE`, `ESTIMATE_ITEM` (cost centres come from the employee view) |

The first install is seeded by `sql/TA/02_seed_reference.sql`; that file is now maintained by hand (the generator is gone). Re-running it refreshes definitions but never overwrites limits, lookup values or settings that were edited in the database.

### Changing it
```sql
-- raise the lodge limit
UPDATE dbo.TA_ExpenseItem SET LimitAmount = 3500 WHERE ItemKey = N'o_lodge';
-- block claims over the configured eligibility for one item
UPDATE dbo.TA_ExpenseItem SET EnforceEligibility = N'Y' WHERE ItemKey = N'o_lodge';
-- add a city or a travel mode
INSERT dbo.TA_Lookup (ListKey, Value, SortOrder) VALUES (N'CITIES', N'Trichy', 40);
-- add GST details to an existing item where required (the keys determine display order)
UPDATE dbo.TA_ExpenseItem
SET FieldList = N'["date","billerName","billNumber","gstNumber","state","igst","cgst","sgst","amount","remarks","attachment"]'
WHERE ItemKey = N's_med_lab';
-- add a new item that uses fields the app already knows
INSERT dbo.TA_ExpenseItem (ItemKey, TypeKey, Label, ShortLabel, FieldList, IsFixed, AttachmentOptional, SortOrder)
VALUES (N'o_visa', N'outside', N'Visa Fees', N'Visa', N'["date","billerName","billNumber","gstNumber","state","igst","cgst","sgst","amount","remarks","attachment"]', 0, 0, 20);
```
Users see the change the next time the app starts. **What a database change cannot do:** introduce a field the screens do not know how to draw. The known keys are `date, fromDate, toDate, fromTime, toTime, time, modeOfTravel, stayLocation, fromLocation, toLocation, billerName, billNumber, fromKm, toKm, totalKm, nonAccountableKm, qty, amount, limit, remarks, alongWith, gstNumber, state, igst, cgst, sgst, attachment`; a new key needs a screen change.

All seeded expense items include `gstNumber` (text), `state` (select using the `GST_STATES` list), and `igst`, `cgst`, `sgst` (non-negative numeric inputs). Approvers can correct these values in the claim multiline; the state editor uses the same `GST_STATES` list. Remove the GST keys from an item's `FieldList` if that item should not capture GST. New expense items must include the keys in their `FieldList` when GST capture is required.

### What happens when the data is wrong
The app refuses to start and says why (for example: an item that uses a field with no definition, an item defined twice, no expense types at all) instead of drawing broken screens. Existing requests whose type or item was removed will not render their lines properly, so deactivate rather than delete in a live database.

### Server side
`TA_usp_SubmitRequest` validates a line from the same tables (required fields from `TA_FieldDef`, the item's `FieldList`, whether a bill is required), so the browser and the database cannot disagree.

## Approval trail
`TA_usp_GetApprovalTrail { Kind, Id }` returns `[{ action, actedBy, actedByName, actedAt, details }]`, oldest first:

| Action | Source |
|---|---|
| Created | the request itself (so older requests have it too) |
| Submitted, Approved, Rejected, Copied | `TA_RequestHistory`; `details` holds the approver comments (claims), remarks (travel/advance) or the rejection reason |

Saves and deletes are not part of the trail. It is allowed in both views for any request the caller can see (an employee: their own; an approver: every submitted request).

In the app
- **Lists and approvals history:** the Status column shows the badge, a one-line summary (`Awaiting approval · 3 days`, `by Priya Natarajan · 22 Sep`) and a clock icon that opens the trail. Drafts show neither.
- **Forms (claim, travel, advance):** an "Approval trail" button in the page header once the request has a number.
- **Mobile cards:** the summary line only (a card is one link, so there is no nested button).
- While a request is with the approver the dialog ends with a "Waiting for an approver" step.
