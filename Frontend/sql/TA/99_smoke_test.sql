-- Travel Claim (TA_) smoke test. Run on a DEVELOPMENT database after 01..08 (it needs the dev stub view). NOT for production.
-- It creates its own users T9001 (employee) and T9002 (approver), exercises the main flows through the real procedures with the same JSON the API sends,
-- and removes everything it created (also at the start, so a failed run can be repeated). Any failed check stops the script with: FAIL <n>: <what>.
-- Side effect: it consumes one TR/AR number of the current year in TA_Counter (global counters cannot be given back).
SET NOCOUNT ON;
GO

/* run a procedure and capture its single JsonResult value */
CREATE OR ALTER PROCEDURE dbo.TA_zz_Call @Sp NVARCHAR(128), @Json NVARCHAR(MAX), @Out NVARCHAR(MAX) OUTPUT AS
BEGIN
  SET NOCOUNT ON;
  CREATE TABLE #R (JsonResult NVARCHAR(MAX) NULL);
  DECLARE @sql NVARCHAR(400) = N'EXEC dbo.' + QUOTENAME(@Sp) + N' @JsonParam = @p';
  INSERT #R EXEC sys.sp_executesql @sql, N'@p NVARCHAR(MAX)', @p = @Json;
  SET @Out = (SELECT TOP (1) JsonResult FROM #R);
END
GO
/* run a procedure that must FAIL: the message must start with @Prefix (e.g. [VALIDATION]) and contain @Contains */
CREATE OR ALTER PROCEDURE dbo.TA_zz_Expect @Sp NVARCHAR(128), @Json NVARCHAR(MAX), @Prefix NVARCHAR(20), @Contains NVARCHAR(200) AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @msg NVARCHAR(4000) = NULL, @sql NVARCHAR(400) = N'EXEC dbo.' + QUOTENAME(@Sp) + N' @JsonParam = @p';
  BEGIN TRY
    EXEC sys.sp_executesql @sql, N'@p NVARCHAR(MAX)', @p = @Json;
  END TRY
  BEGIN CATCH
    SET @msg = ERROR_MESSAGE();
  END CATCH
  IF @msg IS NULL THROW 51000, N'FAIL: the call was expected to fail but succeeded', 1;
  IF LEFT(@msg, LEN(@Prefix)) <> @Prefix OR (@Contains IS NOT NULL AND @msg NOT LIKE N'%' + @Contains + N'%')
    THROW 51000, N'FAIL: an error was expected but with a different message (see below)', 1;
END
GO
CREATE OR ALTER PROCEDURE dbo.TA_zz_Cleanup AS
BEGIN
  SET NOCOUNT ON;
  UPDATE dbo.TA_Receipt SET UsedInRequestId = NULL, UsedInLineId = NULL WHERE OwnerCode IN (N'T9001', N'T9002');
  DELETE dbo.TA_Request WHERE EmployeeCode IN (N'T9001', N'T9002') OR CreatedBy IN (N'T9001', N'T9002');
  DELETE dbo.TA_Receipt WHERE OwnerCode IN (N'T9001', N'T9002');
  DELETE dbo.TA_Attachment WHERE OwnerCode IN (N'T9001', N'T9002');
  DELETE dbo.TA_RequestHistory WHERE ActedBy IN (N'T9001', N'T9002');
  DELETE dbo.TA_Counter WHERE CounterKey LIKE N'CLAIM:T900_:%';
  DELETE dbo.TA_Approver WHERE EmployeeCode = N'T9002';
  DELETE dbo.TA_EmployeeStub WHERE EmployeeCode IN (N'T9001', N'T9002');
END
GO

EXEC dbo.TA_zz_Cleanup;
INSERT dbo.TA_EmployeeStub (EmployeeCode, Name, Department, Designation, CostCentre, Grade) VALUES
  (N'T9001', N'Smoke Employee', N'QA', N'Tester', N'CC-TEST', N'G1'), (N'T9002', N'Smoke Approver', N'QA', N'Lead', N'CC-TEST', N'G5');
INSERT dbo.TA_Approver (EmployeeCode, AddedBy) VALUES (N'T9002', N'smoke-test');
GO

DECLARE @today NVARCHAR(10) = CONVERT(CHAR(10), SYSDATETIME(), 23), @yr NVARCHAR(4) = CONVERT(NVARCHAR(4), YEAR(SYSDATETIME())), @future NVARCHAR(10) = CONVERT(CHAR(10), DATEADD(DAY, 5, SYSDATETIME()), 23);
-- The server adds ExecutedBy; EXEC arguments must be variables, so every call's JSON is built into @in first.
DECLARE @E0 NVARCHAR(MAX) = N'{"ExecutedBy":"T9001"}', @A0 NVARCHAR(MAX) = N'{"ExecutedBy":"T9002"}', @e NVARCHAR(MAX) = N'{"ExecutedBy":"T9001"', @a NVARCHAR(MAX) = N'{"ExecutedBy":"T9002"';
DECLARE @noR NVARCHAR(40), @r NVARCHAR(MAX), @in NVARCHAR(MAX), @id NVARCHAR(64), @id2 NVARCHAR(64), @idR NVARCHAR(64), @idM NVARCHAR(64), @idA NVARCHAR(64), @idT NVARCHAR(64), @no NVARCHAR(40), @no2 NVARCHAR(40), @rcpt NVARCHAR(64), @none NVARCHAR(MAX) = N'{"ExecutedBy":"NOBODY"}', @empty NVARCHAR(MAX) = N'{}';
DECLARE @claimHead NVARCHAR(MAX) = N',"Kind":"claim","Request":{', @daLine NVARCHAR(MAX) = N'"items":[{"id":"l1","itemKey":"l_da","fields":{"date":"' + @today + N'","amount":250},"attachments":[]}]}}';

/* 1. session, roles */
EXEC dbo.TA_zz_Call N'TA_usp_GetSession', @E0, @r OUTPUT;
IF JSON_VALUE(@r, '$.schema."07_procs_receipts"') IS NULL OR JSON_VALUE(@r, '$.schema."01_tables"') IS NULL THROW 51000, N'FAIL 1z: the session reports the installed script revisions', 1;
IF JSON_VALUE(@r, '$.role') <> N'employee' OR JSON_VALUE(@r, '$.name') <> N'Smoke Employee' OR JSON_VALUE(@r, '$.isApprover') <> N'false' THROW 51000, N'FAIL 1a: employee session', 1;
EXEC dbo.TA_zz_Call N'TA_usp_GetSession', @A0, @r OUTPUT;
IF JSON_VALUE(@r, '$.role') <> N'admin' OR JSON_VALUE(@r, '$.isApprover') <> N'true' THROW 51000, N'FAIL 1b: an approver has role admin and isApprover=true (the app then offers the Employee/Approver view switch)', 1;
EXEC dbo.TA_zz_Expect N'TA_usp_GetSession', @none, N'[FORBIDDEN]', NULL;
EXEC dbo.TA_zz_Expect N'TA_usp_GetSession', @empty, N'[UNAUTHORIZED]', NULL;

/* 2. policy */
EXEC dbo.TA_zz_Call N'TA_usp_GetPolicy', @E0, @r OUTPUT;
IF ISJSON(@r) <> 1 OR JSON_VALUE(@r, '$.policy.medicalAnnualLimit') IS NULL OR JSON_VALUE(@r, '$.policy.allowSelfApproval') IS NULL THROW 51000, N'FAIL 2a: policy json', 1;
IF JSON_QUERY(@r, '$.itemLimits') IS NOT NULL THROW 51000, N'FAIL 2b: item limits are reference data now, not part of the policy', 1;

/* 2c. reference data: types, items (field order, limits), field definitions, option lists */
EXEC dbo.TA_zz_Call N'TA_usp_GetReferenceData', @E0, @r OUTPUT;
IF ISJSON(@r) <> 1 OR (SELECT COUNT(*) FROM OPENJSON(@r, '$.types')) <> 5 OR (SELECT COUNT(*) FROM OPENJSON(@r, '$.fields')) < 20 THROW 51000, N'FAIL 2c: reference data shape', 1;
IF JSON_VALUE(@r, '$.types[4].key') <> N'outside' OR JSON_VALUE(@r, '$.types[4].items[1].key') <> N'o_lodge' OR JSON_VALUE(@r, '$.types[4].items[1].fields[1]') <> N'stayLocation'
   OR CAST(JSON_VALUE(@r, '$.types[4].items[1].limit') AS DECIMAL(18,2)) <> 3000 OR JSON_VALUE(@r, '$.types[4].items[1].limitPer') <> N'night'
  THROW 51000, N'FAIL 2d: items come in display order with their field order and limits', 1;
IF JSON_VALUE(@r, '$.lookups.MODES[0]') IS NULL OR JSON_VALUE(@r, '$.lookups.CITIES[0]') IS NULL OR JSON_VALUE(@r, '$.lookups.TRAVEL_PURPOSE[0]') IS NULL OR JSON_VALUE(@r, '$.lookups.ESTIMATE_ITEM[0]') IS NULL
  THROW 51000, N'FAIL 2e: option lists', 1;
IF NOT EXISTS (SELECT 1 FROM OPENJSON(@r, '$.lookups.COST_CENTRE') WHERE [value] = N'CC-TEST') THROW 51000, N'FAIL 2f: cost centres come from the employee view', 1;
/* 3. save: the server assigns the number; client id, number and status are ignored; re-save keeps the number */
SET @in = @e + @claimHead + N'"id":"not-a-guid","requestNumber":"HACK/1","status":"approved","employeeCode":"T9001","costCentre":"CC-TEST","requestDate":"' + @today + N'","expenseType":"local","purpose":"Smoke test","employeeComments":"",' + @daLine;
EXEC dbo.TA_zz_Call N'TA_usp_SaveRequestDraft', @in, @r OUTPUT;
SET @id = JSON_VALUE(@r, '$.id'); SET @no = JSON_VALUE(@r, '$.requestNumber');
IF ISJSON(@r) <> 1 OR JSON_VALUE(@r, '$.status') <> N'draft' THROW 51000, N'FAIL 3a: a saved request is a draft', 1;
IF @no NOT LIKE N'T9001/' + @yr + N'/%' THROW 51000, N'FAIL 3b: number format EMPCODE/YYYY/NNNN', 1;
IF JSON_VALUE(@r, '$.items[0].fields.amount') <> N'250' OR JSON_VALUE(@r, '$.items[0].approvedAmount') IS NOT NULL THROW 51000, N'FAIL 3c: line amount; an undecided approved amount must be null', 1;
SET @in = @e + @claimHead + N'"id":"' + @id + N'","employeeCode":"T9001","costCentre":"CC-TEST","requestDate":"' + @today + N'","expenseType":"local","purpose":"Smoke test edited","employeeComments":"",' + @daLine;
EXEC dbo.TA_zz_Call N'TA_usp_SaveRequestDraft', @in, @r OUTPUT;
IF JSON_VALUE(@r, '$.requestNumber') <> @no OR JSON_VALUE(@r, '$.purpose') <> N'Smoke test edited' THROW 51000, N'FAIL 3d: re-save keeps the number and updates the text', 1;
SET @in = @a + N',"Kind":"claim","Id":"' + @id + N'"}';
EXEC dbo.TA_zz_Expect N'TA_usp_GetRequest', @in, N'[NOT_FOUND]', NULL;     -- an approver does not see someone else's DRAFT
SET @in = @e + @claimHead + N'"employeeCode":"T9001","requestDate":"' + @today + N'","expenseType":"local","purpose":"","items":[]}}';
EXEC dbo.TA_zz_Call N'TA_usp_SaveRequestDraft', @in, @r OUTPUT;
SET @id2 = JSON_VALUE(@r, '$.id'); SET @no2 = JSON_VALUE(@r, '$.requestNumber');
IF CAST(RIGHT(@no2, 4) AS INT) <> CAST(RIGHT(@no, 4) AS INT) + 1 THROW 51000, N'FAIL 3e: numbers increase by one', 1;
SET @in = @e + @claimHead + N'"employeeCode":"T9002","requestDate":"' + @today + N'","expenseType":"local","purpose":"x","items":[]}}';
EXEC dbo.TA_zz_Call N'TA_usp_SaveRequestDraft', @in, @r OUTPUT;
IF JSON_VALUE(@r, '$.employeeCode') <> N'T9001' THROW 51000, N'FAIL 3f: an employee always saves for themself', 1;
SET @in = @e + @claimHead + N'"requestDate":"' + @future + N'","expenseType":"local","purpose":"x","items":[]}}';
EXEC dbo.TA_zz_Expect N'TA_usp_SaveRequestDraft', @in, N'[VALIDATION]', N'Cannot be in the future';

/* 4. submit validation lists every problem; a valid claim submits once and is then read-only */
SET @in = @e + N',"Kind":"claim","Id":"' + @id2 + N'"}';
EXEC dbo.TA_zz_Expect N'TA_usp_SubmitRequest', @in, N'[VALIDATION]', N'Purpose: Required to submit';
EXEC dbo.TA_zz_Expect N'TA_usp_SubmitRequest', @in, N'[VALIDATION]', N'Add at least one expense line';
SET @in = @e + N',"Kind":"claim","Id":"' + @id + N'"}';
EXEC dbo.TA_zz_Call N'TA_usp_SubmitRequest', @in, @r OUTPUT;
IF JSON_VALUE(@r, '$.status') <> N'submitted' OR JSON_VALUE(@r, '$.submittedOn') <> @today THROW 51000, N'FAIL 4a: submit', 1;
EXEC dbo.TA_zz_Expect N'TA_usp_SubmitRequest', @in, N'[CONFLICT]', N'Only drafts';
SET @in = @e + @claimHead + N'"id":"' + @id + N'","employeeCode":"T9001","requestDate":"' + @today + N'","expenseType":"local","purpose":"tamper","items":[]}}';
EXEC dbo.TA_zz_Expect N'TA_usp_SaveRequestDraft', @in, N'[CONFLICT]', N'Only drafts can be edited';

/* 5. fuel by kilometres is computed on the server, whatever the client sends */
SET @in = @e + @claimHead + N'"employeeCode":"T9001","requestDate":"' + @today + N'","expenseType":"fuel","purpose":"Site visits","items":[{"id":"f1","itemKey":"l_fuel_4w","fields":{"date":"' + @today
        + N'","fromLocation":"A","toLocation":"B","fromKm":100,"toKm":142,"nonAccountableKm":2,"amount":99999,"totalKm":1},"attachments":[]}]}}';
EXEC dbo.TA_zz_Call N'TA_usp_SaveRequestDraft', @in, @r OUTPUT;
IF JSON_VALUE(@r, '$.items[0].fields.totalKm') <> N'42' OR CAST(JSON_VALUE(@r, '$.items[0].fields.amount') AS DECIMAL(18,2)) <> 360 THROW 51000, N'FAIL 5: fuel amount must be (42 - 2) km x 9 = 360', 1;

/* 6. approvals: approvers only; every line needs an approved amount within the claimed amount */
SET @in = @e + N',"Kind":"claim","Id":"' + @id + N'"}';
EXEC dbo.TA_zz_Expect N'TA_usp_ApproveRequest', @in, N'[FORBIDDEN]', NULL;
EXEC dbo.TA_zz_Expect N'TA_usp_ListPendingApprovals', @E0, N'[FORBIDDEN]', NULL;
EXEC dbo.TA_zz_Call N'TA_usp_ListPendingApprovals', @A0, @r OUTPUT;
IF CHARINDEX(@no, @r) = 0 THROW 51000, N'FAIL 6a: the submitted claim is in the approver queue', 1;
SET @in = @a + N',"Kind":"claim","Id":"' + @id + N'"}';
EXEC dbo.TA_zz_Expect N'TA_usp_ApproveRequest', @in, N'[VALIDATION]', N'Approved Amount';
SET @in = @a + N',"Kind":"claim","Id":"' + @id + N'","Lines":[{"id":"l1","approvedAmount":251,"approverRemarks":""}]}';
EXEC dbo.TA_zz_Expect N'TA_usp_ApproveRequest', @in, N'[VALIDATION]', N'Approved Amount';
SET @in = @a + N',"Kind":"claim","Id":"' + @id + N'","Lines":[{"id":"l1","approvedAmount":200,"approverRemarks":"Capped"}],"ApproverComments":"ok"}';
EXEC dbo.TA_zz_Call N'TA_usp_ApproveRequest', @in, @r OUTPUT;
IF JSON_VALUE(@r, '$.status') <> N'approved' OR JSON_VALUE(@r, '$.approver') <> N'Smoke Approver' OR CAST(JSON_VALUE(@r, '$.items[0].approvedAmount') AS DECIMAL(18,2)) <> 200 OR JSON_VALUE(@r, '$.approvedOn') <> @today
  THROW 51000, N'FAIL 6b: approve sets status, approver, date and the line amount', 1;
EXEC dbo.TA_zz_Expect N'TA_usp_ApproveRequest', @in, N'[CONFLICT]', N'Only submitted';

/* 7. reject needs a reason, undecided lines become 0; the owner can copy a rejected claim, an approver cannot */
SET @in = @e + @claimHead + N'"employeeCode":"T9001","requestDate":"' + @today + N'","expenseType":"local","purpose":"To be rejected","employeeComments":"",' + @daLine;
EXEC dbo.TA_zz_Call N'TA_usp_SaveRequestDraft', @in, @r OUTPUT;
SET @idR = JSON_VALUE(@r, '$.id'); SET @noR = JSON_VALUE(@r, '$.requestNumber');
SET @in = @e + N',"Kind":"claim","Id":"' + @idR + N'"}';
EXEC dbo.TA_zz_Call N'TA_usp_SubmitRequest', @in, @r OUTPUT;
SET @in = @a + N',"Kind":"claim","Id":"' + @idR + N'","RejectionReason":"  "}';
EXEC dbo.TA_zz_Expect N'TA_usp_RejectRequest', @in, N'[VALIDATION]', N'Rejection Reason';
SET @in = @a + N',"Kind":"claim","Id":"' + @idR + N'","RejectionReason":"Missing bill"}';
EXEC dbo.TA_zz_Call N'TA_usp_RejectRequest', @in, @r OUTPUT;
IF JSON_VALUE(@r, '$.status') <> N'rejected' OR JSON_VALUE(@r, '$.rejectionReason') <> N'Missing bill' OR CAST(JSON_VALUE(@r, '$.items[0].approvedAmount') AS DECIMAL(18,2)) <> 0 THROW 51000, N'FAIL 7a: reject', 1;
SET @in = @e + N',"Id":"' + @idR + N'"}';
EXEC dbo.TA_zz_Call N'TA_usp_CopyRejectedClaim', @in, @r OUTPUT;
IF JSON_VALUE(@r, '$.status') <> N'draft' OR JSON_VALUE(@r, '$.requestNumber') = @noR OR JSON_VALUE(@r, '$.items[0].approvedAmount') IS NOT NULL OR JSON_VALUE(@r, '$.purpose') <> N'To be rejected' OR JSON_VALUE(@r, '$.rejectionReason') <> N''
  THROW 51000, N'FAIL 7b: a copy is a fresh draft with the same lines and no approvals', 1;
SET @in = @a + N',"Id":"' + @idR + N'"}';
EXEC dbo.TA_zz_Expect N'TA_usp_CopyRejectedClaim', @in, N'[FORBIDDEN]', NULL;

/* 8. receipt box: upload registration rules, create, edit, single use */
SET @in = @e + N',"DocType":"TA_RECEIPT","FileName":"bill.pdf","MimeType":"application/pdf","Size":1000,"StoredFileName":"T9001_smoke_1.pdf"}';
EXEC dbo.TA_zz_Call N'TA_usp_UploadAttachment', @in, @r OUTPUT;
IF JSON_VALUE(@r, '$.storedFileName') <> N'T9001_smoke_1.pdf' THROW 51000, N'FAIL 8a: upload registration', 1;
SET @in = @e + N',"DocType":"TA_RECEIPT","FileName":"run.exe","MimeType":"application/pdf","Size":1000,"StoredFileName":"x.exe"}';
EXEC dbo.TA_zz_Expect N'TA_usp_UploadAttachment', @in, N'[VALIDATION]', N'PDF, JPG or PNG';
SET @in = @e + N',"DocType":"TA_RECEIPT","FileName":"big.pdf","MimeType":"application/pdf","Size":99999999,"StoredFileName":"y.pdf"}';
EXEC dbo.TA_zz_Expect N'TA_usp_UploadAttachment', @in, N'[VALIDATION]', N'larger than 5 MB';
SET @in = @e + N',"Files":[{"FileId":"T9001_smoke_1.pdf","DocType":"TA_RECEIPT","Name":"bill.pdf","Size":1000,"Type":"application/pdf"}]}';
EXEC dbo.TA_zz_Call N'TA_usp_CreateReceipts', @in, @r OUTPUT;
SET @rcpt = JSON_VALUE(@r, '$[0].id');
IF @rcpt IS NULL OR JSON_VALUE(@r, '$[0].file.name') <> N'bill.pdf' OR JSON_VALUE(@r, '$[0].usedIn') IS NOT NULL THROW 51000, N'FAIL 8b: create receipt', 1;
EXEC dbo.TA_zz_Expect N'TA_usp_CreateReceipts', @in, N'[CONFLICT]', N'already in your receipt box';
EXEC dbo.TA_zz_Expect N'TA_usp_ListReceipts', @A0, N'[FORBIDDEN]', NULL;
SET @in = @e + N',"Receipt":{"id":"' + @rcpt + N'","date":"' + @today + N'","billerName":"Cafe","billNumber":"B-1","amount":120,"notes":""}}';
EXEC dbo.TA_zz_Call N'TA_usp_UpdateReceipt', @in, @r OUTPUT;
IF CAST(JSON_VALUE(@r, '$.amount') AS DECIMAL(18,2)) <> 120 OR JSON_VALUE(@r, '$.billerName') <> N'Cafe' THROW 51000, N'FAIL 8c: update receipt', 1;
SET @in = @e + N',"Receipt":{"id":"' + @rcpt + N'","date":"' + @future + N'","billerName":"Cafe","billNumber":"B-1","amount":120,"notes":""}}';
EXEC dbo.TA_zz_Expect N'TA_usp_UpdateReceipt', @in, N'[VALIDATION]', N'future';
-- put it on a claim line
SET @in = @e + @claimHead + N'"employeeCode":"T9001","requestDate":"' + @today + N'","expenseType":"local","purpose":"With a receipt","employeeComments":"","items":[{"id":"r1","itemKey":"l_food_lunch","fields":{"date":"' + @today
        + N'","billerName":"Cafe","amount":120},"attachments":[{"receiptId":"' + @rcpt + N'","name":"bill.pdf"}]}]}}';
EXEC dbo.TA_zz_Call N'TA_usp_SaveRequestDraft', @in, @r OUTPUT;
SET @idM = JSON_VALUE(@r, '$.id');
IF JSON_VALUE(@r, '$.items[0].attachments[0].receiptId') <> @rcpt THROW 51000, N'FAIL 8d: the receipt is shown on the line', 1;
EXEC dbo.TA_zz_Call N'TA_usp_ListReceipts', @E0, @r OUTPUT;
IF JSON_VALUE(@r, '$[0].usedIn.requestNumber') IS NULL THROW 51000, N'FAIL 8e: the receipt knows which claim uses it', 1;
SET @in = @e + @claimHead + N'"employeeCode":"T9001","requestDate":"' + @today + N'","expenseType":"local","purpose":"Same receipt again","items":[{"id":"r2","itemKey":"l_food_lunch","fields":{"date":"' + @today
        + N'","amount":1},"attachments":[{"receiptId":"' + @rcpt + N'"}]}]}}';
EXEC dbo.TA_zz_Expect N'TA_usp_SaveRequestDraft', @in, N'[CONFLICT]', N'already on another claim';
SET @in = @e + N',"Receipt":{"id":"' + @rcpt + N'","date":"' + @today + N'","amount":1}}';
EXEC dbo.TA_zz_Expect N'TA_usp_UpdateReceipt', @in, N'[CONFLICT]', N'cannot be edited';
SET @in = @e + N',"Id":"' + @rcpt + N'"}';
EXEC dbo.TA_zz_Expect N'TA_usp_DeleteReceipt', @in, N'[CONFLICT]', N'cannot be deleted';
SET @in = @e + N',"Kind":"claim","Id":"' + @idM + N'"}';
EXEC dbo.TA_zz_Call N'TA_usp_DeleteDraft', @in, @r OUTPUT;                    -- deleting the draft frees the receipt
SET @in = @e + N',"Id":"' + @rcpt + N'"}';
EXEC dbo.TA_zz_Call N'TA_usp_DeleteReceipt', @in, @r OUTPUT;

/* 9. uploaded file on a line; medical annual balance; who may open a file */
SET @in = @e + N',"DocType":"TA_CLAIM","FileName":"rx.pdf","MimeType":"application/pdf","Size":2000,"StoredFileName":"T9001_smoke_2.pdf"}';
EXEC dbo.TA_zz_Call N'TA_usp_UploadAttachment', @in, @r OUTPUT;
SET @in = @e + @claimHead + N'"employeeCode":"T9001","costCentre":"CC-TEST","requestDate":"' + @today + N'","expenseType":"medical","purpose":"Treatment","employeeComments":"","items":[{"id":"m1","itemKey":"s_med_rx","fields":{"date":"' + @today
        + N'","billerName":"Pharmacy","amount":99999},"attachments":[{"fileId":"T9001_smoke_2.pdf","docType":"TA_CLAIM","name":"rx.pdf"}]}]}}';
EXEC dbo.TA_zz_Call N'TA_usp_SaveRequestDraft', @in, @r OUTPUT;
SET @idM = JSON_VALUE(@r, '$.id');
IF JSON_VALUE(@r, '$.items[0].attachments[0].fileId') <> N'T9001_smoke_2.pdf' THROW 51000, N'FAIL 9a: the uploaded file is linked to the line', 1;
SET @in = @e + N',"Kind":"claim","Id":"' + @idM + N'"}';
EXEC dbo.TA_zz_Expect N'TA_usp_SubmitRequest', @in, N'[VALIDATION]', N'exceeds the available medical balance';
SET @in = @e + N',"DocType":"TA_CLAIM","FileName":"T9001_smoke_2.pdf"}';
EXEC dbo.TA_zz_Call N'TA_usp_CanViewAttachment', @in, @r OUTPUT;
IF JSON_VALUE(@r, '$.allowed') <> N'true' THROW 51000, N'FAIL 9b: the owner may open the file', 1;
SET @in = @a + N',"DocType":"TA_CLAIM","FileName":"T9001_smoke_2.pdf"}';
EXEC dbo.TA_zz_Call N'TA_usp_CanViewAttachment', @in, @r OUTPUT;
IF JSON_VALUE(@r, '$.allowed') <> N'false' THROW 51000, N'FAIL 9c: an approver may not open a file of an unsubmitted draft', 1;

/* 10. advance: the limit counts pending advances */
SET @in = @e + N',"Kind":"advance","Request":{"employeeCode":"T9001","requestDate":"' + @today + N'","periodFrom":"' + @today + N'","periodTo":"' + @today + N'","amount":6000,"purpose":"Training","remarks":"","alongWith":"","createLeave":false,"travelRequest":"","attachments":[]}}';
EXEC dbo.TA_zz_Call N'TA_usp_SaveRequestDraft', @in, @r OUTPUT;
SET @idA = JSON_VALUE(@r, '$.id');
IF JSON_VALUE(@r, '$.requestNumber') NOT LIKE N'AR/' + @yr + N'/%' OR JSON_VALUE(@r, '$.settled') <> N'false' THROW 51000, N'FAIL 10a: advance number AR/YYYY/NNNN, not settled', 1;
SET @in = @e + N',"Kind":"advance","Id":"' + @idA + N'"}';
EXEC dbo.TA_zz_Call N'TA_usp_SubmitRequest', @in, @r OUTPUT;
SET @in = @e + N',"Kind":"advance","Request":{"employeeCode":"T9001","requestDate":"' + @today + N'","periodFrom":"' + @today + N'","periodTo":"' + @today + N'","amount":10000,"purpose":"Training","remarks":"","alongWith":"","createLeave":false,"travelRequest":"","attachments":[]}}';
EXEC dbo.TA_zz_Call N'TA_usp_SaveRequestDraft', @in, @r OUTPUT;
SET @in = @e + N',"Kind":"advance","Id":"' + JSON_VALUE(@r, '$.id') + N'"}';
EXEC dbo.TA_zz_Expect N'TA_usp_SubmitRequest', @in, N'[VALIDATION]', N'available advance balance';

/* 11. travel request: period format, estimate, advance rule, approval with remarks */
SET @in = @e + N',"Kind":"travel","Request":{"employeeCode":"T9001","requestDate":"' + @today + N'","purpose":"Training","remarks":"","fromLocation":"Chennai","toLocation":"Pune","periodFrom":"' + @today + N'T08:00","periodTo":"' + @today
        + N'T20:00","items":[{"id":"t1","item":"Ticket Fare","amount":5000,"remarks":""}],"advanceRequired":3000,"overallRemarks":"","alongWith":"","createLeave":true,"attachments":[]}}';
EXEC dbo.TA_zz_Call N'TA_usp_SaveRequestDraft', @in, @r OUTPUT;
SET @idT = JSON_VALUE(@r, '$.id');
IF JSON_VALUE(@r, '$.requestNumber') NOT LIKE N'TR/' + @yr + N'/%' OR JSON_VALUE(@r, '$.periodFrom') <> @today + N'T08:00' OR JSON_VALUE(@r, '$.createLeave') <> N'true' THROW 51000, N'FAIL 11a: travel header', 1;
SET @in = @e + N',"Kind":"travel","Id":"' + @idT + N'"}';
EXEC dbo.TA_zz_Call N'TA_usp_SubmitRequest', @in, @r OUTPUT;
SET @in = @a + N',"Kind":"travel","Id":"' + @idT + N'"}';
EXEC dbo.TA_zz_Expect N'TA_usp_RejectRequest', @in, N'[VALIDATION]', N'Approver Remarks';
SET @in = @a + N',"Kind":"travel","Id":"' + @idT + N'","ApproverRemarks":"Approved, keep the bills."}';
EXEC dbo.TA_zz_Call N'TA_usp_ApproveRequest', @in, @r OUTPUT;
IF JSON_VALUE(@r, '$.status') <> N'approved' OR JSON_VALUE(@r, '$.approverRemarks') <> N'Approved, keep the bills.' THROW 51000, N'FAIL 11b: travel approval', 1;

/* 12. lists: scope, search, paging */
SET @in = @e + N',"Kind":"claim"}';
EXEC dbo.TA_zz_Call N'TA_usp_ListRequests', @in, @r OUTPUT;
IF CAST(JSON_VALUE(@r, '$.total') AS INT) < 3 OR CHARINDEX(N'"employeeCode":"T9002"', @r) > 0 THROW 51000, N'FAIL 12a: an employee list holds only their own requests', 1;
SET @in = @e + N',"Kind":"claim","Search":"Smoke test edited"}';
EXEC dbo.TA_zz_Call N'TA_usp_ListRequests', @in, @r OUTPUT;
IF CAST(JSON_VALUE(@r, '$.total') AS INT) <> 1 THROW 51000, N'FAIL 12b: search by purpose', 1;
SET @in = @e + N',"Kind":"claim","EmployeeCode":"T9002"}';          -- an employee cannot widen the scope with a filter
EXEC dbo.TA_zz_Call N'TA_usp_ListRequests', @in, @r OUTPUT;
IF CHARINDEX(N'"employeeCode":"T9002"', @r) > 0 THROW 51000, N'FAIL 12c: the employee filter is ignored for employees', 1;
SET @in = @e + N',"Kind":"claim","Page":1,"PageSize":1,"SortKey":"requestNumber","SortDir":"asc"}';
EXEC dbo.TA_zz_Call N'TA_usp_ListRequests', @in, @r OUTPUT;
IF (SELECT COUNT(*) FROM OPENJSON(@r, '$.rows')) <> 1 OR CAST(JSON_VALUE(@r, '$.total') AS INT) < 3 THROW 51000, N'FAIL 12d: paging returns one row and the full total', 1;
SET @in = @e + N',"Kind":"claim","SortKey":"requestNumber; DROP TABLE dbo.TA_Request","SortDir":"asc"}';   -- a sort key is never concatenated into SQL
EXEC dbo.TA_zz_Call N'TA_usp_ListRequests', @in, @r OUTPUT;
IF ISJSON(@r) <> 1 OR OBJECT_ID(N'dbo.TA_Request', N'U') IS NULL THROW 51000, N'FAIL 12e: an unknown sort key is ignored', 1;

/* 13. audit trail */
IF (SELECT COUNT(*) FROM dbo.TA_RequestHistory WHERE ActedBy = N'T9001' AND Action = N'Saved') < 3 OR NOT EXISTS (SELECT 1 FROM dbo.TA_RequestHistory WHERE ActedBy = N'T9002' AND Action = N'Approved')
  THROW 51000, N'FAIL 13: history rows are written for saves and approvals', 1;


/* 14. an approver can ALSO act as an employee (ActAs = employee): own claims, receipt box, copy; no approving. ActAs can only narrow, never grant. */
DECLARE @a2e NVARCHAR(MAX) = N'{"ExecutedBy":"T9002","ActAs":"employee"', @e2a NVARCHAR(MAX) = N'{"ExecutedBy":"T9001","ActAs":"approver"';
SET @in = @a2e + @claimHead + N'"employeeCode":"T9001","costCentre":"CC-TEST","requestDate":"' + @today + N'","expenseType":"local","purpose":"Approver own claim","employeeComments":"",' + @daLine;
EXEC dbo.TA_zz_Call N'TA_usp_SaveRequestDraft', @in, @r OUTPUT;
IF JSON_VALUE(@r, '$.employeeCode') <> N'T9002' OR JSON_VALUE(@r, '$.requestNumber') NOT LIKE N'T9002/' + @yr + N'/%' THROW 51000, N'FAIL 14a: in the employee view an approver saves for themself (the code they typed is ignored)', 1;
SET @in = @a2e + N',"Kind":"claim"}';
EXEC dbo.TA_zz_Call N'TA_usp_ListRequests', @in, @r OUTPUT;
IF CAST(JSON_VALUE(@r, '$.total') AS INT) <> 1 OR CHARINDEX(N'"employeeCode":"T9001"', @r) > 0 THROW 51000, N'FAIL 14b: the employee view lists only the approver''s own requests', 1;
SET @in = @a2e + N'}';
EXEC dbo.TA_zz_Call N'TA_usp_ListReceipts', @in, @r OUTPUT;      -- the receipt box works in the employee view (it is refused in the approver view, tested above)
IF ISJSON(@r) <> 1 THROW 51000, N'FAIL 14c: receipt box in the employee view', 1;
SET @in = @a2e + N',"Kind":"claim","Id":"' + @id2 + N'"}';
EXEC dbo.TA_zz_Expect N'TA_usp_ApproveRequest', @in, N'[FORBIDDEN]', NULL;                  -- approving needs the approver view
SET @in = @a2e + N'}';
EXEC dbo.TA_zz_Expect N'TA_usp_ListPendingApprovals', @in, N'[FORBIDDEN]', NULL;
SET @in = @e2a + N'}';                                            -- a plain employee cannot claim to be an approver
EXEC dbo.TA_zz_Expect N'TA_usp_ListPendingApprovals', @in, N'[FORBIDDEN]', NULL;

/* 15. approval trail: created, submitted and the decision with its text; visible in both views; strangers cannot see it */
SET @in = @e + N',"Kind":"claim","Id":"' + @id + N'"}';
EXEC dbo.TA_zz_Call N'TA_usp_GetApprovalTrail', @in, @r OUTPUT;
IF (SELECT COUNT(*) FROM OPENJSON(@r)) <> 3 OR JSON_VALUE(@r, '$[0].action') <> N'Created' OR JSON_VALUE(@r, '$[1].action') <> N'Submitted' OR JSON_VALUE(@r, '$[2].action') <> N'Approved'
   OR JSON_VALUE(@r, '$[2].actedByName') <> N'Smoke Approver' OR JSON_VALUE(@r, '$[2].details') <> N'ok' OR JSON_VALUE(@r, '$[0].actedBy') <> N'T9001'
  THROW 51000, N'FAIL 15a: an approved claim shows created, submitted and approved (with the approver comment)', 1;
SET @in = @a + N',"Kind":"claim","Id":"' + @idR + N'"}';
EXEC dbo.TA_zz_Call N'TA_usp_GetApprovalTrail', @in, @r OUTPUT;
IF (SELECT COUNT(*) FROM OPENJSON(@r)) <> 3 OR JSON_VALUE(@r, '$[2].action') <> N'Rejected' OR JSON_VALUE(@r, '$[2].details') <> N'Missing bill'
  THROW 51000, N'FAIL 15b: a rejected claim shows who rejected it and why (approver view)', 1;
SET @in = @e + N',"Kind":"claim","Id":"' + @id2 + N'"}';
EXEC dbo.TA_zz_Call N'TA_usp_GetApprovalTrail', @in, @r OUTPUT;
IF (SELECT COUNT(*) FROM OPENJSON(@r)) <> 1 OR JSON_VALUE(@r, '$[0].action') <> N'Created' THROW 51000, N'FAIL 15c: a draft has only its creation', 1;
SET @in = @a2e + N',"Kind":"claim","Id":"' + @id + N'"}';
EXEC dbo.TA_zz_Expect N'TA_usp_GetApprovalTrail', @in, N'[NOT_FOUND]', NULL;      -- an approver in the Employee view cannot see another employee's request

PRINT N'TA_ smoke test: ALL CHECKS PASSED';
GO
EXEC dbo.TA_zz_Cleanup;
DROP PROCEDURE dbo.TA_zz_Cleanup;
DROP PROCEDURE dbo.TA_zz_Expect;
DROP PROCEDURE dbo.TA_zz_Call;
GO
