-- Travel Claim (TA_) procedures, part 3: approvals.  Run after 05. Re-runnable.
-- Approver = an active row in TA_Approver. Only SUBMITTED requests can be actioned. Self-approval is controlled by TA_Setting 'AllowSelfApproval'.
SET NOCOUNT ON;
GO

/* Approve: { Kind, Id, Lines?, ApproverComments?, ApproverRemarks? }
   Claims: EVERY line needs an approved amount 0 <= amount <= claimed. GST corrections are restricted to GST fields configured on that line. */
CREATE OR ALTER PROCEDURE dbo.TA_usp_ApproveRequest @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  DECLARE @asApprover BIT = dbo.TA_fn_ActsAsApprover(@JsonParam);   -- the VIEW this call acts in (see TA_fn_ActsAsApprover)
  IF @asApprover = 0 THROW 50000, N'[FORBIDDEN] Only approvers can approve or reject', 1;
  DECLARE @id UNIQUEIDENTIFIER = TRY_CONVERT(UNIQUEIDENTIFIER, JSON_VALUE(@JsonParam, '$.Id'));
  DECLARE @kind NVARCHAR(10) = JSON_VALUE(@JsonParam, '$.Kind');
  DECLARE @status NVARCHAR(10), @code NVARCHAR(30), @number NVARCHAR(40);
  SELECT @status = r.Status, @code = r.EmployeeCode, @number = r.RequestNumber
  FROM dbo.TA_Request r JOIN dbo.TA_fn_Visible(@me, @asApprover) v ON v.RequestId = r.RequestId WHERE r.RequestId = @id AND r.Kind = @kind;
  IF @status IS NULL THROW 50000, N'[NOT_FOUND] Record not found', 1;
  IF @status <> N'submitted' THROW 50000, N'[CONFLICT] Only submitted requests can be actioned', 1;
  IF @code = @me AND ISNULL(dbo.TA_fn_Setting(N'AllowSelfApproval'), N'Y') = N'N' THROW 50000, N'[FORBIDDEN] You cannot approve your own request', 1;

  DECLARE @name NVARCHAR(100) = (SELECT Name FROM dbo.TA_vw_Employee WHERE EmployeeCode = @me);
  DECLARE @today DATE = dbo.TA_fn_Today();
  DECLARE @comments NVARCHAR(MAX), @remarks NVARCHAR(MAX);
  SELECT @comments = ISNULL(h.approverComments, N''), @remarks = ISNULL(h.approverRemarks, N'')
  FROM OPENJSON(@JsonParam) WITH (approverComments NVARCHAR(MAX) '$.ApproverComments', approverRemarks NVARCHAR(MAX) '$.ApproverRemarks') h;

  BEGIN TRAN;
  IF @kind = N'claim'
  BEGIN
    CREATE TABLE #Ap (LineId NVARCHAR(64) NOT NULL PRIMARY KEY, Amt DECIMAL(18,2) NULL, Rem NVARCHAR(500) NOT NULL, GstFields NVARCHAR(MAX) NULL);
    INSERT #Ap (LineId, Amt, Rem, GstFields)
    SELECT x.id, TRY_CAST(NULLIF(x.approvedAmount, N'') AS DECIMAL(18,2)), ISNULL(LEFT(x.approverRemarks, 500), N''), x.GstFields
    FROM OPENJSON(@JsonParam, '$.Lines') WITH (id NVARCHAR(64) '$.id', approvedAmount NVARCHAR(40) '$.approvedAmount', approverRemarks NVARCHAR(MAX) '$.approverRemarks', GstFields NVARCHAR(MAX) '$.gstFields' AS JSON) x;
    IF EXISTS (SELECT 1 FROM dbo.TA_ClaimLine l LEFT JOIN #Ap a ON a.LineId = l.LineId
               WHERE l.RequestId = @id AND (a.Amt IS NULL OR a.Amt < 0 OR a.Amt > l.Amount))
      THROW 50000, N'[VALIDATION] Approved Amount: enter a value between 0 and the claimed amount on every line.', 1;
    IF EXISTS (SELECT 1 FROM #Ap WHERE GstFields IS NOT NULL AND ISJSON(GstFields) <> 1)
      THROW 50000, N'[VALIDATION] GST corrections must be a JSON object.', 1;
    IF EXISTS (
      SELECT 1 FROM #Ap a CROSS APPLY OPENJSON(a.GstFields) g
      JOIN dbo.TA_ClaimLine l ON l.RequestId = @id AND l.LineId = a.LineId
      JOIN dbo.TA_ExpenseItem i ON i.ItemKey = l.ItemKey
      WHERE a.GstFields IS NOT NULL AND (
        g.[key] NOT IN (N'gstNumber', N'state', N'igst', N'cgst', N'sgst')
        OR NOT EXISTS (SELECT 1 FROM OPENJSON(i.FieldList) f WHERE f.value = g.[key])
      )
    ) THROW 50000, N'[VALIDATION] GST corrections may only update GST fields configured for that expense line.', 1;
    UPDATE l SET ApprovedAmount = CASE WHEN a.Amt IS NOT NULL THEN a.Amt ELSE l.ApprovedAmount END,
      ApproverRemarks = CASE WHEN a.Amt IS NOT NULL THEN a.Rem ELSE l.ApproverRemarks END, FieldsJson =
      CASE WHEN a.GstFields IS NULL THEN l.FieldsJson ELSE g5.FieldsJson END
    FROM dbo.TA_ClaimLine l
    JOIN #Ap a ON a.LineId = l.LineId
    JOIN dbo.TA_ExpenseItem i ON i.ItemKey = l.ItemKey
    CROSS APPLY (SELECT FieldsJson = CASE WHEN EXISTS (SELECT 1 FROM OPENJSON(a.GstFields) WHERE [key] = N'gstNumber') AND EXISTS (SELECT 1 FROM OPENJSON(i.FieldList) WHERE value = N'gstNumber') THEN JSON_MODIFY(l.FieldsJson, '$.gstNumber', JSON_VALUE(a.GstFields, '$.gstNumber')) ELSE l.FieldsJson END) g1
    CROSS APPLY (SELECT FieldsJson = CASE WHEN EXISTS (SELECT 1 FROM OPENJSON(a.GstFields) WHERE [key] = N'state') AND EXISTS (SELECT 1 FROM OPENJSON(i.FieldList) WHERE value = N'state') THEN JSON_MODIFY(g1.FieldsJson, '$.state', JSON_VALUE(a.GstFields, '$.state')) ELSE g1.FieldsJson END) g2
    CROSS APPLY (SELECT FieldsJson = CASE WHEN EXISTS (SELECT 1 FROM OPENJSON(a.GstFields) WHERE [key] = N'igst') AND EXISTS (SELECT 1 FROM OPENJSON(i.FieldList) WHERE value = N'igst') THEN JSON_MODIFY(g2.FieldsJson, '$.igst', JSON_VALUE(a.GstFields, '$.igst')) ELSE g2.FieldsJson END) g3
    CROSS APPLY (SELECT FieldsJson = CASE WHEN EXISTS (SELECT 1 FROM OPENJSON(a.GstFields) WHERE [key] = N'cgst') AND EXISTS (SELECT 1 FROM OPENJSON(i.FieldList) WHERE value = N'cgst') THEN JSON_MODIFY(g3.FieldsJson, '$.cgst', JSON_VALUE(a.GstFields, '$.cgst')) ELSE g3.FieldsJson END) g4
    CROSS APPLY (SELECT FieldsJson = CASE WHEN EXISTS (SELECT 1 FROM OPENJSON(a.GstFields) WHERE [key] = N'sgst') AND EXISTS (SELECT 1 FROM OPENJSON(i.FieldList) WHERE value = N'sgst') THEN JSON_MODIFY(g4.FieldsJson, '$.sgst', JSON_VALUE(a.GstFields, '$.sgst')) ELSE g4.FieldsJson END) g5
    WHERE l.RequestId = @id;
    UPDATE dbo.TA_Claim SET ApproverComments = @comments, RejectionReason = N'' WHERE RequestId = @id;
  END
  ELSE IF @kind = N'travel' UPDATE dbo.TA_Travel SET ApproverRemarks = @remarks WHERE RequestId = @id;
  ELSE UPDATE dbo.TA_Advance SET ApproverRemarks = @remarks WHERE RequestId = @id;

  UPDATE dbo.TA_Request SET Status = N'approved', ApprovedOn = @today, ApproverCode = @me, ApproverName = @name, UpdatedAt = SYSDATETIME()
  WHERE RequestId = @id AND Status = N'submitted';
  IF @@ROWCOUNT = 0 THROW 50000, N'[CONFLICT] The request was actioned by someone else.', 1;
  INSERT dbo.TA_RequestHistory (RequestId, RequestNumber, Action, ActedBy, Details) VALUES (@id, @number, N'Approved', @me, NULLIF(LEFT(CASE WHEN @kind = N'claim' THEN @comments ELSE @remarks END, 1000), N''));
  COMMIT;
  SELECT dbo.TA_fn_RequestJson(@id) AS JsonResult;
END
GO

/* Reject: claims need RejectionReason; travel/advance need ApproverRemarks. Lines left undecided are set to 0; configured GST corrections are retained. */
CREATE OR ALTER PROCEDURE dbo.TA_usp_RejectRequest @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  DECLARE @asApprover BIT = dbo.TA_fn_ActsAsApprover(@JsonParam);   -- the VIEW this call acts in (see TA_fn_ActsAsApprover)
  IF @asApprover = 0 THROW 50000, N'[FORBIDDEN] Only approvers can approve or reject', 1;
  DECLARE @id UNIQUEIDENTIFIER = TRY_CONVERT(UNIQUEIDENTIFIER, JSON_VALUE(@JsonParam, '$.Id'));
  DECLARE @kind NVARCHAR(10) = JSON_VALUE(@JsonParam, '$.Kind');
  DECLARE @status NVARCHAR(10), @code NVARCHAR(30), @number NVARCHAR(40);
  SELECT @status = r.Status, @code = r.EmployeeCode, @number = r.RequestNumber
  FROM dbo.TA_Request r JOIN dbo.TA_fn_Visible(@me, @asApprover) v ON v.RequestId = r.RequestId WHERE r.RequestId = @id AND r.Kind = @kind;
  IF @status IS NULL THROW 50000, N'[NOT_FOUND] Record not found', 1;
  IF @status <> N'submitted' THROW 50000, N'[CONFLICT] Only submitted requests can be actioned', 1;
  IF @code = @me AND ISNULL(dbo.TA_fn_Setting(N'AllowSelfApproval'), N'Y') = N'N' THROW 50000, N'[FORBIDDEN] You cannot reject your own request', 1;

  DECLARE @comments NVARCHAR(MAX), @remarks NVARCHAR(MAX), @reason NVARCHAR(MAX);
  SELECT @comments = ISNULL(h.approverComments, N''), @remarks = ISNULL(h.approverRemarks, N''), @reason = ISNULL(h.rejectionReason, N'')
  FROM OPENJSON(@JsonParam) WITH (approverComments NVARCHAR(MAX) '$.ApproverComments', approverRemarks NVARCHAR(MAX) '$.ApproverRemarks', rejectionReason NVARCHAR(MAX) '$.RejectionReason') h;
  IF @kind = N'claim' AND LTRIM(RTRIM(@reason)) = N'' THROW 50000, N'[VALIDATION] Rejection Reason: required when rejecting', 1;
  IF @kind <> N'claim' AND LTRIM(RTRIM(@remarks)) = N'' THROW 50000, N'[VALIDATION] Approver Remarks: required when rejecting', 1;

  DECLARE @name NVARCHAR(100) = (SELECT Name FROM dbo.TA_vw_Employee WHERE EmployeeCode = @me);
  DECLARE @today DATE = dbo.TA_fn_Today();
  BEGIN TRAN;
  IF @kind = N'claim'
  BEGIN
    CREATE TABLE #Ap (LineId NVARCHAR(64) NOT NULL PRIMARY KEY, Amt DECIMAL(18,2) NULL, Rem NVARCHAR(500) NOT NULL, GstFields NVARCHAR(MAX) NULL);
    INSERT #Ap (LineId, Amt, Rem, GstFields)
    SELECT x.id, TRY_CAST(NULLIF(x.approvedAmount, N'') AS DECIMAL(18,2)), ISNULL(LEFT(x.approverRemarks, 500), N''), x.GstFields
    FROM OPENJSON(@JsonParam, '$.Lines') WITH (id NVARCHAR(64) '$.id', approvedAmount NVARCHAR(40) '$.approvedAmount', approverRemarks NVARCHAR(MAX) '$.approverRemarks', GstFields NVARCHAR(MAX) '$.gstFields' AS JSON) x;
    IF EXISTS (SELECT 1 FROM #Ap WHERE GstFields IS NOT NULL AND ISJSON(GstFields) <> 1)
      THROW 50000, N'[VALIDATION] GST corrections must be a JSON object.', 1;
    IF EXISTS (
      SELECT 1 FROM #Ap a CROSS APPLY OPENJSON(a.GstFields) g
      JOIN dbo.TA_ClaimLine l ON l.RequestId = @id AND l.LineId = a.LineId
      JOIN dbo.TA_ExpenseItem i ON i.ItemKey = l.ItemKey
      WHERE a.GstFields IS NOT NULL AND (
        g.[key] NOT IN (N'gstNumber', N'state', N'igst', N'cgst', N'sgst')
        OR NOT EXISTS (SELECT 1 FROM OPENJSON(i.FieldList) f WHERE f.value = g.[key])
      )
    ) THROW 50000, N'[VALIDATION] GST corrections may only update GST fields configured for that expense line.', 1;
    IF EXISTS (SELECT 1 FROM dbo.TA_ClaimLine l JOIN #Ap a ON a.LineId = l.LineId WHERE l.RequestId = @id AND a.Amt IS NOT NULL AND (a.Amt < 0 OR a.Amt > l.Amount))
      THROW 50000, N'[VALIDATION] Approved Amount: enter a value between 0 and the claimed amount.', 1;
    UPDATE l SET ApprovedAmount = a.Amt, ApproverRemarks = a.Rem, FieldsJson =
      CASE WHEN a.GstFields IS NULL THEN l.FieldsJson ELSE g5.FieldsJson END
    FROM dbo.TA_ClaimLine l
    JOIN #Ap a ON a.LineId = l.LineId
    JOIN dbo.TA_ExpenseItem i ON i.ItemKey = l.ItemKey
    CROSS APPLY (SELECT FieldsJson = CASE WHEN EXISTS (SELECT 1 FROM OPENJSON(a.GstFields) WHERE [key] = N'gstNumber') AND EXISTS (SELECT 1 FROM OPENJSON(i.FieldList) WHERE value = N'gstNumber') THEN JSON_MODIFY(l.FieldsJson, '$.gstNumber', JSON_VALUE(a.GstFields, '$.gstNumber')) ELSE l.FieldsJson END) g1
    CROSS APPLY (SELECT FieldsJson = CASE WHEN EXISTS (SELECT 1 FROM OPENJSON(a.GstFields) WHERE [key] = N'state') AND EXISTS (SELECT 1 FROM OPENJSON(i.FieldList) WHERE value = N'state') THEN JSON_MODIFY(g1.FieldsJson, '$.state', JSON_VALUE(a.GstFields, '$.state')) ELSE g1.FieldsJson END) g2
    CROSS APPLY (SELECT FieldsJson = CASE WHEN EXISTS (SELECT 1 FROM OPENJSON(a.GstFields) WHERE [key] = N'igst') AND EXISTS (SELECT 1 FROM OPENJSON(i.FieldList) WHERE value = N'igst') THEN JSON_MODIFY(g2.FieldsJson, '$.igst', JSON_VALUE(a.GstFields, '$.igst')) ELSE g2.FieldsJson END) g3
    CROSS APPLY (SELECT FieldsJson = CASE WHEN EXISTS (SELECT 1 FROM OPENJSON(a.GstFields) WHERE [key] = N'cgst') AND EXISTS (SELECT 1 FROM OPENJSON(i.FieldList) WHERE value = N'cgst') THEN JSON_MODIFY(g3.FieldsJson, '$.cgst', JSON_VALUE(a.GstFields, '$.cgst')) ELSE g3.FieldsJson END) g4
    CROSS APPLY (SELECT FieldsJson = CASE WHEN EXISTS (SELECT 1 FROM OPENJSON(a.GstFields) WHERE [key] = N'sgst') AND EXISTS (SELECT 1 FROM OPENJSON(i.FieldList) WHERE value = N'sgst') THEN JSON_MODIFY(g4.FieldsJson, '$.sgst', JSON_VALUE(a.GstFields, '$.sgst')) ELSE g4.FieldsJson END) g5
    WHERE l.RequestId = @id AND (a.Amt IS NOT NULL OR a.GstFields IS NOT NULL);
    UPDATE dbo.TA_ClaimLine SET ApprovedAmount = 0 WHERE RequestId = @id AND ApprovedAmount IS NULL;
    UPDATE dbo.TA_Claim SET ApproverComments = @comments, RejectionReason = @reason WHERE RequestId = @id;
  END
  ELSE IF @kind = N'travel' UPDATE dbo.TA_Travel SET ApproverRemarks = @remarks WHERE RequestId = @id;
  ELSE UPDATE dbo.TA_Advance SET ApproverRemarks = @remarks WHERE RequestId = @id;

  UPDATE dbo.TA_Request SET Status = N'rejected', ApprovedOn = @today, ApproverCode = @me, ApproverName = @name, UpdatedAt = SYSDATETIME()
  WHERE RequestId = @id AND Status = N'submitted';
  IF @@ROWCOUNT = 0 THROW 50000, N'[CONFLICT] The request was actioned by someone else.', 1;
  INSERT dbo.TA_RequestHistory (RequestId, RequestNumber, Action, ActedBy, Details) VALUES (@id, @number, N'Rejected', @me, LEFT(CASE WHEN @kind = N'claim' THEN @reason ELSE @remarks END, 1000));
  COMMIT;
  SELECT dbo.TA_fn_RequestJson(@id) AS JsonResult;
END
GO

/* Queue: submitted requests, oldest first (approvers only). */
CREATE OR ALTER PROCEDURE dbo.TA_usp_ListPendingApprovals @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  DECLARE @asApprover BIT = dbo.TA_fn_ActsAsApprover(@JsonParam);   -- the VIEW this call acts in (see TA_fn_ActsAsApprover)
  IF @asApprover = 0 THROW 50000, N'[FORBIDDEN] Only approvers can view the approval queue', 1;
  DECLARE @rows NVARCHAR(MAX) = (
    SELECT STRING_AGG(CONVERT(NVARCHAR(MAX), dbo.TA_fn_RequestJson(q.RequestId)), N',') WITHIN GROUP (ORDER BY q.SubmittedOn, q.RequestNumber)
    FROM dbo.TA_Request q JOIN dbo.TA_fn_Visible(@me, @asApprover) v ON v.RequestId = q.RequestId WHERE q.Status = N'submitted');
  SELECT N'[' + ISNULL(@rows, N'') + N']' AS JsonResult;
END
GO

/* History: approved/rejected within the last Days (max 30), newest decision first, at most 10 rows (approvers only). */
CREATE OR ALTER PROCEDURE dbo.TA_usp_ListApprovalHistory @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  DECLARE @asApprover BIT = dbo.TA_fn_ActsAsApprover(@JsonParam);   -- the VIEW this call acts in (see TA_fn_ActsAsApprover)
  IF @asApprover = 0 THROW 50000, N'[FORBIDDEN] Only approvers can view approval history', 1;
  DECLARE @days INT = ISNULL(TRY_CAST(JSON_VALUE(@JsonParam, '$.Days') AS INT), 30);
  IF @days < 1 SET @days = 1;
  IF @days > 30 SET @days = 30;
  DECLARE @cutoff DATE = DATEADD(DAY, -@days, dbo.TA_fn_Today());

  CREATE TABLE #H (RowNo INT IDENTITY(1,1) NOT NULL PRIMARY KEY, RequestId UNIQUEIDENTIFIER NOT NULL);
  INSERT #H (RequestId)
  SELECT TOP (10) q.RequestId
  FROM dbo.TA_Request q JOIN dbo.TA_fn_Visible(@me, @asApprover) v ON v.RequestId = q.RequestId
  WHERE q.Status IN (N'approved', N'rejected') AND q.ApprovedOn >= @cutoff
  ORDER BY q.ApprovedOn DESC, q.UpdatedAt DESC;
  DECLARE @rows NVARCHAR(MAX) = (SELECT STRING_AGG(CONVERT(NVARCHAR(MAX), dbo.TA_fn_RequestJson(h.RequestId)), N',') WITHIN GROUP (ORDER BY h.RowNo) FROM #H h);
  SELECT N'[' + ISNULL(@rows, N'') + N']' AS JsonResult;
END
GO

/* Approval trail of one request: who created it, submitted it and decided it, with the decision text. Allowed in both views for any request the caller can see.
   Returns [{ action, actedBy, actedByName, actedAt, details }] oldest first; action is Created | Submitted | Approved | Rejected | Copied.
   Created comes from the request itself (so older requests have it too); the others come from TA_RequestHistory. "Saved" and "Deleted" rows are not part of the trail. */
CREATE OR ALTER PROCEDURE dbo.TA_usp_GetApprovalTrail @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  DECLARE @asApprover BIT = dbo.TA_fn_ActsAsApprover(@JsonParam);   -- the VIEW this call acts in (see TA_fn_ActsAsApprover)
  DECLARE @id UNIQUEIDENTIFIER = TRY_CONVERT(UNIQUEIDENTIFIER, JSON_VALUE(@JsonParam, '$.Id'));
  DECLARE @kind NVARCHAR(10) = JSON_VALUE(@JsonParam, '$.Kind');
  IF @id IS NULL OR NOT EXISTS (SELECT 1 FROM dbo.TA_Request r JOIN dbo.TA_fn_Visible(@me, @asApprover) v ON v.RequestId = r.RequestId WHERE r.RequestId = @id AND r.Kind = @kind)
    THROW 50000, N'[NOT_FOUND] Record not found', 1;

  SELECT ISNULL((
    SELECT x.[action] AS [action], x.actedBy AS actedBy, x.actedByName AS actedByName, CONVERT(CHAR(19), x.[at], 126) AS actedAt, x.details AS details
    FROM (
      SELECT N'Created' AS [action], r.CreatedBy AS actedBy, e.Name AS actedByName, r.CreatedAt AS [at], CAST(NULL AS NVARCHAR(1000)) AS details, CAST(0 AS BIGINT) AS ord
      FROM dbo.TA_Request r LEFT JOIN dbo.TA_vw_Employee e ON e.EmployeeCode = r.CreatedBy WHERE r.RequestId = @id
      UNION ALL
      SELECT h.Action, h.ActedBy, e.Name, h.ActedAt, h.Details, h.HistoryId
      FROM dbo.TA_RequestHistory h LEFT JOIN dbo.TA_vw_Employee e ON e.EmployeeCode = h.ActedBy
      WHERE h.RequestId = @id AND h.Action IN (N'Submitted', N'Approved', N'Rejected', N'Copied')
    ) x ORDER BY x.[at], x.ord FOR JSON PATH, INCLUDE_NULL_VALUES), N'[]') AS JsonResult;
END
GO

-- Stamp: this script is installed at revision 2026-11-12-a (the app compares it with the revision it expects).
MERGE dbo.TA_SchemaVersion AS t USING (VALUES (N'06_procs_approvals', N'2026-11-12-a')) AS s (ScriptName, Rev) ON t.ScriptName = s.ScriptName
WHEN MATCHED THEN UPDATE SET Rev = s.Rev, AppliedAt = SYSDATETIME()
WHEN NOT MATCHED THEN INSERT (ScriptName, Rev) VALUES (s.ScriptName, s.Rev);
GO
