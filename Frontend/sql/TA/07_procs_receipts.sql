-- Travel Claim (TA_) procedures, part 4: receipt box.  Run after 06. Re-runnable.
-- The receipt box belongs to EMPLOYEES: approvers get [FORBIDDEN]. A receipt is a stored file (TA_Attachment, DocType TA_RECEIPT) plus bill details.
SET NOCOUNT ON;
GO

CREATE OR ALTER PROCEDURE dbo.TA_usp_ListReceipts @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  DECLARE @asApprover BIT = dbo.TA_fn_ActsAsApprover(@JsonParam);   -- the VIEW this call acts in (see TA_fn_ActsAsApprover)
  IF @asApprover = 1 THROW 50000, N'[FORBIDDEN] The receipt box is for employees: switch to the Employee view', 1;
  DECLARE @rows NVARCHAR(MAX) = (SELECT STRING_AGG(CONVERT(NVARCHAR(MAX), dbo.TA_fn_ReceiptJson(r.ReceiptId)), N',') WITHIN GROUP (ORDER BY r.UploadedAt DESC, r.ReceiptId)
                                 FROM dbo.TA_Receipt r WHERE r.OwnerCode = @me);
  SELECT N'[' + ISNULL(@rows, N'') + N']' AS JsonResult;
END
GO

/* Create receipts from files ALREADY uploaded with TA_usp_UploadAttachment (DocType TA_RECEIPT): { Files: [{FileId, DocType, Name, Size, Type}] }.
   All-or-nothing. Returns the created receipts in the order given. */
CREATE OR ALTER PROCEDURE dbo.TA_usp_CreateReceipts @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  DECLARE @asApprover BIT = dbo.TA_fn_ActsAsApprover(@JsonParam);   -- the VIEW this call acts in (see TA_fn_ActsAsApprover)
  IF @asApprover = 1 THROW 50000, N'[FORBIDDEN] The receipt box is for employees: switch to the Employee view', 1;

  CREATE TABLE #F (Ord INT NOT NULL, FileId NVARCHAR(260) NOT NULL, DocType NVARCHAR(40) NOT NULL, AttachmentId UNIQUEIDENTIFIER NULL);
  INSERT #F (Ord, FileId, DocType)
  SELECT CAST(j.[key] AS INT), JSON_VALUE(j.value, '$.FileId'), UPPER(JSON_VALUE(j.value, '$.DocType')) FROM OPENJSON(@JsonParam, '$.Files') j
  WHERE JSON_VALUE(j.value, '$.FileId') IS NOT NULL AND JSON_VALUE(j.value, '$.DocType') IS NOT NULL;
  IF NOT EXISTS (SELECT 1 FROM #F) THROW 50000, N'[VALIDATION] No files were given.', 1;
  IF EXISTS (SELECT 1 FROM #F GROUP BY DocType, FileId HAVING COUNT(*) > 1) THROW 50000, N'[VALIDATION] The same file was given twice.', 1;

  UPDATE f SET AttachmentId = a.AttachmentId FROM #F f JOIN dbo.TA_Attachment a ON a.DocType = f.DocType AND a.StoredFileName = f.FileId AND a.OwnerCode = @me;
  IF EXISTS (SELECT 1 FROM #F WHERE AttachmentId IS NULL OR DocType <> N'TA_RECEIPT') THROW 50000, N'[VALIDATION] A file was not found. Upload it again.', 1;
  IF EXISTS (SELECT 1 FROM #F f JOIN dbo.TA_Receipt r ON r.AttachmentId = f.AttachmentId) THROW 50000, N'[CONFLICT] A file is already in your receipt box.', 1;

  DECLARE @new TABLE (ReceiptId UNIQUEIDENTIFIER NOT NULL, AttachmentId UNIQUEIDENTIFIER NOT NULL);
  BEGIN TRAN;
  INSERT dbo.TA_Receipt (OwnerCode, AttachmentId)
  OUTPUT inserted.ReceiptId, inserted.AttachmentId INTO @new (ReceiptId, AttachmentId)
  SELECT @me, f.AttachmentId FROM #F f ORDER BY f.Ord;
  COMMIT;

  DECLARE @rows NVARCHAR(MAX) = (SELECT STRING_AGG(CONVERT(NVARCHAR(MAX), dbo.TA_fn_ReceiptJson(n.ReceiptId)), N',') WITHIN GROUP (ORDER BY f.Ord)
                                 FROM @new n JOIN #F f ON f.AttachmentId = n.AttachmentId);
  SELECT N'[' + ISNULL(@rows, N'') + N']' AS JsonResult;
END
GO

/* Update the descriptive fields: { Receipt: { id, date, billerName, billNumber, amount, notes } }. File, owner and usage are never taken from the client. */
CREATE OR ALTER PROCEDURE dbo.TA_usp_UpdateReceipt @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  DECLARE @asApprover BIT = dbo.TA_fn_ActsAsApprover(@JsonParam);   -- the VIEW this call acts in (see TA_fn_ActsAsApprover)
  IF @asApprover = 1 THROW 50000, N'[FORBIDDEN] The receipt box is for employees: switch to the Employee view', 1;
  DECLARE @id UNIQUEIDENTIFIER = TRY_CONVERT(UNIQUEIDENTIFIER, JSON_VALUE(@JsonParam, '$.Receipt.id'));
  DECLARE @used UNIQUEIDENTIFIER;
  IF @id IS NULL OR NOT EXISTS (SELECT 1 FROM dbo.TA_Receipt WHERE ReceiptId = @id AND OwnerCode = @me) THROW 50000, N'[NOT_FOUND] Bill not found', 1;
  SELECT @used = UsedInRequestId FROM dbo.TA_Receipt WHERE ReceiptId = @id;
  IF @used IS NOT NULL THROW 50000, N'[CONFLICT] A bill on a claim cannot be edited', 1;

  DECLARE @dateRaw NVARCHAR(20), @biller NVARCHAR(MAX), @no NVARCHAR(MAX), @amtRaw NVARCHAR(40), @notes NVARCHAR(MAX);
  SELECT @dateRaw = h.[date], @biller = h.billerName, @no = h.billNumber, @amtRaw = h.amount, @notes = h.notes
  FROM OPENJSON(@JsonParam, '$.Receipt') WITH ([date] NVARCHAR(20) '$.date', billerName NVARCHAR(MAX) '$.billerName', billNumber NVARCHAR(MAX) '$.billNumber', amount NVARCHAR(40) '$.amount', notes NVARCHAR(MAX) '$.notes') h;
  DECLARE @date DATE = TRY_CAST(NULLIF(@dateRaw, N'') AS DATE);
  DECLARE @amt DECIMAL(18,2) = TRY_CAST(NULLIF(@amtRaw, N'') AS DECIMAL(18,2));
  IF NULLIF(@dateRaw, N'') IS NOT NULL AND @date IS NULL THROW 50000, N'[VALIDATION] Bill date is not a valid date', 1;
  IF @date > dbo.TA_fn_Today() THROW 50000, N'[VALIDATION] Bill date cannot be in the future', 1;
  IF @amt < 0 THROW 50000, N'[VALIDATION] Amount cannot be negative', 1;

  UPDATE dbo.TA_Receipt SET BillDate = @date, BillerName = ISNULL(LEFT(@biller, 200), N''), BillNumber = ISNULL(LEFT(@no, 100), N''), Amount = @amt, Notes = ISNULL(LEFT(@notes, 500), N'')
  WHERE ReceiptId = @id AND OwnerCode = @me AND UsedInRequestId IS NULL;
  IF @@ROWCOUNT = 0 THROW 50000, N'[CONFLICT] A bill on a claim cannot be edited', 1;
  SELECT dbo.TA_fn_ReceiptJson(@id) AS JsonResult;
END
GO

/* Delete an unused bill. The stored file stays on disk for the orphan clean-up job. */
CREATE OR ALTER PROCEDURE dbo.TA_usp_DeleteReceipt @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  DECLARE @asApprover BIT = dbo.TA_fn_ActsAsApprover(@JsonParam);   -- the VIEW this call acts in (see TA_fn_ActsAsApprover)
  IF @asApprover = 1 THROW 50000, N'[FORBIDDEN] The receipt box is for employees: switch to the Employee view', 1;
  DECLARE @id UNIQUEIDENTIFIER = TRY_CONVERT(UNIQUEIDENTIFIER, JSON_VALUE(@JsonParam, '$.Id'));
  IF @id IS NULL OR NOT EXISTS (SELECT 1 FROM dbo.TA_Receipt WHERE ReceiptId = @id AND OwnerCode = @me) THROW 50000, N'[NOT_FOUND] Bill not found', 1;
  DELETE dbo.TA_Receipt WHERE ReceiptId = @id AND OwnerCode = @me AND UsedInRequestId IS NULL;
  IF @@ROWCOUNT = 0 THROW 50000, N'[CONFLICT] A bill on a claim cannot be deleted', 1;
  SELECT CAST(NULL AS NVARCHAR(MAX)) AS JsonResult;
END
GO

-- Stamp: this script is installed at revision 2026-11-12-a (the app compares it with the revision it expects).
MERGE dbo.TA_SchemaVersion AS t USING (VALUES (N'07_procs_receipts', N'2026-11-12-a')) AS s (ScriptName, Rev) ON t.ScriptName = s.ScriptName
WHEN MATCHED THEN UPDATE SET Rev = s.Rev, AppliedAt = SYSDATETIME()
WHEN NOT MATCHED THEN INSERT (ScriptName, Rev) VALUES (s.ScriptName, s.Rev);
GO
