-- Travel Claim (TA_) procedures, part 2: requests (claim / travel / advance).  Run after 04. Re-runnable.
-- Business rules implemented here mirror the screens' tested domain logic (src/domain/*.ts): the browser checks are conveniences, THESE are the checks.
-- Requires SQL Server 2017+ (STRING_AGG, TRIM-free JSON paths, variable JSON paths).
SET NOCOUNT ON;
GO

/* Internal (NOT whitelisted, never called from the API): next request number for a scope, concurrency-safe.
   Claims EMPCODE/YYYY/NNNN (per employee and year), travel TR/YYYY/NNNN, advance AR/YYYY/NNNN. Must run inside the caller's transaction.
   The UPDATE ... WITH (UPDLOCK, HOLDLOCK) also range-locks a missing key, so two sessions cannot both insert the same scope; in rare
   races one session is chosen as a deadlock victim and the client simply retries. */
CREATE OR ALTER PROCEDURE dbo.TA_usp_Internal_NextNumber
  @Kind NVARCHAR(10), @EmployeeCode NVARCHAR(30), @Year INT, @Number NVARCHAR(40) OUTPUT
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @key NVARCHAR(80) = CASE @Kind WHEN N'claim' THEN CONCAT(N'CLAIM:', @EmployeeCode, N':', @Year)
                                         WHEN N'travel' THEN CONCAT(N'TR:', @Year) ELSE CONCAT(N'AR:', @Year) END;
  DECLARE @n INT;
  UPDATE dbo.TA_Counter WITH (UPDLOCK, HOLDLOCK) SET @n = LastValue = LastValue + 1 WHERE CounterKey = @key;
  IF @@ROWCOUNT = 0
  BEGIN
    INSERT dbo.TA_Counter (CounterKey, LastValue) VALUES (@key, 1);
    SET @n = 1;
  END
  SET @Number = CASE @Kind WHEN N'claim' THEN CONCAT(@EmployeeCode, N'/', @Year, N'/')
                           WHEN N'travel' THEN CONCAT(N'TR/', @Year, N'/') ELSE CONCAT(N'AR/', @Year, N'/') END
              + RIGHT(CONCAT(N'0000', @n), CASE WHEN @n > 9999 THEN LEN(CONVERT(NVARCHAR(10), @n)) ELSE 4 END);
END
GO

/* ---------------------------------------------------------------------------------------------------------------------------
   List: { Kind?, EmployeeCode?, Status?, Search?, From?, To?, Page?, PageSize?, SortKey?, SortDir? } -> { rows: [Request], total }
   EmployeeCode is honoured for approvers only. Paging is applied only when both Page and PageSize are given.
--------------------------------------------------------------------------------------------------------------------------- */
CREATE OR ALTER PROCEDURE dbo.TA_usp_ListRequests @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  DECLARE @asApprover BIT = dbo.TA_fn_ActsAsApprover(@JsonParam);   -- the VIEW this call acts in (see TA_fn_ActsAsApprover)

  DECLARE @kind NVARCHAR(10) = NULLIF(JSON_VALUE(@JsonParam, '$.Kind'), N'');
  DECLARE @emp NVARCHAR(30) = NULLIF(JSON_VALUE(@JsonParam, '$.EmployeeCode'), N'');
  IF @asApprover = 0 SET @emp = NULL;                       -- an employee can never widen the scope with a filter
  DECLARE @status NVARCHAR(10) = NULLIF(JSON_VALUE(@JsonParam, '$.Status'), N'');
  DECLARE @search NVARCHAR(200) = NULLIF(LEFT(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.Search'))), 200), N'');
  DECLARE @from DATE = TRY_CAST(NULLIF(JSON_VALUE(@JsonParam, '$.From'), N'') AS DATE);
  DECLARE @to DATE = TRY_CAST(NULLIF(JSON_VALUE(@JsonParam, '$.To'), N'') AS DATE);
  DECLARE @page INT = TRY_CAST(JSON_VALUE(@JsonParam, '$.Page') AS INT);
  DECLARE @size INT = TRY_CAST(JSON_VALUE(@JsonParam, '$.PageSize') AS INT);
  DECLARE @sortKey NVARCHAR(30) = ISNULL(NULLIF(JSON_VALUE(@JsonParam, '$.SortKey'), N''), N'requestDate');
  DECLARE @desc BIT = CASE WHEN LOWER(ISNULL(JSON_VALUE(@JsonParam, '$.SortDir'), N'desc')) = N'asc' THEN 0 ELSE 1 END;
  IF @sortKey NOT IN (N'requestNumber', N'employeeName', N'purpose', N'requestDate', N'submittedOn', N'approvedOn', N'total', N'approved', N'status', N'expenseType')
    SET @sortKey = N'requestDate';                                          -- whitelist: the key is never concatenated into SQL
  DECLARE @like NVARCHAR(420) = CASE WHEN @search IS NULL THEN NULL
    ELSE N'%' + REPLACE(REPLACE(REPLACE(@search, N'[', N'[[]'), N'%', N'[%]'), N'_', N'[_]') + N'%' END;

  CREATE TABLE #R (RowNo INT IDENTITY(1,1) NOT NULL PRIMARY KEY, RequestId UNIQUEIDENTIFIER NOT NULL);
  INSERT #R (RequestId)
  SELECT s.RequestId
  FROM dbo.TA_vw_RequestSummary s JOIN dbo.TA_fn_Visible(@me, @asApprover) v ON v.RequestId = s.RequestId
  WHERE (@kind IS NULL OR s.Kind = @kind) AND (@emp IS NULL OR s.EmployeeCode = @emp) AND (@status IS NULL OR s.Status = @status)
    AND (@from IS NULL OR s.RequestDate >= @from) AND (@to IS NULL OR s.RequestDate <= @to)
    AND (@like IS NULL OR CONCAT(s.RequestNumber, N' ', s.EmployeeName, N' ', s.EmployeeCode, N' ', s.Purpose, N' ', s.Remarks, N' ', s.Destination, N' ', ISNULL(s.TypeLabel, N'')) LIKE @like)
  ORDER BY
    CASE WHEN @sortKey = N'requestNumber' AND @desc = 0 THEN s.RequestNumber END ASC,   CASE WHEN @sortKey = N'requestNumber' AND @desc = 1 THEN s.RequestNumber END DESC,
    CASE WHEN @sortKey = N'employeeName'  AND @desc = 0 THEN s.EmployeeName END ASC,    CASE WHEN @sortKey = N'employeeName'  AND @desc = 1 THEN s.EmployeeName END DESC,
    CASE WHEN @sortKey = N'purpose'       AND @desc = 0 THEN s.Purpose END ASC,         CASE WHEN @sortKey = N'purpose'       AND @desc = 1 THEN s.Purpose END DESC,
    CASE WHEN @sortKey = N'requestDate'   AND @desc = 0 THEN s.RequestDate END ASC,     CASE WHEN @sortKey = N'requestDate'   AND @desc = 1 THEN s.RequestDate END DESC,
    CASE WHEN @sortKey = N'submittedOn'   AND @desc = 0 THEN s.SubmittedOn END ASC,     CASE WHEN @sortKey = N'submittedOn'   AND @desc = 1 THEN s.SubmittedOn END DESC,
    CASE WHEN @sortKey = N'approvedOn'    AND @desc = 0 THEN s.ApprovedOn END ASC,      CASE WHEN @sortKey = N'approvedOn'    AND @desc = 1 THEN s.ApprovedOn END DESC,
    CASE WHEN @sortKey = N'total'         AND @desc = 0 THEN s.Total END ASC,           CASE WHEN @sortKey = N'total'         AND @desc = 1 THEN s.Total END DESC,
    CASE WHEN @sortKey = N'approved'      AND @desc = 0 THEN ISNULL(s.ApprovedTotal, -1) END ASC, CASE WHEN @sortKey = N'approved' AND @desc = 1 THEN ISNULL(s.ApprovedTotal, -1) END DESC,
    CASE WHEN @sortKey = N'expenseType'   AND @desc = 0 THEN s.TypeShort END ASC,       CASE WHEN @sortKey = N'expenseType'   AND @desc = 1 THEN s.TypeShort END DESC,
    CASE WHEN @sortKey = N'status' AND @desc = 0 THEN CASE s.Status WHEN N'draft' THEN 0 WHEN N'submitted' THEN 1 WHEN N'approved' THEN 2 ELSE 3 END END ASC,
    CASE WHEN @sortKey = N'status' AND @desc = 1 THEN CASE s.Status WHEN N'draft' THEN 0 WHEN N'submitted' THEN 1 WHEN N'approved' THEN 2 ELSE 3 END END DESC,
    s.UpdatedAt DESC, s.RequestId;

  DECLARE @total INT = (SELECT COUNT(*) FROM #R);
  DECLARE @paged BIT = CASE WHEN @page IS NOT NULL AND @size IS NOT NULL AND @page >= 1 AND @size >= 1 THEN 1 ELSE 0 END;
  DECLARE @lo INT = CASE WHEN @paged = 1 THEN (@page - 1) * @size + 1 ELSE 1 END;
  DECLARE @hi INT = CASE WHEN @paged = 1 THEN @page * @size ELSE 2147483647 END;
  DECLARE @rows NVARCHAR(MAX) = (SELECT STRING_AGG(CONVERT(NVARCHAR(MAX), dbo.TA_fn_RequestJson(r.RequestId)), N',') WITHIN GROUP (ORDER BY r.RowNo)
                                 FROM #R r WHERE r.RowNo BETWEEN @lo AND @hi);
  SELECT N'{"rows":[' + ISNULL(@rows, N'') + N'],"total":' + CONVERT(NVARCHAR(20), @total) + N'}' AS JsonResult;
END
GO

/* Get: { Kind, Id } -> Request.  Unreadable and missing look the same. */
CREATE OR ALTER PROCEDURE dbo.TA_usp_GetRequest @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  DECLARE @asApprover BIT = dbo.TA_fn_ActsAsApprover(@JsonParam);   -- the VIEW this call acts in (see TA_fn_ActsAsApprover)
  DECLARE @id UNIQUEIDENTIFIER = TRY_CONVERT(UNIQUEIDENTIFIER, JSON_VALUE(@JsonParam, '$.Id'));
  DECLARE @kind NVARCHAR(10) = JSON_VALUE(@JsonParam, '$.Kind');
  IF @id IS NULL OR NOT EXISTS (SELECT 1 FROM dbo.TA_Request r JOIN dbo.TA_fn_Visible(@me, @asApprover) v ON v.RequestId = r.RequestId WHERE r.RequestId = @id AND r.Kind = @kind)
    THROW 50000, N'[NOT_FOUND] Record not found', 1;
  SELECT dbo.TA_fn_RequestJson(@id) AS JsonResult;
END
GO

/* ---------------------------------------------------------------------------------------------------------------------------
   Save draft: { Kind, Request:{...} } -> Request.   Creates (assigning the number) or updates a DRAFT.
   Ignored on purpose: id (a new id is generated), requestNumber, status, approver, dates, approved amounts, settled, approver text.
--------------------------------------------------------------------------------------------------------------------------- */
CREATE OR ALTER PROCEDURE dbo.TA_usp_SaveRequestDraft @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  DECLARE @isApprover BIT = dbo.TA_fn_ActsAsApprover(@JsonParam);   -- the VIEW this call acts in
  DECLARE @kind NVARCHAR(10) = JSON_VALUE(@JsonParam, '$.Kind');
  DECLARE @req NVARCHAR(MAX) = JSON_QUERY(@JsonParam, '$.Request');
  IF @kind IS NULL OR @kind NOT IN (N'claim', N'travel', N'advance') OR @req IS NULL THROW 50000, N'[VALIDATION] Unknown request type.', 1;
  DECLARE @today DATE = dbo.TA_fn_Today();

  /* ---- existing draft? ---- */
  DECLARE @id UNIQUEIDENTIFIER = TRY_CONVERT(UNIQUEIDENTIFIER, JSON_VALUE(@req, '$.id'));
  DECLARE @existing BIT = 0, @status NVARCHAR(10), @exCode NVARCHAR(30), @exBy NVARCHAR(30), @number NVARCHAR(40);
  IF @id IS NOT NULL
    SELECT @existing = 1, @status = r.Status, @exCode = r.EmployeeCode, @exBy = r.CreatedBy, @number = r.RequestNumber
    FROM dbo.TA_Request r WHERE r.RequestId = @id AND r.Kind = @kind;
  IF @existing = 1
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM dbo.TA_fn_Visible(@me, @isApprover) v WHERE v.RequestId = @id) THROW 50000, N'[NOT_FOUND] Record not found', 1;
    IF @status <> N'draft' THROW 50000, N'[CONFLICT] Only drafts can be edited', 1;
    IF NOT (@exCode = @me OR (@isApprover = 1 AND @exBy = @me)) THROW 50000, N'[FORBIDDEN] You cannot edit this request', 1;
  END

  /* ---- who is it for? an employee always saves for themself; an approver may name another existing employee ---- */
  DECLARE @reqCode NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@req, '$.employeeCode'))), N'');
  IF @existing = 1 AND @isApprover = 1 AND @reqCode IS NOT NULL AND @reqCode <> @exCode THROW 50000, N'[VALIDATION] Employee cannot be changed on a saved draft', 1;
  DECLARE @empCode NVARCHAR(30) = CASE WHEN @existing = 1 THEN @exCode WHEN @isApprover = 1 THEN @reqCode ELSE @me END;
  DECLARE @empName NVARCHAR(100), @empCC NVARCHAR(100);
  SELECT @empName = e.Name, @empCC = e.CostCentre FROM dbo.TA_vw_Employee e WHERE e.EmployeeCode = @empCode AND e.IsActive = 1;
  IF @empName IS NULL THROW 50000, N'[VALIDATION] Employee Code: Enter a valid employee code', 1;

  DECLARE @reqDate DATE = TRY_CAST(NULLIF(JSON_VALUE(@req, '$.requestDate'), N'') AS DATE);
  IF @reqDate IS NULL THROW 50000, N'[VALIDATION] Request Date: Required', 1;
  IF @reqDate > @today THROW 50000, N'[VALIDATION] Request Date: Cannot be in the future', 1;
  DECLARE @cc NVARCHAR(100) = ISNULL(NULLIF(LTRIM(RTRIM(LEFT(JSON_VALUE(@req, '$.costCentre'), 100))), N''), ISNULL(@empCC, N''));

  /* ---- kind-specific header values (OPENJSON WITH, so long text is not cut at 4000 characters) ---- */
  DECLARE @type NVARCHAR(12), @purpose NVARCHAR(500), @tf DATE, @tt DATE, @empComments NVARCHAR(MAX);
  DECLARE @tPurpose NVARCHAR(200), @tRemarks NVARCHAR(MAX), @tFrom NVARCHAR(100), @tTo NVARCHAR(100), @pFrom DATETIME2(0), @pTo DATETIME2(0),
          @advReq DECIMAL(18,2), @overall NVARCHAR(MAX), @along NVARCHAR(300), @leave BIT;
  DECLARE @aFrom DATE, @aTo DATE, @aAmount DECIMAL(18,2), @aPurpose NVARCHAR(200), @aRemarks NVARCHAR(MAX), @aTravelNo NVARCHAR(40);

  IF @kind = N'claim'
  BEGIN
    SELECT @type = h.expenseType, @purpose = ISNULL(LEFT(h.purpose, 500), N''), @tf = TRY_CAST(NULLIF(h.travelFrom, N'') AS DATE),
           @tt = TRY_CAST(NULLIF(h.travelTo, N'') AS DATE), @empComments = ISNULL(h.employeeComments, N'')
    FROM OPENJSON(@req) WITH (expenseType NVARCHAR(12), purpose NVARCHAR(MAX), travelFrom NVARCHAR(20), travelTo NVARCHAR(20), employeeComments NVARCHAR(MAX)) h;
    IF NOT EXISTS (SELECT 1 FROM dbo.TA_ExpenseType WHERE TypeKey = @type) THROW 50000, N'[VALIDATION] Expense Type: choose a valid expense type', 1;
  END
  ELSE IF @kind = N'travel'
  BEGIN
    DECLARE @advRaw NVARCHAR(40), @pfRaw NVARCHAR(30), @ptRaw NVARCHAR(30);
    SELECT @tPurpose = ISNULL(LEFT(h.purpose, 200), N''), @tRemarks = ISNULL(h.remarks, N''), @tFrom = ISNULL(LEFT(h.fromLocation, 100), N''), @tTo = ISNULL(LEFT(h.toLocation, 100), N''),
           @pfRaw = h.periodFrom, @ptRaw = h.periodTo, @advRaw = h.advanceRequired, @overall = ISNULL(h.overallRemarks, N''), @along = ISNULL(LEFT(h.alongWith, 300), N''), @leave = ISNULL(h.createLeave, 0)
    FROM OPENJSON(@req) WITH (purpose NVARCHAR(MAX), remarks NVARCHAR(MAX), fromLocation NVARCHAR(MAX), toLocation NVARCHAR(MAX), periodFrom NVARCHAR(30), periodTo NVARCHAR(30),
                              advanceRequired NVARCHAR(40), overallRemarks NVARCHAR(MAX), alongWith NVARCHAR(MAX), createLeave BIT) h;
    SET @pFrom = TRY_CAST(NULLIF(@pfRaw, N'') AS DATETIME2(0));
    SET @pTo = TRY_CAST(NULLIF(@ptRaw, N'') AS DATETIME2(0));
    SET @advReq = TRY_CAST(NULLIF(@advRaw, N'') AS DECIMAL(18,2));
    IF @advReq < 0 THROW 50000, N'[VALIDATION] Advance Amount Required: Cannot be negative', 1;
  END
  ELSE
  BEGIN
    DECLARE @afRaw NVARCHAR(30), @atRaw NVARCHAR(30), @amtRaw NVARCHAR(40);
    SELECT @afRaw = h.periodFrom, @atRaw = h.periodTo, @amtRaw = h.amount, @aPurpose = ISNULL(LEFT(h.purpose, 200), N''), @aRemarks = ISNULL(h.remarks, N''),
           @along = ISNULL(LEFT(h.alongWith, 300), N''), @leave = ISNULL(h.createLeave, 0), @aTravelNo = ISNULL(LEFT(h.travelRequest, 40), N'')
    FROM OPENJSON(@req) WITH (periodFrom NVARCHAR(30), periodTo NVARCHAR(30), amount NVARCHAR(40), purpose NVARCHAR(MAX), remarks NVARCHAR(MAX), alongWith NVARCHAR(MAX),
                              createLeave BIT, travelRequest NVARCHAR(MAX)) h;
    SET @aFrom = TRY_CAST(NULLIF(@afRaw, N'') AS DATE);
    SET @aTo = TRY_CAST(NULLIF(@atRaw, N'') AS DATE);
    SET @aAmount = TRY_CAST(NULLIF(@amtRaw, N'') AS DECIMAL(18,2));
    IF @aAmount < 0 THROW 50000, N'[VALIDATION] Amount: Cannot be negative', 1;
  END

  CREATE TABLE #OldLinks (AttachmentId UNIQUEIDENTIFIER NOT NULL PRIMARY KEY);
  BEGIN TRAN;

  IF @existing = 1
  BEGIN
    INSERT #OldLinks (AttachmentId) SELECT DISTINCT AttachmentId FROM dbo.TA_AttachmentLink WHERE RequestId = @id;
    UPDATE dbo.TA_Request SET CostCentre = @cc, RequestDate = @reqDate, UpdatedAt = SYSDATETIME() WHERE RequestId = @id;
  END
  ELSE
  BEGIN
    SET @id = NEWID();
    DECLARE @yr INT = YEAR(@today);      -- EXEC parameters must be variables or literals, not expressions
    EXEC dbo.TA_usp_Internal_NextNumber @kind, @empCode, @yr, @number OUTPUT;
    INSERT dbo.TA_Request (RequestId, Kind, RequestNumber, EmployeeCode, EmployeeName, CostCentre, RequestDate, Status, CreatedBy)
    VALUES (@id, @kind, @number, @empCode, @empName, @cc, @reqDate, N'draft', @me);
  END

  /* ---- detach everything this request held; the payload below re-attaches exactly what is still wanted ---- */
  UPDATE dbo.TA_Receipt SET UsedInRequestId = NULL, UsedInLineId = NULL WHERE UsedInRequestId = @id;
  DELETE dbo.TA_AttachmentLink WHERE RequestId = @id;

  CREATE TABLE #Atts (LineId NVARCHAR(64) NOT NULL, Ord INT NOT NULL, FileId NVARCHAR(260) NULL, DocType NVARCHAR(40) NULL, ReceiptId UNIQUEIDENTIFIER NULL);

  IF @kind = N'claim'
  BEGIN
    IF @existing = 0
      INSERT dbo.TA_Claim (RequestId, ExpenseType, Purpose, TravelFrom, TravelTo, EmployeeComments) VALUES (@id, @type, @purpose, @tf, @tt, @empComments);
    ELSE
      UPDATE dbo.TA_Claim SET ExpenseType = @type, Purpose = @purpose, TravelFrom = @tf, TravelTo = @tt, EmployeeComments = @empComments WHERE RequestId = @id;
    DELETE dbo.TA_ClaimLine WHERE RequestId = @id;

    CREATE TABLE #Lines (Ord INT NOT NULL, LineId NVARCHAR(64) NULL, ItemKey NVARCHAR(30) NULL, Fields NVARCHAR(MAX) NOT NULL, Atts NVARCHAR(MAX) NULL);
    INSERT #Lines (Ord, LineId, ItemKey, Fields, Atts)
    SELECT CAST(j.[key] AS INT), NULLIF(LTRIM(RTRIM(LEFT(JSON_VALUE(j.value, '$.id'), 64))), N''), JSON_VALUE(j.value, '$.itemKey'),
           ISNULL(JSON_QUERY(j.value, '$.fields'), N'{}'), JSON_QUERY(j.value, '$.attachments')
    FROM OPENJSON(@req, '$.items') j;
    UPDATE #Lines SET LineId = LOWER(CONVERT(NVARCHAR(36), NEWID())) WHERE LineId IS NULL;
    IF EXISTS (SELECT 1 FROM #Lines GROUP BY LineId HAVING COUNT(*) > 1) THROW 50000, N'[VALIDATION] Two lines have the same id.', 1;
    IF EXISTS (SELECT 1 FROM #Lines l LEFT JOIN dbo.TA_ExpenseItem i ON i.ItemKey = l.ItemKey AND i.TypeKey = @type WHERE i.ItemKey IS NULL)
      THROW 50000, N'[VALIDATION] An expense item does not belong to this expense type.', 1;
    IF EXISTS (SELECT 1 FROM #Lines WHERE ISJSON(Fields) = 0) THROW 50000, N'[VALIDATION] A line has unreadable fields.', 1;

    -- Fuel by kilometres: claimable totalKm and amount are ALWAYS computed here (client values are ignored).
    DECLARE @twoW DECIMAL(18,2) = ISNULL(TRY_CAST(dbo.TA_fn_Setting(N'RateTwoWheelerPerKm') AS DECIMAL(18,2)), 4);
    DECLARE @fourW DECIMAL(18,2) = ISNULL(TRY_CAST(dbo.TA_fn_Setting(N'RateFourWheelerPerKm') AS DECIMAL(18,2)), 9);
    UPDATE l SET Fields = JSON_MODIFY(JSON_MODIFY(l.Fields, '$.totalKm', b.claimable), '$.amount',
                           ROUND(b.claimable * CASE i.RateKey WHEN N'twoWheelerPerKm' THEN @twoW ELSE @fourW END, 2))
    FROM #Lines l
    JOIN dbo.TA_ExpenseItem i ON i.ItemKey = l.ItemKey AND i.Compute = N'fuelKm'
    CROSS APPLY (SELECT f = ISNULL(TRY_CAST(JSON_VALUE(l.Fields, '$.fromKm') AS DECIMAL(18,2)), 0),
                        t = ISNULL(TRY_CAST(JSON_VALUE(l.Fields, '$.toKm') AS DECIMAL(18,2)), 0),
                        n = ISNULL(TRY_CAST(JSON_VALUE(l.Fields, '$.nonAccountableKm') AS DECIMAL(18,2)), 0)) k
    CROSS APPLY (SELECT total = CASE WHEN k.t - k.f > 0 THEN k.t - k.f ELSE CAST(0 AS DECIMAL(18,2)) END) a
    CROSS APPLY (SELECT claimable = CASE WHEN a.total - k.n > 0 THEN a.total - k.n ELSE CAST(0 AS DECIMAL(18,2)) END) b;

    IF EXISTS (SELECT 1 FROM #Lines WHERE ISNULL(TRY_CAST(JSON_VALUE(Fields, '$.amount') AS DECIMAL(18,2)), 0) < 0)
      THROW 50000, N'[VALIDATION] Amount: Cannot be negative', 1;

    INSERT dbo.TA_ClaimLine (RequestId, LineId, SortOrder, ItemKey, FieldsJson, Amount, LineDate)
    SELECT @id, l.LineId, l.Ord, l.ItemKey, l.Fields,
           ISNULL(TRY_CAST(JSON_VALUE(l.Fields, '$.amount') AS DECIMAL(18,2)), 0),
           TRY_CAST(COALESCE(NULLIF(JSON_VALUE(l.Fields, '$.date'), N''), NULLIF(JSON_VALUE(l.Fields, '$.fromDate'), N'')) AS DATE)
    FROM #Lines l;

    INSERT #Atts (LineId, Ord, FileId, DocType, ReceiptId)
    SELECT l.LineId, CAST(a.[key] AS INT), JSON_VALUE(a.value, '$.fileId'), UPPER(JSON_VALUE(a.value, '$.docType')), TRY_CONVERT(UNIQUEIDENTIFIER, JSON_VALUE(a.value, '$.receiptId'))
    FROM #Lines l CROSS APPLY OPENJSON(ISNULL(l.Atts, N'[]')) a;
  END
  ELSE IF @kind = N'travel'
  BEGIN
    IF @existing = 0
      INSERT dbo.TA_Travel (RequestId, Purpose, Remarks, FromLocation, ToLocation, PeriodFrom, PeriodTo, AdvanceRequired, OverallRemarks, AlongWith, CreateLeave)
      VALUES (@id, @tPurpose, @tRemarks, @tFrom, @tTo, @pFrom, @pTo, @advReq, @overall, @along, @leave);
    ELSE
      UPDATE dbo.TA_Travel SET Purpose = @tPurpose, Remarks = @tRemarks, FromLocation = @tFrom, ToLocation = @tTo, PeriodFrom = @pFrom, PeriodTo = @pTo,
             AdvanceRequired = @advReq, OverallRemarks = @overall, AlongWith = @along, CreateLeave = @leave WHERE RequestId = @id;
    DELETE dbo.TA_TravelEstimate WHERE RequestId = @id;
    IF EXISTS (SELECT 1 FROM OPENJSON(@req, '$.items') j WHERE ISNULL(TRY_CAST(NULLIF(JSON_VALUE(j.value, '$.amount'), N'') AS DECIMAL(18,2)), 0) < 0)
      THROW 50000, N'[VALIDATION] Estimate amounts cannot be negative', 1;
    INSERT dbo.TA_TravelEstimate (RequestId, LineId, SortOrder, Item, Amount, Remarks)
    SELECT @id, ISNULL(NULLIF(LTRIM(RTRIM(LEFT(JSON_VALUE(j.value, '$.id'), 64))), N''), LOWER(CONVERT(NVARCHAR(36), NEWID()))) , CAST(j.[key] AS INT),
           ISNULL(LEFT(JSON_VALUE(j.value, '$.item'), 60), N''), TRY_CAST(NULLIF(JSON_VALUE(j.value, '$.amount'), N'') AS DECIMAL(18,2)), ISNULL(LEFT(JSON_VALUE(j.value, '$.remarks'), 300), N'')
    FROM OPENJSON(@req, '$.items') j;
  END
  ELSE
  BEGIN
    IF @existing = 0
      INSERT dbo.TA_Advance (RequestId, PeriodFrom, PeriodTo, Amount, Purpose, Remarks, AlongWith, CreateLeave, TravelRequestNo)
      VALUES (@id, @aFrom, @aTo, @aAmount, @aPurpose, @aRemarks, @along, @leave, @aTravelNo);
    ELSE
      UPDATE dbo.TA_Advance SET PeriodFrom = @aFrom, PeriodTo = @aTo, Amount = @aAmount, Purpose = @aPurpose, Remarks = @aRemarks, AlongWith = @along,
             CreateLeave = @leave, TravelRequestNo = @aTravelNo WHERE RequestId = @id;
  END

  IF @kind <> N'claim'   -- documents attached to the request itself (travel / advance)
    INSERT #Atts (LineId, Ord, FileId, DocType, ReceiptId)
    SELECT N'', CAST(a.[key] AS INT), JSON_VALUE(a.value, '$.fileId'), UPPER(JSON_VALUE(a.value, '$.docType')), NULL
    FROM OPENJSON(@req, '$.attachments') a;

  /* ---- receipts (claims only): they must be the employee's own, unused elsewhere, and used once ---- */
  IF EXISTS (SELECT 1 FROM #Atts x WHERE x.ReceiptId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.TA_Receipt rc WHERE rc.ReceiptId = x.ReceiptId AND rc.OwnerCode = @empCode))
    THROW 50000, N'[VALIDATION] A selected bill is not in your receipt box', 1;
  IF EXISTS (SELECT 1 FROM #Atts x JOIN dbo.TA_Receipt rc ON rc.ReceiptId = x.ReceiptId WHERE rc.UsedInRequestId IS NOT NULL)
    THROW 50000, N'[CONFLICT] A selected bill is already on another claim', 1;
  IF EXISTS (SELECT 1 FROM #Atts WHERE ReceiptId IS NOT NULL GROUP BY ReceiptId HAVING COUNT(*) > 1)
    THROW 50000, N'[CONFLICT] A bill is attached to more than one line', 1;
  UPDATE rc SET UsedInRequestId = @id, UsedInLineId = x.LineId FROM dbo.TA_Receipt rc JOIN #Atts x ON x.ReceiptId = rc.ReceiptId;

  /* ---- uploaded files: only the uploader (or the employee, or files this request already held) may attach them ---- */
  IF EXISTS (SELECT 1 FROM #Atts x
             WHERE x.ReceiptId IS NULL AND x.FileId IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM dbo.TA_Attachment a
                               WHERE a.DocType = x.DocType AND a.StoredFileName = x.FileId
                                 AND (a.OwnerCode IN (@me, @empCode) OR a.AttachmentId IN (SELECT AttachmentId FROM #OldLinks))))
    THROW 50000, N'[VALIDATION] An attached file was not found. Upload it again.', 1;
  INSERT dbo.TA_AttachmentLink (AttachmentId, RequestId, LineId, SortOrder)
  SELECT a.AttachmentId, @id, x.LineId, MIN(x.Ord)
  FROM #Atts x JOIN dbo.TA_Attachment a ON a.DocType = x.DocType AND a.StoredFileName = x.FileId
  WHERE x.ReceiptId IS NULL AND x.FileId IS NOT NULL
  GROUP BY a.AttachmentId, x.LineId;

  INSERT dbo.TA_RequestHistory (RequestId, RequestNumber, Action, ActedBy) VALUES (@id, @number, N'Saved', @me);
  COMMIT;

  SELECT dbo.TA_fn_RequestJson(@id) AS JsonResult;
END
GO

/* Delete a saved draft (frees its receipts; files stay on disk for the orphan clean-up job). */
CREATE OR ALTER PROCEDURE dbo.TA_usp_DeleteDraft @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  DECLARE @asApprover BIT = dbo.TA_fn_ActsAsApprover(@JsonParam);   -- the VIEW this call acts in (see TA_fn_ActsAsApprover)
  DECLARE @id UNIQUEIDENTIFIER = TRY_CONVERT(UNIQUEIDENTIFIER, JSON_VALUE(@JsonParam, '$.Id'));
  DECLARE @kind NVARCHAR(10) = JSON_VALUE(@JsonParam, '$.Kind');
  DECLARE @status NVARCHAR(10), @code NVARCHAR(30), @by NVARCHAR(30), @number NVARCHAR(40);
  SELECT @status = r.Status, @code = r.EmployeeCode, @by = r.CreatedBy, @number = r.RequestNumber
  FROM dbo.TA_Request r JOIN dbo.TA_fn_Visible(@me, @asApprover) v ON v.RequestId = r.RequestId WHERE r.RequestId = @id AND r.Kind = @kind;
  IF @status IS NULL THROW 50000, N'[NOT_FOUND] Record not found', 1;
  IF @status <> N'draft' THROW 50000, N'[CONFLICT] Only drafts can be deleted', 1;
  IF NOT (@code = @me OR (@asApprover = 1 AND @by = @me)) THROW 50000, N'[FORBIDDEN] You cannot delete this request', 1;

  BEGIN TRAN;
  UPDATE dbo.TA_Receipt SET UsedInRequestId = NULL, UsedInLineId = NULL WHERE UsedInRequestId = @id;
  DELETE dbo.TA_Request WHERE RequestId = @id;        -- cascades to the detail rows and attachment links
  INSERT dbo.TA_RequestHistory (RequestId, RequestNumber, Action, ActedBy) VALUES (@id, @number, N'Deleted', @me);
  COMMIT;
  SELECT CAST(NULL AS NVARCHAR(MAX)) AS JsonResult;
END
GO

/* Copy a REJECTED claim into a new draft (owner employee only). Approvals and rejection text are reset; bills still attached to the original
   claim through the receipt box are not carried over; uploaded files are re-linked (the stored file is shared). */
CREATE OR ALTER PROCEDURE dbo.TA_usp_CopyRejectedClaim @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  DECLARE @asApprover BIT = dbo.TA_fn_ActsAsApprover(@JsonParam);   -- the VIEW this call acts in (see TA_fn_ActsAsApprover)
  DECLARE @src UNIQUEIDENTIFIER = TRY_CONVERT(UNIQUEIDENTIFIER, JSON_VALUE(@JsonParam, '$.Id'));
  DECLARE @status NVARCHAR(10), @code NVARCHAR(30), @name NVARCHAR(100), @cc NVARCHAR(100);
  SELECT @status = r.Status, @code = r.EmployeeCode, @name = r.EmployeeName, @cc = r.CostCentre
  FROM dbo.TA_Request r JOIN dbo.TA_fn_Visible(@me, @asApprover) v ON v.RequestId = r.RequestId WHERE r.RequestId = @src AND r.Kind = N'claim';
  IF @status IS NULL THROW 50000, N'[NOT_FOUND] Record not found', 1;
  IF @status <> N'rejected' OR @code <> @me OR @asApprover = 1 THROW 50000, N'[FORBIDDEN] Only the owner can copy a rejected claim', 1;

  DECLARE @new UNIQUEIDENTIFIER = NEWID(), @number NVARCHAR(40), @today DATE = dbo.TA_fn_Today();
  CREATE TABLE #Map (OldLine NVARCHAR(64) NOT NULL PRIMARY KEY, NewLine NVARCHAR(64) NOT NULL);
  BEGIN TRAN;
  DECLARE @yr INT = YEAR(@today);
  EXEC dbo.TA_usp_Internal_NextNumber N'claim', @code, @yr, @number OUTPUT;
  INSERT dbo.TA_Request (RequestId, Kind, RequestNumber, EmployeeCode, EmployeeName, CostCentre, RequestDate, Status, CreatedBy)
  VALUES (@new, N'claim', @number, @code, @name, @cc, @today, N'draft', @me);
  INSERT dbo.TA_Claim (RequestId, ExpenseType, Purpose, TravelFrom, TravelTo, EmployeeComments)
  SELECT @new, c.ExpenseType, c.Purpose, c.TravelFrom, c.TravelTo, c.EmployeeComments FROM dbo.TA_Claim c WHERE c.RequestId = @src;
  INSERT #Map (OldLine, NewLine) SELECT LineId, LOWER(CONVERT(NVARCHAR(36), NEWID())) FROM dbo.TA_ClaimLine WHERE RequestId = @src;
  INSERT dbo.TA_ClaimLine (RequestId, LineId, SortOrder, ItemKey, FieldsJson, Amount, LineDate)
  SELECT @new, m.NewLine, l.SortOrder, l.ItemKey, l.FieldsJson, l.Amount, l.LineDate FROM dbo.TA_ClaimLine l JOIN #Map m ON m.OldLine = l.LineId WHERE l.RequestId = @src;
  INSERT dbo.TA_AttachmentLink (AttachmentId, RequestId, LineId, SortOrder)
  SELECT k.AttachmentId, @new, m.NewLine, k.SortOrder FROM dbo.TA_AttachmentLink k JOIN #Map m ON m.OldLine = k.LineId WHERE k.RequestId = @src;
  INSERT dbo.TA_RequestHistory (RequestId, RequestNumber, Action, ActedBy, Details) VALUES (@new, @number, N'Copied', @me, N'Copied from a rejected claim');
  COMMIT;
  SELECT dbo.TA_fn_RequestJson(@new) AS JsonResult;
END
GO

/* ---------------------------------------------------------------------------------------------------------------------------
   Submit: re-validates EVERYTHING (the browser checks are conveniences), then Draft -> Submitted.
   Failures come back as ONE [VALIDATION] error whose message lists every problem on its own line.
--------------------------------------------------------------------------------------------------------------------------- */
CREATE OR ALTER PROCEDURE dbo.TA_usp_SubmitRequest @JsonParam NVARCHAR(MAX) AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  DECLARE @me NVARCHAR(30) = NULLIF(LTRIM(RTRIM(JSON_VALUE(@JsonParam, '$.ExecutedBy'))), N'');
  IF @me IS NULL THROW 50000, N'[UNAUTHORIZED] Not signed in', 1;
  DECLARE @asApprover BIT = dbo.TA_fn_ActsAsApprover(@JsonParam);   -- the VIEW this call acts in (see TA_fn_ActsAsApprover)
  DECLARE @id UNIQUEIDENTIFIER = TRY_CONVERT(UNIQUEIDENTIFIER, JSON_VALUE(@JsonParam, '$.Id'));
  DECLARE @kind NVARCHAR(10) = JSON_VALUE(@JsonParam, '$.Kind');
  DECLARE @status NVARCHAR(10), @code NVARCHAR(30), @by NVARCHAR(30), @number NVARCHAR(40), @reqDate DATE, @cc NVARCHAR(100);
  SELECT @status = r.Status, @code = r.EmployeeCode, @by = r.CreatedBy, @number = r.RequestNumber, @reqDate = r.RequestDate, @cc = r.CostCentre
  FROM dbo.TA_Request r JOIN dbo.TA_fn_Visible(@me, @asApprover) v ON v.RequestId = r.RequestId WHERE r.RequestId = @id AND r.Kind = @kind;
  IF @status IS NULL THROW 50000, N'[NOT_FOUND] Record not found', 1;
  IF @status <> N'draft' THROW 50000, N'[CONFLICT] Only drafts can be submitted', 1;
  IF NOT (@code = @me OR (@asApprover = 1 AND @by = @me)) THROW 50000, N'[FORBIDDEN] You cannot submit this request', 1;

  DECLARE @today DATE = dbo.TA_fn_Today();
  DECLARE @E TABLE (Ord INT IDENTITY(1,1) NOT NULL, Msg NVARCHAR(400) NOT NULL);
  IF @reqDate > @today INSERT @E (Msg) VALUES (N'Request Date: Cannot be in the future');

  IF @kind = N'claim'
  BEGIN
    DECLARE @purpose NVARCHAR(500), @type NVARCHAR(12), @tf DATE, @tt DATE, @showBal BIT, @travelPeriod BIT;
    SELECT @purpose = c.Purpose, @type = c.ExpenseType, @tf = c.TravelFrom, @tt = c.TravelTo, @showBal = t.ShowBalance, @travelPeriod = t.TravelPeriod
    FROM dbo.TA_Claim c JOIN dbo.TA_ExpenseType t ON t.TypeKey = c.ExpenseType WHERE c.RequestId = @id;
    IF NULLIF(LTRIM(RTRIM(@purpose)), N'') IS NULL INSERT @E (Msg) VALUES (N'Purpose: Required to submit');
    IF NULLIF(LTRIM(RTRIM(@cc)), N'') IS NULL INSERT @E (Msg) VALUES (N'Cost Centre: Select a cost centre');
    IF @travelPeriod = 1
    BEGIN
      IF @tf IS NULL INSERT @E (Msg) VALUES (N'Travel From: Required');
      IF @tt IS NULL INSERT @E (Msg) VALUES (N'Travel To: Required');
      ELSE IF @tf IS NOT NULL AND @tt < @tf INSERT @E (Msg) VALUES (N'Travel To: Must be on or after Travel From');
    END
    IF NOT EXISTS (SELECT 1 FROM dbo.TA_ClaimLine WHERE RequestId = @id) INSERT @E (Msg) VALUES (N'Add at least one expense line.');

    IF @showBal = 1
    BEGIN
      DECLARE @limit DECIMAL(18,2) = ISNULL(TRY_CAST(dbo.TA_fn_Setting(N'MedicalAnnualLimit') AS DECIMAL(18,2)), 15000);
      DECLARE @used DECIMAL(18,2) = dbo.TA_fn_MedicalUsed(@code, @id);
      DECLARE @bal DECIMAL(18,2) = CASE WHEN @limit - @used > 0 THEN @limit - @used ELSE 0 END;
      DECLARE @tot DECIMAL(18,2) = dbo.TA_fn_ClaimTotal(@id);
      IF @tot > @bal INSERT @E (Msg) VALUES (CONCAT(N'Total ', NCHAR(8377), FORMAT(@tot, N'N2', N'en-IN'), N' exceeds the available medical balance of ', NCHAR(8377), FORMAT(@bal, N'N2', N'en-IN'), N'.'));
    END

    -- one row per line with the values the rules need
    SELECT l.LineId, l.SortOrder + 1 AS N, l.ItemKey, i.Compute, i.FieldList, i.AttachmentOptional, l.Amount, l.FieldsJson,
           TRY_CAST(JSON_VALUE(l.FieldsJson, '$.fromKm') AS DECIMAL(18,2)) AS fromKm, TRY_CAST(JSON_VALUE(l.FieldsJson, '$.toKm') AS DECIMAL(18,2)) AS toKm,
           ISNULL(TRY_CAST(JSON_VALUE(l.FieldsJson, '$.nonAccountableKm') AS DECIMAL(18,2)), 0) AS nonAcc, TRY_CAST(JSON_VALUE(l.FieldsJson, '$.totalKm') AS DECIMAL(18,2)) AS totalKm,
           TRY_CAST(NULLIF(JSON_VALUE(l.FieldsJson, '$.qty'), N'') AS DECIMAL(18,2)) AS qty,
           TRY_CAST(NULLIF(JSON_VALUE(l.FieldsJson, '$.date'), N'') AS DATE) AS d, TRY_CAST(NULLIF(JSON_VALUE(l.FieldsJson, '$.fromDate'), N'') AS DATE) AS fromDate,
           TRY_CAST(NULLIF(JSON_VALUE(l.FieldsJson, '$.toDate'), N'') AS DATE) AS toDate, NULLIF(JSON_VALUE(l.FieldsJson, '$.fromTime'), N'') AS fromTime,
           NULLIF(JSON_VALUE(l.FieldsJson, '$.toTime'), N'') AS toTime, ISNULL(JSON_VALUE(l.FieldsJson, '$.amount'), N'') AS amountText,
           (SELECT COUNT(*) FROM dbo.TA_AttachmentLink k WHERE k.RequestId = l.RequestId AND k.LineId = l.LineId)
         + (SELECT COUNT(*) FROM dbo.TA_Receipt rc WHERE rc.UsedInRequestId = l.RequestId AND rc.UsedInLineId = l.LineId) AS bills
    INTO #L FROM dbo.TA_ClaimLine l JOIN dbo.TA_ExpenseItem i ON i.ItemKey = l.ItemKey WHERE l.RequestId = @id;

    -- required fields of the item (computed fields and the bill itself are handled separately)
    INSERT @E (Msg)
    SELECT CONCAT(N'Line ', l.N, N': ', fd.Label, N': Required')
    FROM #L l CROSS APPLY OPENJSON(l.FieldList) s
    JOIN dbo.TA_FieldDef fd ON fd.FieldKey = s.value AND fd.IsRequired = 1 AND fd.IsComputed = 0 AND fd.FieldKey <> N'attachment'
    WHERE NULLIF(LTRIM(RTRIM(ISNULL(JSON_VALUE(l.FieldsJson, N'$.' + fd.FieldKey), N''))), N'') IS NULL
    ORDER BY l.N, CAST(s.[key] AS INT);

    -- fuel by kilometres
    INSERT @E (Msg) SELECT CONCAT(N'Line ', N, N': To KM: Must be greater than From KM') FROM #L WHERE Compute = N'fuelKm' AND fromKm IS NOT NULL AND toKm IS NOT NULL AND toKm <= fromKm;
    INSERT @E (Msg) SELECT CONCAT(N'Line ', N, N': KM ', NCHAR(8211), N' Non Accountable: Cannot exceed Total KM') FROM #L
      WHERE Compute = N'fuelKm' AND fromKm IS NOT NULL AND toKm IS NOT NULL AND toKm > fromKm AND nonAcc > toKm - fromKm;
    INSERT @E (Msg) SELECT CONCAT(N'Line ', N, N': To KM: No claimable distance after deductions') FROM #L
      WHERE Compute = N'fuelKm' AND fromKm IS NOT NULL AND toKm IS NOT NULL AND toKm > fromKm AND nonAcc <= toKm - fromKm AND Amount <= 0;
    -- amount, litres, dates, times
    INSERT @E (Msg) SELECT CONCAT(N'Line ', N, N': Amount: Enter an amount greater than zero') FROM #L WHERE ISNULL(Compute, N'') <> N'fuelKm' AND amountText <> N'' AND Amount <= 0;
    INSERT @E (Msg) SELECT CONCAT(N'Line ', N, N': Quantity (litres): Enter the litres filled') FROM #L
      WHERE EXISTS (SELECT 1 FROM OPENJSON(FieldList) f WHERE f.value = N'qty') AND qty IS NOT NULL AND qty <= 0;
    INSERT @E (Msg) SELECT CONCAT(N'Line ', N, N': To Date: Must be on or after From Date') FROM #L WHERE fromDate IS NOT NULL AND toDate IS NOT NULL AND toDate < fromDate;
    INSERT @E (Msg) SELECT CONCAT(N'Line ', N, N': To Time: Must be after From Time') FROM #L WHERE fromDate IS NOT NULL AND toDate = fromDate AND fromTime IS NOT NULL AND toTime IS NOT NULL AND toTime <= fromTime;
    INSERT @E (Msg) SELECT CONCAT(N'Line ', N, N': Date: Cannot be in the future') FROM #L WHERE d > @today;
    -- a bill is required unless the item says it is optional
    INSERT @E (Msg) SELECT CONCAT(N'Line ', N, N': Bills: Attach at least one bill') FROM #L
      WHERE EXISTS (SELECT 1 FROM OPENJSON(FieldList) f WHERE f.value = N'attachment') AND AttachmentOptional = 0 AND bills = 0;
  END
  ELSE IF @kind = N'travel'
  BEGIN
    DECLARE @tPurpose NVARCHAR(200), @tFrom NVARCHAR(100), @tTo NVARCHAR(100), @pFrom DATETIME2(0), @pTo DATETIME2(0), @adv DECIMAL(18,2);
    SELECT @tPurpose = Purpose, @tFrom = FromLocation, @tTo = ToLocation, @pFrom = PeriodFrom, @pTo = PeriodTo, @adv = AdvanceRequired FROM dbo.TA_Travel WHERE RequestId = @id;
    IF NULLIF(LTRIM(RTRIM(@tPurpose)), N'') IS NULL INSERT @E (Msg) VALUES (N'Travel Purpose: Select a purpose');
    IF NULLIF(LTRIM(RTRIM(@tFrom)), N'') IS NULL INSERT @E (Msg) VALUES (N'Travel Location From: Required');
    IF NULLIF(LTRIM(RTRIM(@tTo)), N'') IS NULL INSERT @E (Msg) VALUES (N'Travel Location To: Required');
    IF @pFrom IS NULL INSERT @E (Msg) VALUES (N'Travel Period From: Required');
    IF @pTo IS NULL INSERT @E (Msg) VALUES (N'Travel Period To: Required');
    ELSE IF @pFrom IS NOT NULL AND @pTo <= @pFrom INSERT @E (Msg) VALUES (N'Travel Period To: Must be after the start of the period');
    INSERT @E (Msg) SELECT CONCAT(N'Estimate item ', SortOrder + 1, N': Pick an item') FROM dbo.TA_TravelEstimate WHERE RequestId = @id AND (Item <> N'' OR ISNULL(Amount, 0) > 0) AND Item = N'';
    INSERT @E (Msg) SELECT CONCAT(N'Estimate item ', SortOrder + 1, N': Enter an amount') FROM dbo.TA_TravelEstimate WHERE RequestId = @id AND (Item <> N'' OR ISNULL(Amount, 0) > 0) AND ISNULL(Amount, 0) <= 0;
    IF NOT EXISTS (SELECT 1 FROM dbo.TA_TravelEstimate WHERE RequestId = @id AND Item <> N'' AND ISNULL(Amount, 0) > 0) INSERT @E (Msg) VALUES (N'Add at least one estimate item with an amount.');
    IF @adv IS NOT NULL
    BEGIN
      DECLARE @est DECIMAL(18,2) = dbo.TA_fn_TravelEstimate(@id);
      DECLARE @advLimit DECIMAL(18,2) = ISNULL(TRY_CAST(dbo.TA_fn_Setting(N'AdvanceLimit') AS DECIMAL(18,2)), 15000);
      DECLARE @advBal DECIMAL(18,2) = CASE WHEN @advLimit - dbo.TA_fn_AdvanceUsed(@code, NULL) > 0 THEN @advLimit - dbo.TA_fn_AdvanceUsed(@code, NULL) ELSE 0 END;
      IF @adv > @est INSERT @E (Msg) VALUES (N'Advance Amount Required: Cannot exceed the total estimate');
      ELSE IF @adv > @advBal INSERT @E (Msg) VALUES (CONCAT(N'Advance Amount Required: Exceeds the available advance balance of ', NCHAR(8377), FORMAT(@advBal, N'N0', N'en-IN')));
    END
  END
  ELSE
  BEGIN
    DECLARE @aPurpose NVARCHAR(200), @aFrom DATE, @aTo DATE, @aAmount DECIMAL(18,2);
    SELECT @aPurpose = Purpose, @aFrom = PeriodFrom, @aTo = PeriodTo, @aAmount = Amount FROM dbo.TA_Advance WHERE RequestId = @id;
    IF NULLIF(LTRIM(RTRIM(@aPurpose)), N'') IS NULL INSERT @E (Msg) VALUES (N'Travel Purpose: Select a purpose');
    IF @aFrom IS NULL INSERT @E (Msg) VALUES (N'Travel Period From: Required');
    IF @aTo IS NULL INSERT @E (Msg) VALUES (N'Travel Period To: Required');
    ELSE IF @aFrom IS NOT NULL AND @aTo < @aFrom INSERT @E (Msg) VALUES (N'Travel Period To: Must be on or after the start date');
    IF ISNULL(@aAmount, 0) <= 0 INSERT @E (Msg) VALUES (N'Amount: Enter an amount greater than zero');
    ELSE
    BEGIN
      DECLARE @lim2 DECIMAL(18,2) = ISNULL(TRY_CAST(dbo.TA_fn_Setting(N'AdvanceLimit') AS DECIMAL(18,2)), 15000);
      DECLARE @bal2 DECIMAL(18,2) = CASE WHEN @lim2 - dbo.TA_fn_AdvanceUsed(@code, @id) > 0 THEN @lim2 - dbo.TA_fn_AdvanceUsed(@code, @id) ELSE 0 END;
      IF @aAmount > @bal2 INSERT @E (Msg) VALUES (CONCAT(N'Amount: Exceeds the available advance balance of ', NCHAR(8377), FORMAT(@bal2, N'N0', N'en-IN')));
    END
  END

  IF EXISTS (SELECT 1 FROM @E)
  BEGIN
    DECLARE @all NVARCHAR(MAX) = (SELECT STRING_AGG(CONVERT(NVARCHAR(MAX), Msg), NCHAR(10)) WITHIN GROUP (ORDER BY Ord) FROM @E);
    DECLARE @out NVARCHAR(2047) = LEFT(N'[VALIDATION] ' + @all, 2000);
    THROW 50000, @out, 1;
  END

  BEGIN TRAN;
  UPDATE dbo.TA_Request SET Status = N'submitted', SubmittedOn = @today, UpdatedAt = SYSDATETIME() WHERE RequestId = @id AND Status = N'draft';
  IF @@ROWCOUNT = 0 THROW 50000, N'[CONFLICT] The request was changed by someone else. Reload and try again.', 1;
  INSERT dbo.TA_RequestHistory (RequestId, RequestNumber, Action, ActedBy) VALUES (@id, @number, N'Submitted', @me);
  COMMIT;
  SELECT dbo.TA_fn_RequestJson(@id) AS JsonResult;
END
GO

-- Stamp: this script is installed at revision 2026-11-12-a (the app compares it with the revision it expects).
MERGE dbo.TA_SchemaVersion AS t USING (VALUES (N'05_procs_requests', N'2026-11-12-a')) AS s (ScriptName, Rev) ON t.ScriptName = s.ScriptName
WHEN MATCHED THEN UPDATE SET Rev = s.Rev, AppliedAt = SYSDATETIME()
WHEN NOT MATCHED THEN INSERT (ScriptName, Rev) VALUES (s.ScriptName, s.Rev);
GO
