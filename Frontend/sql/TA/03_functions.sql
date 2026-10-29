-- Travel Claim (TA_) module: helper functions and views. Run after 01 and 02. Re-runnable (CREATE OR ALTER).
-- The JSON these functions produce is EXACTLY what the screens consume (src/types/domain.ts): camelCase, dates as 'yyyy-MM-dd',
-- travel periods as 'yyyy-MM-ddTHH:mm', booleans as true/false, and explicit nulls (e.g. an undecided approved amount is null, not missing).
SET NOCOUNT ON;
GO

CREATE OR ALTER FUNCTION dbo.TA_fn_Today () RETURNS DATE AS
BEGIN
  RETURN CAST(SYSDATETIME() AS DATE);          -- server local date; the screens compare against the user's today
END
GO

CREATE OR ALTER FUNCTION dbo.TA_fn_Setting (@Key NVARCHAR(60)) RETURNS NVARCHAR(400) AS
BEGIN
  RETURN (SELECT SettingValue FROM dbo.TA_Setting WHERE SettingKey = @Key);
END
GO

CREATE OR ALTER FUNCTION dbo.TA_fn_IsApprover (@Code NVARCHAR(30)) RETURNS BIT AS
BEGIN
  RETURN CASE WHEN EXISTS (SELECT 1 FROM dbo.TA_Approver WHERE EmployeeCode = @Code AND IsActive = 1) THEN 1 ELSE 0 END;
END
GO

/* Does this call act in the APPROVER view? Only a genuine approver (TA_Approver) can; the optional ActAs hint sent by the app ('employee') can only NARROW
   an approver to the ordinary employee experience (own requests, receipt box, copy rejected claim). It can never grant approver rights. */
CREATE OR ALTER FUNCTION dbo.TA_fn_ActsAsApprover (@JsonParam NVARCHAR(MAX)) RETURNS BIT AS
BEGIN
  RETURN CASE WHEN dbo.TA_fn_IsApprover(NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'')) = 1
               AND ISNULL(LOWER(JSON_VALUE(@JsonParam, '$.ActAs')), N'approver') <> N'employee' THEN 1 ELSE 0 END;
END
GO

/* Requests a caller may see. Approver view: every non-draft request plus the drafts they created. Employee view (any employee, including an approver
   who switched to it): only their own requests. */
CREATE OR ALTER FUNCTION dbo.TA_fn_Visible (@Me NVARCHAR(30), @AsApprover BIT) RETURNS TABLE AS
RETURN
  SELECT r.RequestId
  FROM dbo.TA_Request r
  WHERE (@AsApprover = 1 AND (r.Status <> N'draft' OR r.CreatedBy = @Me))
     OR (@AsApprover = 0 AND r.EmployeeCode = @Me);
GO

/* Medical balance used: approved claims count at their approved amount, submitted ones at their claimed total; calendar year of today. */
CREATE OR ALTER FUNCTION dbo.TA_fn_MedicalUsed (@Code NVARCHAR(30), @ExcludeId UNIQUEIDENTIFIER) RETURNS DECIMAL(18,2) AS
BEGIN
  RETURN ISNULL((
    SELECT SUM(CASE r.Status
                 WHEN N'approved'  THEN ISNULL((SELECT SUM(ISNULL(l.ApprovedAmount, 0)) FROM dbo.TA_ClaimLine l WHERE l.RequestId = r.RequestId), 0)
                 WHEN N'submitted' THEN ISNULL((SELECT SUM(l.Amount) FROM dbo.TA_ClaimLine l WHERE l.RequestId = r.RequestId), 0)
                 ELSE 0 END)
    FROM dbo.TA_Request r JOIN dbo.TA_Claim c ON c.RequestId = r.RequestId
    WHERE r.EmployeeCode = @Code AND c.ExpenseType = N'medical' AND (@ExcludeId IS NULL OR r.RequestId <> @ExcludeId)
      AND YEAR(r.RequestDate) = YEAR(dbo.TA_fn_Today())), 0);
END
GO

/* Advance used: approved-and-unsettled advances (outstanding) + submitted ones (pending). */
CREATE OR ALTER FUNCTION dbo.TA_fn_AdvanceUsed (@Code NVARCHAR(30), @ExcludeId UNIQUEIDENTIFIER) RETURNS DECIMAL(18,2) AS
BEGIN
  RETURN ISNULL((
    SELECT SUM(ISNULL(a.Amount, 0))
    FROM dbo.TA_Request r JOIN dbo.TA_Advance a ON a.RequestId = r.RequestId
    WHERE r.EmployeeCode = @Code AND (@ExcludeId IS NULL OR r.RequestId <> @ExcludeId)
      AND ((r.Status = N'approved' AND a.IsSettled = 0) OR r.Status = N'submitted')), 0);
END
GO

CREATE OR ALTER FUNCTION dbo.TA_fn_ClaimTotal (@RequestId UNIQUEIDENTIFIER) RETURNS DECIMAL(18,2) AS
BEGIN
  RETURN ISNULL((SELECT SUM(Amount) FROM dbo.TA_ClaimLine WHERE RequestId = @RequestId), 0);
END
GO
CREATE OR ALTER FUNCTION dbo.TA_fn_TravelEstimate (@RequestId UNIQUEIDENTIFIER) RETURNS DECIMAL(18,2) AS
BEGIN
  RETURN ISNULL((SELECT SUM(ISNULL(Amount, 0)) FROM dbo.TA_TravelEstimate WHERE RequestId = @RequestId), 0);
END
GO

/* One row per request with the figures the lists search, sort and filter on. */
CREATE OR ALTER VIEW dbo.TA_vw_RequestSummary AS
SELECT r.RequestId, r.Kind, r.RequestNumber, r.EmployeeCode, r.EmployeeName, r.RequestDate, r.Status, r.SubmittedOn, r.ApprovedOn, r.CreatedBy, r.UpdatedAt,
       CASE r.Kind WHEN N'claim' THEN c.Purpose WHEN N'travel' THEN t.Purpose ELSE a.Purpose END AS Purpose,
       CASE r.Kind WHEN N'travel' THEN t.Remarks WHEN N'advance' THEN a.Remarks ELSE N'' END AS Remarks,
       CASE WHEN r.Kind = N'travel' THEN t.ToLocation ELSE N'' END AS Destination,
       c.ExpenseType, et.Label AS TypeLabel, et.ShortLabel AS TypeShort,
       CASE r.Kind WHEN N'claim' THEN dbo.TA_fn_ClaimTotal(r.RequestId)
                   WHEN N'travel' THEN dbo.TA_fn_TravelEstimate(r.RequestId)
                   ELSE ISNULL(a.Amount, 0) END AS Total,
       CASE WHEN r.Status = N'rejected' THEN CAST(0 AS DECIMAL(18,2))
            WHEN r.Status = N'approved' AND r.Kind = N'claim' THEN ISNULL((SELECT SUM(ISNULL(l.ApprovedAmount, 0)) FROM dbo.TA_ClaimLine l WHERE l.RequestId = r.RequestId), 0)
            WHEN r.Status = N'approved' AND r.Kind = N'travel' THEN dbo.TA_fn_TravelEstimate(r.RequestId)
            WHEN r.Status = N'approved' THEN ISNULL(a.Amount, 0)
            ELSE CAST(NULL AS DECIMAL(18,2)) END AS ApprovedTotal
FROM dbo.TA_Request r
LEFT JOIN dbo.TA_Claim c ON c.RequestId = r.RequestId
LEFT JOIN dbo.TA_Travel t ON t.RequestId = r.RequestId
LEFT JOIN dbo.TA_Advance a ON a.RequestId = r.RequestId
LEFT JOIN dbo.TA_ExpenseType et ON et.TypeKey = c.ExpenseType;
GO

/* ------------------------------------------------------------------------------------------------------------------------
   JSON of one receipt (shape of the screens' Receipt type)
------------------------------------------------------------------------------------------------------------------------ */
CREATE OR ALTER FUNCTION dbo.TA_fn_ReceiptJson (@ReceiptId UNIQUEIDENTIFIER) RETURNS NVARCHAR(MAX) AS
BEGIN
  RETURN (
    SELECT LOWER(CONVERT(VARCHAR(36), rc.ReceiptId)) AS id,
           rc.OwnerCode AS employeeCode,
           JSON_QUERY((SELECT a.FileName AS name, a.SizeBytes AS size, a.MimeType AS [type], a.StoredFileName AS fileId, a.DocType AS docType
                       FROM dbo.TA_Attachment a WHERE a.AttachmentId = rc.AttachmentId FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)) AS [file],
           CONVERT(CHAR(19), rc.UploadedAt, 126) AS uploadedAt,
           ISNULL(CONVERT(CHAR(10), rc.BillDate, 23), N'') AS [date],
           rc.BillerName AS billerName, rc.BillNumber AS billNumber, rc.Amount AS amount, rc.Notes AS notes,
           JSON_QUERY(CASE WHEN rc.UsedInRequestId IS NULL THEN NULL ELSE
             (SELECT LOWER(CONVERT(VARCHAR(36), rq.RequestId)) AS claimId, rq.RequestNumber AS requestNumber, rc.UsedInLineId AS lineId
              FROM dbo.TA_Request rq WHERE rq.RequestId = rc.UsedInRequestId FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) END) AS usedIn
    FROM dbo.TA_Receipt rc WHERE rc.ReceiptId = @ReceiptId
    FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES);
END
GO

/* ------------------------------------------------------------------------------------------------------------------------
   JSON of one request: ExpenseClaim | TravelRequest | AdvanceRequest
------------------------------------------------------------------------------------------------------------------------ */
CREATE OR ALTER FUNCTION dbo.TA_fn_RequestJson (@RequestId UNIQUEIDENTIFIER) RETURNS NVARCHAR(MAX) AS
BEGIN
  DECLARE @kind NVARCHAR(10) = (SELECT Kind FROM dbo.TA_Request WHERE RequestId = @RequestId);
  DECLARE @j NVARCHAR(MAX);

  IF @kind = N'claim'
    SET @j = (
      SELECT LOWER(CONVERT(VARCHAR(36), r.RequestId)) AS id, r.Kind AS kind, r.RequestNumber AS requestNumber,
             r.EmployeeCode AS employeeCode, r.EmployeeName AS employeeName, r.CostCentre AS costCentre,
             CONVERT(CHAR(10), r.RequestDate, 23) AS requestDate, r.Status AS status,
             CONVERT(CHAR(10), r.SubmittedOn, 23) AS submittedOn, CONVERT(CHAR(10), r.ApprovedOn, 23) AS approvedOn, r.ApproverName AS approver,
             r.CreatedBy AS createdBy, CONVERT(CHAR(19), r.CreatedAt, 126) AS createdAt, CONVERT(CHAR(19), r.UpdatedAt, 126) AS updatedAt,
             c.ExpenseType AS expenseType, c.Purpose AS purpose,
             CONVERT(CHAR(10), c.TravelFrom, 23) AS travelFrom, CONVERT(CHAR(10), c.TravelTo, 23) AS travelTo,
             JSON_QUERY(ISNULL((
               SELECT l.LineId AS id, l.ItemKey AS itemKey, JSON_QUERY(l.FieldsJson) AS fields,
                      JSON_QUERY(ISNULL((
                        SELECT x.name, x.size, x.[type], x.fileId, x.docType, x.receiptId
                        FROM (
                          SELECT a.FileName AS name, a.SizeBytes AS size, a.MimeType AS [type], a.StoredFileName AS fileId, a.DocType AS docType,
                                 CAST(NULL AS VARCHAR(36)) AS receiptId, k.SortOrder AS ord, a.UploadedAt AS up
                          FROM dbo.TA_AttachmentLink k JOIN dbo.TA_Attachment a ON a.AttachmentId = k.AttachmentId
                          WHERE k.RequestId = l.RequestId AND k.LineId = l.LineId
                          UNION ALL
                          SELECT a.FileName, a.SizeBytes, a.MimeType, a.StoredFileName, a.DocType, LOWER(CONVERT(VARCHAR(36), rc.ReceiptId)), 1000000, a.UploadedAt
                          FROM dbo.TA_Receipt rc JOIN dbo.TA_Attachment a ON a.AttachmentId = rc.AttachmentId
                          WHERE rc.UsedInRequestId = l.RequestId AND rc.UsedInLineId = l.LineId
                        ) x ORDER BY x.ord, x.up FOR JSON PATH), N'[]')) AS attachments,
                      l.ApprovedAmount AS approvedAmount, l.ApproverRemarks AS approverRemarks
               FROM dbo.TA_ClaimLine l WHERE l.RequestId = r.RequestId ORDER BY l.SortOrder
               FOR JSON PATH, INCLUDE_NULL_VALUES), N'[]')) AS items,
             c.EmployeeComments AS employeeComments, c.ApproverComments AS approverComments, c.RejectionReason AS rejectionReason
      FROM dbo.TA_Request r JOIN dbo.TA_Claim c ON c.RequestId = r.RequestId
      WHERE r.RequestId = @RequestId
      FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES);

  ELSE IF @kind = N'travel'
    SET @j = (
      SELECT LOWER(CONVERT(VARCHAR(36), r.RequestId)) AS id, r.Kind AS kind, r.RequestNumber AS requestNumber,
             r.EmployeeCode AS employeeCode, r.EmployeeName AS employeeName, r.CostCentre AS costCentre,
             CONVERT(CHAR(10), r.RequestDate, 23) AS requestDate, r.Status AS status,
             CONVERT(CHAR(10), r.SubmittedOn, 23) AS submittedOn, CONVERT(CHAR(10), r.ApprovedOn, 23) AS approvedOn, r.ApproverName AS approver,
             r.CreatedBy AS createdBy, CONVERT(CHAR(19), r.CreatedAt, 126) AS createdAt, CONVERT(CHAR(19), r.UpdatedAt, 126) AS updatedAt,
             t.Purpose AS purpose, t.Remarks AS remarks, t.FromLocation AS fromLocation, t.ToLocation AS toLocation,
             ISNULL(CONVERT(CHAR(16), t.PeriodFrom, 126), N'') AS periodFrom, ISNULL(CONVERT(CHAR(16), t.PeriodTo, 126), N'') AS periodTo,
             JSON_QUERY(ISNULL((SELECT e.LineId AS id, e.Item AS item, e.Amount AS amount, e.Remarks AS remarks
                                FROM dbo.TA_TravelEstimate e WHERE e.RequestId = r.RequestId ORDER BY e.SortOrder
                                FOR JSON PATH, INCLUDE_NULL_VALUES), N'[]')) AS items,
             t.AdvanceRequired AS advanceRequired, t.OverallRemarks AS overallRemarks, t.ApproverRemarks AS approverRemarks, t.AlongWith AS alongWith,
             JSON_QUERY(ISNULL((SELECT a.FileName AS name, a.SizeBytes AS size, a.MimeType AS [type], a.StoredFileName AS fileId, a.DocType AS docType
                                FROM dbo.TA_AttachmentLink k JOIN dbo.TA_Attachment a ON a.AttachmentId = k.AttachmentId
                                WHERE k.RequestId = r.RequestId AND k.LineId = N'' ORDER BY k.SortOrder FOR JSON PATH), N'[]')) AS attachments,
             t.CreateLeave AS createLeave
      FROM dbo.TA_Request r JOIN dbo.TA_Travel t ON t.RequestId = r.RequestId
      WHERE r.RequestId = @RequestId
      FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES);

  ELSE IF @kind = N'advance'
    SET @j = (
      SELECT LOWER(CONVERT(VARCHAR(36), r.RequestId)) AS id, r.Kind AS kind, r.RequestNumber AS requestNumber,
             r.EmployeeCode AS employeeCode, r.EmployeeName AS employeeName, r.CostCentre AS costCentre,
             CONVERT(CHAR(10), r.RequestDate, 23) AS requestDate, r.Status AS status,
             CONVERT(CHAR(10), r.SubmittedOn, 23) AS submittedOn, CONVERT(CHAR(10), r.ApprovedOn, 23) AS approvedOn, r.ApproverName AS approver,
             r.CreatedBy AS createdBy, CONVERT(CHAR(19), r.CreatedAt, 126) AS createdAt, CONVERT(CHAR(19), r.UpdatedAt, 126) AS updatedAt,
             ISNULL(CONVERT(CHAR(10), a.PeriodFrom, 23), N'') AS periodFrom, ISNULL(CONVERT(CHAR(10), a.PeriodTo, 23), N'') AS periodTo,
             a.Amount AS amount, a.Purpose AS purpose, a.Remarks AS remarks, a.AlongWith AS alongWith,
             JSON_QUERY(ISNULL((SELECT f.FileName AS name, f.SizeBytes AS size, f.MimeType AS [type], f.StoredFileName AS fileId, f.DocType AS docType
                                FROM dbo.TA_AttachmentLink k JOIN dbo.TA_Attachment f ON f.AttachmentId = k.AttachmentId
                                WHERE k.RequestId = r.RequestId AND k.LineId = N'' ORDER BY k.SortOrder FOR JSON PATH), N'[]')) AS attachments,
             a.CreateLeave AS createLeave, a.TravelRequestNo AS travelRequest, a.IsSettled AS settled, a.ApproverRemarks AS approverRemarks
      FROM dbo.TA_Request r JOIN dbo.TA_Advance a ON a.RequestId = r.RequestId
      WHERE r.RequestId = @RequestId
      FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES);

  RETURN @j;
END
GO

-- Stamp: this script is installed at revision 2026-10-28-b (the app compares it with the revision it expects).
MERGE dbo.TA_SchemaVersion AS t USING (VALUES (N'03_functions', N'2026-10-28-b')) AS s (ScriptName, Rev) ON t.ScriptName = s.ScriptName
WHEN MATCHED THEN UPDATE SET Rev = s.Rev, AppliedAt = SYSDATETIME()
WHEN NOT MATCHED THEN INSERT (ScriptName, Rev) VALUES (s.ScriptName, s.Rev);
GO
