/* Registers a file that execProcedure.js has ALREADY written to disk (it adds StoredFileName and FilePath, and removes Base64Content).
   The file is "unlinked" until a request or receipt references it. */
CREATE   PROCEDURE dbo.TA_usp_UploadAttachment 
@JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  IF NOT EXISTS (SELECT 1 FROM dbo.TA_vw_Employee WHERE EmployeeCode = @me AND IsActive = 1) THROW 50000, N'[FORBIDDEN] Your account is not set up for Travel Claim.', 1;

  DECLARE @doc NVARCHAR(40)  = UPPER(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.DocType'))));
  DECLARE @name NVARCHAR(260) = LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.FileName')));
  DECLARE @mime NVARCHAR(100) = LOWER(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.MimeType'))));
  DECLARE @size BIGINT = TRY_CAST(JSON_VALUE(@JsonParam, '$.Size') AS BIGINT);
  DECLARE @stored 
NVARCHAR(260) = JSON_VALUE(@JsonParam, '$.StoredFileName');
  DECLARE @max BIGINT = ISNULL(TRY_CAST(dbo.TA_fn_Setting(N'AttachmentMaxBytes') AS BIGINT), 5242880);
  DECLARE @ext NVARCHAR(10) = LOWER(CASE WHEN CHARINDEX(N'.', REVERSE(@name)) > 0 THEN RIGHT(@name, CHARINDEX(N'.', REVERSE(@name))) ELSE N'' END);

  IF @doc NOT IN (N'TA_CLAIM', N'TA_RECEIPT', N'TA_TRAVEL', N'TA_ADVANCE') THROW 50000, N'[VALIDATION] Unknown document type.', 1;
  IF @name IS NULL OR @name = N'' THROW 50000, N'[VALIDATION] File name is required.', 1;
  IF @ext NOT IN (N'.pdf', N'.jpg', N'.jpeg', N'.png') THROW 50000, N'[VALIDATION] Only PDF, JPG or PNG files are accepted.', 1;
  IF NOT EXISTS (SELECT 1 FROM STRING_SPLIT(ISNULL(dbo.TA_fn_Setting(N'AttachmentTypes'), N''), N',') s WHERE LOWER(LTRIM(RTRIM(s.value))) = @mime)
    THROW 50000, N'[VALIDATION] Only PDF, JPG or PNG files are accepted.', 1;
  IF @size IS NULL OR @size <= 0 THROW 50000, N'[VALIDATION] The file is empty.', 1;
  IF @size > @max THROW 50000, N'[VALIDATION] The file is larger than 5 MB.', 1;
  IF @stored IS NULL OR @stored = N'' THROW 50000, N'[VALIDATION] The file was not stored.', 1;

  INSERT dbo.TA_Attachment (OwnerCode, DocType, StoredFileName, FileName, SizeBytes, MimeType)
  VALUES (@me, @doc, @stored,
 @name, @size, @mime);

  SELECT (SELECT @stored AS storedFileName FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS JsonResult;
END