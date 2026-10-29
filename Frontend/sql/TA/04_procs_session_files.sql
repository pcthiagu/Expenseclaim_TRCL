-- Travel Claim (TA_) procedures, part 1: session, policy, employee lookup, attachments.  Run after 03. Re-runnable.
-- Convention (matches execProcedure.js): input is ONE @JsonParam; the caller is JSON_VALUE(@JsonParam,'$.ExecutedBy') (forced by the server from
-- the verified token); output is ONE column named JsonResult. Errors: THROW 50000 with a [CODE] prefix ([VALIDATION] [FORBIDDEN] [NOT_FOUND] [CONFLICT] [UNAUTHORIZED]).
SET NOCOUNT ON;
GO

CREATE OR ALTER PROCEDURE dbo.TA_usp_GetSession @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  IF NOT EXISTS (SELECT 1 FROM dbo.TA_vw_Employee WHERE EmployeeCode = @me AND IsActive = 1)
    THROW 50000, N'[FORBIDDEN] Your account is not set up for Travel Claim. Contact HR.', 1;

  -- Capability, not the current view: every employee can act as an employee; role 'admin' + isApprover=true means the person is ALSO an approver (listed
  -- in TA_Approver) and the app offers a switch between the Employee and Approver views. The JWT role is not used by this module.
  SELECT (SELECT e.EmployeeCode AS code, e.Name AS name,
                 CASE WHEN dbo.TA_fn_IsApprover(@me) = 1 THEN N'admin' ELSE N'employee' END AS role,
                 CAST(dbo.TA_fn_IsApprover(@me) AS BIT) AS isApprover,
                 JSON_QUERY(ISNULL((SELECT N'{' + STRING_AGG(CONVERT(NVARCHAR(MAX), N'"' + STRING_ESCAPE(v.ScriptName, 'json') + N'":"' + STRING_ESCAPE(v.Rev, 'json') + N'"'), N',') + N'}'
                                    FROM dbo.TA_SchemaVersion v), N'{}')) AS [schema],
                 e.Designation AS designation, e.Department AS department, e.CostCentre AS costCentre
          FROM dbo.TA_vw_Employee e WHERE e.EmployeeCode = @me
          FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES) AS JsonResult;
END
GO

CREATE OR ALTER PROCEDURE dbo.TA_usp_GetPolicy @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON;
  IF NULLIF(JSON_VALUE(@JsonParam, '$.ExecutedBy'), N'') IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;

  DECLARE @twoW DECIMAL(18,2) = ISNULL(TRY_CAST(dbo.TA_fn_Setting(N'RateTwoWheelerPerKm') AS DECIMAL(18,2)), 4);
  DECLARE @fourW DECIMAL(18,2) = ISNULL(TRY_CAST(dbo.TA_fn_Setting(N'RateFourWheelerPerKm') AS DECIMAL(18,2)), 9);
  DECLARE @med DECIMAL(18,2) = ISNULL(TRY_CAST(dbo.TA_fn_Setting(N'MedicalAnnualLimit') AS DECIMAL(18,2)), 15000);
  DECLARE @adv DECIMAL(18,2) = ISNULL(TRY_CAST(dbo.TA_fn_Setting(N'AdvanceLimit') AS DECIMAL(18,2)), 15000);
  DECLARE @maxB BIGINT = ISNULL(TRY_CAST(dbo.TA_fn_Setting(N'AttachmentMaxBytes') AS BIGINT), 5242880);
  DECLARE @types NVARCHAR(MAX) = (SELECT STRING_AGG(CONVERT(NVARCHAR(MAX), N'"' + STRING_ESCAPE(LTRIM(RTRIM(s.value)), 'json') + N'"'), N',')
                                  FROM STRING_SPLIT(ISNULL(dbo.TA_fn_Setting(N'AttachmentTypes'), N''), N',') s WHERE LTRIM(RTRIM(s.value)) <> N'');

  DECLARE @self NVARCHAR(5) = CASE WHEN ISNULL(dbo.TA_fn_Setting(N'AllowSelfApproval'), N'N') = N'Y' THEN N'true' ELSE N'false' END;

  SELECT N'{"policy":{"rates":{"twoWheelerPerKm":' + CONVERT(NVARCHAR(30), @twoW) + N',"fourWheelerPerKm":' + CONVERT(NVARCHAR(30), @fourW) + N'},'
       + N'"medicalAnnualLimit":' + CONVERT(NVARCHAR(30), @med) + N',"advanceLimit":' + CONVERT(NVARCHAR(30), @adv) + N','
       + N'"attachmentMaxBytes":' + CONVERT(NVARCHAR(30), @maxB) + N',"attachmentTypes":[' + ISNULL(@types, N'') + N'],"allowSelfApproval":' + @self + N'}}' AS JsonResult;
END
GO

/* Stub for location-specific ceilings. Replace the final SELECT with the approved policy lookup when its source is ready. */
CREATE OR ALTER PROCEDURE dbo.TA_usp_GetLocationPolicyLimit @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;

  DECLARE @itemKey NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ItemKey'))), N'');
  DECLARE @stayLocation NVARCHAR(100) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.StayLocation'))), N'');
  IF @itemKey IS NULL OR @stayLocation IS NULL THROW 50000, N'[VALIDATION] Item and stay location are required.', 1;

  SELECT N'{"limit":null,"limitPer":null,"enforceEligibility":"N"}' AS JsonResult;
END
GO

/* Reference data for the screens: field definitions, expense types with their items (limits, flags, field lists in display order) and the option lists.
   Nothing about expense types/items lives in the app any more: change it here (tables TA_FieldDef, TA_ExpenseType, TA_ExpenseItem, TA_Lookup). */
CREATE OR ALTER PROCEDURE dbo.TA_usp_GetReferenceData @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON;
  IF NULLIF(JSON_VALUE(@JsonParam, '$.ExecutedBy'), N'') IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;

  DECLARE @fields NVARCHAR(MAX) = (
    SELECT f.FieldKey AS [key], f.Label AS [label], f.FieldType AS [type], f.IsRequired AS [required], f.IsComputed AS [computed], f.IsFull AS [full], f.IsReadonly AS [readonly],
           f.OptionsKey AS [options], f.Placeholder AS [placeholder], f.Helper AS [helper], f.MinValue AS [min], f.StepValue AS [step]
    FROM dbo.TA_FieldDef f ORDER BY f.SortOrder, f.FieldKey FOR JSON PATH);

  DECLARE @types NVARCHAR(MAX) = (
    SELECT t.TypeKey AS [key], t.Label AS [label], t.ShortLabel AS [short], t.Family AS [family], t.Description AS [description], t.ShowBalance AS [showBalance], t.TravelPeriod AS [travelPeriod],
           JSON_QUERY(ISNULL((
             SELECT i.ItemKey AS [key], i.Label AS [label], i.ShortLabel AS [short], JSON_QUERY(i.FieldList) AS [fields], i.Compute AS [compute], i.RateKey AS [rate],
                    i.LimitAmount AS [limit], i.LimitPer AS [limitPer], i.LimitQty AS [limitQty], i.EnforceEligibility AS [enforceEligibility],
                    i.IsFixed AS [fixed], i.AttachmentOptional AS [attachmentOptional], i.Helper AS [helper]
             FROM dbo.TA_ExpenseItem i WHERE i.TypeKey = t.TypeKey ORDER BY i.SortOrder FOR JSON PATH), N'[]')) AS [items]
    FROM dbo.TA_ExpenseType t ORDER BY t.SortOrder FOR JSON PATH);

  -- option lists as {"MODES":[...],"CITIES":[...],...}; cost centres are whatever active employees carry
  DECLARE @lists NVARCHAR(MAX) = (
    SELECT STRING_AGG(CONVERT(NVARCHAR(MAX), N'"' + STRING_ESCAPE(k.ListKey, 'json') + N'":[' + k.Vals + N']'), N',')
    FROM (SELECT l.ListKey,
                 (SELECT STRING_AGG(CONVERT(NVARCHAR(MAX), N'"' + STRING_ESCAPE(x.Value, 'json') + N'"'), N',') WITHIN GROUP (ORDER BY x.SortOrder, x.Value)
                  FROM dbo.TA_Lookup x WHERE x.ListKey = l.ListKey AND x.IsActive = 1) AS Vals
          FROM (SELECT DISTINCT ListKey FROM dbo.TA_Lookup) l) k
    WHERE k.Vals IS NOT NULL);
  DECLARE @cc NVARCHAR(MAX) = (
    SELECT STRING_AGG(CONVERT(NVARCHAR(MAX), N'"' + STRING_ESCAPE(c.CostCentre, 'json') + N'"'), N',') WITHIN GROUP (ORDER BY c.CostCentre)
    FROM (SELECT DISTINCT CostCentre FROM dbo.TA_vw_Employee WHERE IsActive = 1 AND NULLIF(CostCentre, N'') IS NOT NULL) c);

  SELECT N'{"fields":' + ISNULL(@fields, N'[]') + N',"types":' + ISNULL(@types, N'[]') + N',"lookups":{' + ISNULL(@lists, N'')
       + CASE WHEN @cc IS NULL THEN N'' ELSE CASE WHEN @lists IS NULL THEN N'' ELSE N',' END + N'"COST_CENTRE":[' + @cc + N']' END + N'}}' AS JsonResult;
END
GO

CREATE OR ALTER PROCEDURE dbo.TA_usp_LookupEmployees @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  DECLARE @asApprover BIT = dbo.TA_fn_ActsAsApprover(@JsonParam);   -- the VIEW this call acts in (see TA_fn_ActsAsApprover)
  IF @asApprover = 0 THROW 50000, N'[FORBIDDEN] Employee lookup is available to approvers only', 1;

  DECLARE @q NVARCHAR(100) = ISNULL(LEFT(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.Query'))), 100), N'');
  DECLARE @like NVARCHAR(220) = N'%' + REPLACE(REPLACE(REPLACE(@q, N'[', N'[[]'), N'%', N'[%]'), N'_', N'[_]') + N'%';

  SELECT ISNULL((SELECT TOP (50) e.EmployeeCode AS code, e.Name AS name, e.Department AS department, e.CostCentre AS costCentre, e.Grade AS grade
                 FROM dbo.TA_vw_Employee e
                 WHERE e.IsActive = 1 AND (e.EmployeeCode LIKE @like OR e.Name LIKE @like OR e.Department LIKE @like)
                 ORDER BY e.Name FOR JSON PATH, INCLUDE_NULL_VALUES), N'[]') AS JsonResult;
END
GO

/* Registers a file that execProcedure.js has ALREADY written to disk (it adds StoredFileName and FilePath, and removes Base64Content).
   The file is "unlinked" until a request or receipt references it. */
CREATE OR ALTER PROCEDURE dbo.TA_usp_UploadAttachment @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  IF NOT EXISTS (SELECT 1 FROM dbo.TA_vw_Employee WHERE EmployeeCode = @me AND IsActive = 1) THROW 50000, N'[FORBIDDEN] Your account is not set up for Travel Claim.', 1;

  DECLARE @doc NVARCHAR(40)  = UPPER(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.DocType'))));
  DECLARE @name NVARCHAR(260) = LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.FileName')));
  DECLARE @mime NVARCHAR(100) = LOWER(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.MimeType'))));
  DECLARE @size BIGINT = TRY_CAST(JSON_VALUE(@JsonParam, '$.Size') AS BIGINT);
  DECLARE @stored NVARCHAR(260) = JSON_VALUE(@JsonParam, '$.StoredFileName');
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
  VALUES (@me, @doc, @stored, @name, @size, @mime);

  SELECT (SELECT @stored AS storedFileName FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS JsonResult;
END
GO

/* For the file-view route (server.js): may the caller open this stored file?  Owner, or anyone who can see a request/receipt that uses it.
   The route should call this BEFORE sendFile for DocTypes starting with TA_. Returns {"allowed":true|false}. */
CREATE OR ALTER PROCEDURE dbo.TA_usp_CanViewAttachment @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  DECLARE @doc NVARCHAR(40) = UPPER(JSON_VALUE(@JsonParam, '$.DocType'));
  DECLARE @file NVARCHAR(260) = JSON_VALUE(@JsonParam, '$.FileName');

  DECLARE @ok BIT = CASE WHEN EXISTS (
      SELECT 1 FROM dbo.TA_Attachment a
      WHERE a.DocType = @doc AND a.StoredFileName = @file
        AND (a.OwnerCode = @me
             OR EXISTS (SELECT 1 FROM dbo.TA_AttachmentLink k JOIN dbo.TA_fn_Visible(@me, dbo.TA_fn_IsApprover(@me)) v ON v.RequestId = k.RequestId WHERE k.AttachmentId = a.AttachmentId)
             OR EXISTS (SELECT 1 FROM dbo.TA_Receipt rc JOIN dbo.TA_fn_Visible(@me, dbo.TA_fn_IsApprover(@me)) v2 ON v2.RequestId = rc.UsedInRequestId WHERE rc.AttachmentId = a.AttachmentId))
    ) THEN 1 ELSE 0 END;
  SELECT CASE WHEN @ok = 1 THEN N'{"allowed":true}' ELSE N'{"allowed":false}' END AS JsonResult;
END
GO

-- Stamp: this script is installed at revision 2026-10-28-b (the app compares it with the revision it expects).
MERGE dbo.TA_SchemaVersion AS t USING (VALUES (N'04_procs_session_files', N'2026-10-28-b')) AS s (ScriptName, Rev) ON t.ScriptName = s.ScriptName
WHEN MATCHED THEN UPDATE SET Rev = s.Rev, AppliedAt = SYSDATETIME()
WHEN NOT MATCHED THEN INSERT (ScriptName, Rev) VALUES (s.ScriptName, s.Rev);
GO
