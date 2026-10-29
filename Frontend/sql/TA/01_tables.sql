-- Travel Claim (TA_) module: tables.   Target: SQL Server 2017 or later (STRING_AGG, JSON functions with variable paths).
-- Re-runnable: every object is created only if it does not exist yet. Run files in numeric order.
-- Money is DECIMAL(18,2). Dates are DATE; travel periods are DATETIME2(0). Identity of the caller is always the server-forced
-- ExecutedBy (employee code); no table here trusts a browser-supplied identity.
SET NOCOUNT ON;
GO

/* ---------------------------------------------------------------------------------------------------------------------------
   Employees. THIS IS THE ONLY PLACE THAT NEEDS YOUR EXISTING HR TABLES.
   The module reads employees through dbo.TA_vw_Employee. For development a small stub table is created and the view is built on it.
   For production: ALTER VIEW dbo.TA_vw_Employee so it selects from your real employee master with the same column names.
--------------------------------------------------------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.TA_EmployeeStub', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_EmployeeStub (
    EmployeeCode NVARCHAR(30)  NOT NULL CONSTRAINT PK_TA_EmployeeStub PRIMARY KEY,
    Name         NVARCHAR(100) NOT NULL,
    Department   NVARCHAR(100) NULL,
    Designation  NVARCHAR(100) NULL,
    CostCentre   NVARCHAR(100) NULL,
    Grade        NVARCHAR(20)  NULL,
    IsActive     BIT           NOT NULL CONSTRAINT DF_TA_EmployeeStub_Active DEFAULT 1
  );
END
GO
IF OBJECT_ID(N'dbo.TA_vw_Employee', N'V') IS NULL
  EXEC (N'CREATE VIEW dbo.TA_vw_Employee AS
          SELECT EmployeeCode, Name, Department, Designation, CostCentre, Grade, IsActive FROM dbo.TA_EmployeeStub;');
GO

/* Who may approve. An employee listed here (and active) is the "admin"/approver role of the screens. */
IF OBJECT_ID(N'dbo.TA_Approver', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_Approver (
    EmployeeCode NVARCHAR(30)  NOT NULL CONSTRAINT PK_TA_Approver PRIMARY KEY,
    IsActive     BIT           NOT NULL CONSTRAINT DF_TA_Approver_Active DEFAULT 1,
    AddedBy      NVARCHAR(30)  NULL,
    AddedAt      DATETIME2(0)  NOT NULL CONSTRAINT DF_TA_Approver_At DEFAULT SYSDATETIME()
  );
END
GO

/* ---------------------------------------------------------------------------------------------------------------------------
   Reference data (seeded by 02_seed_reference.sql from the same schema the screens use)
--------------------------------------------------------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.TA_Setting', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_Setting (
    SettingKey   NVARCHAR(60)  NOT NULL CONSTRAINT PK_TA_Setting PRIMARY KEY,
    SettingValue NVARCHAR(400) NOT NULL,
    Description  NVARCHAR(400) NULL
  );
END
GO
/* One row per install script: which revision of the SQL is in this database (read by TA_usp_GetSession, compared by the app). */
IF OBJECT_ID(N'dbo.TA_SchemaVersion', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_SchemaVersion (
    ScriptName NVARCHAR(60) NOT NULL CONSTRAINT PK_TA_SchemaVersion PRIMARY KEY,
    Rev        NVARCHAR(40) NOT NULL,
    AppliedAt  DATETIME2(0) NOT NULL CONSTRAINT DF_TA_SchemaVersion_At DEFAULT SYSDATETIME()
  );
END
GO
IF OBJECT_ID(N'dbo.TA_FieldDef', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_FieldDef (
    FieldKey   NVARCHAR(30) NOT NULL CONSTRAINT PK_TA_FieldDef PRIMARY KEY,
    Label      NVARCHAR(80) NOT NULL,
    FieldType  NVARCHAR(12) NOT NULL,
    IsRequired BIT NOT NULL,
    IsComputed BIT NOT NULL
  );
END
GO
IF OBJECT_ID(N'dbo.TA_ExpenseType', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_ExpenseType (
    TypeKey      NVARCHAR(12) NOT NULL CONSTRAINT PK_TA_ExpenseType PRIMARY KEY,
    Label        NVARCHAR(60) NOT NULL,
    ShortLabel   NVARCHAR(40) NOT NULL,
    Family       NVARCHAR(12) NOT NULL,
    ShowBalance  BIT NOT NULL,      -- medical: the annual balance applies
    TravelPeriod BIT NOT NULL,      -- outside travel: travelFrom/travelTo are required
    SortOrder    INT NOT NULL
  );
END
GO
IF OBJECT_ID(N'dbo.TA_ExpenseItem', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_ExpenseItem (
    ItemKey            NVARCHAR(30)  NOT NULL CONSTRAINT PK_TA_ExpenseItem PRIMARY KEY,
    TypeKey            NVARCHAR(12)  NOT NULL CONSTRAINT FK_TA_ExpenseItem_Type REFERENCES dbo.TA_ExpenseType (TypeKey),
    Label              NVARCHAR(80)  NOT NULL,
    ShortLabel         NVARCHAR(40)  NULL,
    FieldList          NVARCHAR(400) NOT NULL,     -- JSON array of FieldKeys shown/required for this item, in display order
    Compute            NVARCHAR(12)  NULL,         -- 'fuelKm': amount is computed from the odometer readings
    RateKey            NVARCHAR(30)  NULL,         -- twoWheelerPerKm | fourWheelerPerKm
    LimitAmount        DECIMAL(18,2) NULL,         -- policy ceiling per LimitPer; NULL = no fixed limit
    LimitPer           NVARCHAR(8)   NULL,         -- bill | day | night
    LimitQty           DECIMAL(18,2) NULL,         -- litres cap
    EnforceEligibility CHAR(1) NOT NULL CONSTRAINT DF_TA_ExpenseItem_EnforceEligibility DEFAULT N'N',
    IsFixed            BIT NOT NULL,
    AttachmentOptional BIT NOT NULL,
    SortOrder          INT NOT NULL,
    CONSTRAINT CK_TA_ExpenseItem_EnforceEligibility CHECK (EnforceEligibility IN (N'Y', N'N'))
  );
END
GO
/* Reference data used to be constants in the app; the screens now read ALL of it from these tables (TA_usp_GetReferenceData). The columns below are added with
   re-runnable ALTERs so a database installed from an earlier revision upgrades in place. */
IF COL_LENGTH(N'dbo.TA_FieldDef', N'IsFull')      IS NULL ALTER TABLE dbo.TA_FieldDef ADD IsFull BIT NOT NULL CONSTRAINT DF_TA_FieldDef_Full DEFAULT 0;
IF COL_LENGTH(N'dbo.TA_FieldDef', N'IsReadonly')  IS NULL ALTER TABLE dbo.TA_FieldDef ADD IsReadonly BIT NOT NULL CONSTRAINT DF_TA_FieldDef_Readonly DEFAULT 0;
IF COL_LENGTH(N'dbo.TA_FieldDef', N'OptionsKey')  IS NULL ALTER TABLE dbo.TA_FieldDef ADD OptionsKey NVARCHAR(20) NULL;          -- which lookup list a select shows (TA_Lookup.ListKey)
IF COL_LENGTH(N'dbo.TA_FieldDef', N'Placeholder') IS NULL ALTER TABLE dbo.TA_FieldDef ADD Placeholder NVARCHAR(200) NULL;
IF COL_LENGTH(N'dbo.TA_FieldDef', N'Helper')      IS NULL ALTER TABLE dbo.TA_FieldDef ADD Helper NVARCHAR(400) NULL;
IF COL_LENGTH(N'dbo.TA_FieldDef', N'MinValue')    IS NULL ALTER TABLE dbo.TA_FieldDef ADD MinValue DECIMAL(18,4) NULL;
IF COL_LENGTH(N'dbo.TA_FieldDef', N'StepValue')   IS NULL ALTER TABLE dbo.TA_FieldDef ADD StepValue DECIMAL(18,4) NULL;
IF COL_LENGTH(N'dbo.TA_FieldDef', N'SortOrder')   IS NULL ALTER TABLE dbo.TA_FieldDef ADD SortOrder INT NOT NULL CONSTRAINT DF_TA_FieldDef_Sort DEFAULT 0;
IF COL_LENGTH(N'dbo.TA_ExpenseType', N'Description') IS NULL ALTER TABLE dbo.TA_ExpenseType ADD Description NVARCHAR(400) NULL;
IF COL_LENGTH(N'dbo.TA_ExpenseItem', N'Helper')   IS NULL ALTER TABLE dbo.TA_ExpenseItem ADD Helper NVARCHAR(400) NULL;
IF COL_LENGTH(N'dbo.TA_ExpenseItem', N'EnforceEligibility') IS NULL ALTER TABLE dbo.TA_ExpenseItem ADD EnforceEligibility CHAR(1) NOT NULL CONSTRAINT DF_TA_ExpenseItem_EnforceEligibility DEFAULT N'N';
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_TA_ExpenseItem_EnforceEligibility' AND parent_object_id = OBJECT_ID(N'dbo.TA_ExpenseItem'))
  ALTER TABLE dbo.TA_ExpenseItem ADD CONSTRAINT CK_TA_ExpenseItem_EnforceEligibility CHECK (EnforceEligibility IN (N'Y', N'N'));
GO
-- TA_ExpenseItem.FieldList is a JSON ARRAY of field keys, in the order the screens show them (STRING_SPLIT would not keep the order), e.g. ["date","amount","attachment"].
IF OBJECT_ID(N'dbo.TA_Lookup', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_Lookup (               -- option lists: MODES, CITIES, TRAVEL_PURPOSE, ESTIMATE_ITEM (cost centres come from the employee view)
    ListKey   NVARCHAR(30)  NOT NULL,
    Value     NVARCHAR(100) NOT NULL,
    SortOrder INT           NOT NULL CONSTRAINT DF_TA_Lookup_Sort DEFAULT 0,
    IsActive  BIT           NOT NULL CONSTRAINT DF_TA_Lookup_Active DEFAULT 1,
    CONSTRAINT PK_TA_Lookup PRIMARY KEY (ListKey, Value)
  );
END
GO
IF OBJECT_ID(N'dbo.TA_Counter', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_Counter (               -- request numbering; one row per scope, locked while incrementing
    CounterKey NVARCHAR(80) NOT NULL CONSTRAINT PK_TA_Counter PRIMARY KEY,
    LastValue  INT NOT NULL
  );
END
GO

/* ---------------------------------------------------------------------------------------------------------------------------
   Requests: one header table for all three kinds + one detail table per kind
--------------------------------------------------------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.TA_Request', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_Request (
    RequestId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_TA_Request PRIMARY KEY CONSTRAINT DF_TA_Request_Id DEFAULT NEWID(),
    Kind          NVARCHAR(10)  NOT NULL CONSTRAINT CK_TA_Request_Kind   CHECK (Kind IN (N'claim', N'travel', N'advance')),
    RequestNumber NVARCHAR(40)  NOT NULL,                    -- EMPCODE/YYYY/NNNN | TR/YYYY/NNNN | AR/YYYY/NNNN, assigned on first save
    EmployeeCode  NVARCHAR(30)  NOT NULL,
    EmployeeName  NVARCHAR(100) NOT NULL,
    CostCentre    NVARCHAR(100) NOT NULL CONSTRAINT DF_TA_Request_CC DEFAULT N'',
    RequestDate   DATE          NOT NULL,
    Status        NVARCHAR(10)  NOT NULL CONSTRAINT DF_TA_Request_Status DEFAULT N'draft'
                                CONSTRAINT CK_TA_Request_Status CHECK (Status IN (N'draft', N'submitted', N'approved', N'rejected')),
    SubmittedOn   DATE          NULL,
    ApprovedOn    DATE          NULL,                        -- date of the approve OR reject decision
    ApproverCode  NVARCHAR(30)  NULL,
    ApproverName  NVARCHAR(100) NULL,
    CreatedBy     NVARCHAR(30)  NOT NULL,                    -- who created it (an approver may create on behalf of an employee)
    CreatedAt     DATETIME2(0)  NOT NULL CONSTRAINT DF_TA_Request_Created DEFAULT SYSDATETIME(),
    UpdatedAt     DATETIME2(0)  NOT NULL CONSTRAINT DF_TA_Request_Updated DEFAULT SYSDATETIME(),
    RowVer        ROWVERSION
  );
  CREATE UNIQUE INDEX UX_TA_Request_Number ON dbo.TA_Request (RequestNumber);
  CREATE INDEX IX_TA_Request_Employee ON dbo.TA_Request (EmployeeCode, Kind, Status) INCLUDE (RequestDate);
  CREATE INDEX IX_TA_Request_Status   ON dbo.TA_Request (Status, SubmittedOn) INCLUDE (Kind, EmployeeCode);
END
GO

IF OBJECT_ID(N'dbo.TA_Claim', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_Claim (
    RequestId        UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_TA_Claim PRIMARY KEY
                     CONSTRAINT FK_TA_Claim_Request REFERENCES dbo.TA_Request (RequestId) ON DELETE CASCADE,
    ExpenseType      NVARCHAR(12)  NOT NULL CONSTRAINT FK_TA_Claim_Type REFERENCES dbo.TA_ExpenseType (TypeKey),
    Purpose          NVARCHAR(500) NOT NULL CONSTRAINT DF_TA_Claim_Purpose DEFAULT N'',
    TravelFrom       DATE NULL,
    TravelTo         DATE NULL,
    EmployeeComments NVARCHAR(MAX) NOT NULL CONSTRAINT DF_TA_Claim_EC DEFAULT N'',
    ApproverComments NVARCHAR(MAX) NOT NULL CONSTRAINT DF_TA_Claim_AC DEFAULT N'',
    RejectionReason  NVARCHAR(MAX) NOT NULL CONSTRAINT DF_TA_Claim_RR DEFAULT N''
  );
END
GO
IF OBJECT_ID(N'dbo.TA_ClaimLine', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_ClaimLine (
    RequestId       UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_TA_ClaimLine_Request REFERENCES dbo.TA_Claim (RequestId) ON DELETE CASCADE,
    LineId          NVARCHAR(64)  NOT NULL,
    SortOrder       INT           NOT NULL,
    ItemKey         NVARCHAR(30)  NOT NULL CONSTRAINT FK_TA_ClaimLine_Item REFERENCES dbo.TA_ExpenseItem (ItemKey),
    FieldsJson      NVARCHAR(MAX) NOT NULL CONSTRAINT CK_TA_ClaimLine_Json CHECK (ISJSON(FieldsJson) = 1),  -- the item's dynamic fields
    Amount          DECIMAL(18,2) NOT NULL CONSTRAINT DF_TA_ClaimLine_Amount DEFAULT 0 CONSTRAINT CK_TA_ClaimLine_Amount CHECK (Amount >= 0),
    LineDate        DATE          NULL,                                  -- fields.date, else fields.fromDate (for sorting/reporting)
    ApprovedAmount  DECIMAL(18,2) NULL CONSTRAINT CK_TA_ClaimLine_Approved CHECK (ApprovedAmount IS NULL OR ApprovedAmount >= 0),
    ApproverRemarks NVARCHAR(500) NOT NULL CONSTRAINT DF_TA_ClaimLine_Rem DEFAULT N'',
    CONSTRAINT PK_TA_ClaimLine PRIMARY KEY (RequestId, LineId)
  );
END
GO
IF OBJECT_ID(N'dbo.TA_Travel', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_Travel (
    RequestId       UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_TA_Travel PRIMARY KEY
                    CONSTRAINT FK_TA_Travel_Request REFERENCES dbo.TA_Request (RequestId) ON DELETE CASCADE,
    Purpose         NVARCHAR(200) NOT NULL CONSTRAINT DF_TA_Travel_Purpose DEFAULT N'',
    Remarks         NVARCHAR(MAX) NOT NULL CONSTRAINT DF_TA_Travel_Remarks DEFAULT N'',
    FromLocation    NVARCHAR(100) NOT NULL CONSTRAINT DF_TA_Travel_From DEFAULT N'',
    ToLocation      NVARCHAR(100) NOT NULL CONSTRAINT DF_TA_Travel_To DEFAULT N'',
    PeriodFrom      DATETIME2(0)  NULL,
    PeriodTo        DATETIME2(0)  NULL,
    AdvanceRequired DECIMAL(18,2) NULL CONSTRAINT CK_TA_Travel_Adv CHECK (AdvanceRequired IS NULL OR AdvanceRequired >= 0),
    OverallRemarks  NVARCHAR(MAX) NOT NULL CONSTRAINT DF_TA_Travel_OR DEFAULT N'',
    ApproverRemarks NVARCHAR(MAX) NOT NULL CONSTRAINT DF_TA_Travel_AR DEFAULT N'',
    AlongWith       NVARCHAR(300) NOT NULL CONSTRAINT DF_TA_Travel_Along DEFAULT N'',
    CreateLeave     BIT NOT NULL CONSTRAINT DF_TA_Travel_Leave DEFAULT 0
  );
END
GO
IF OBJECT_ID(N'dbo.TA_TravelEstimate', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_TravelEstimate (
    RequestId UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_TA_TravelEstimate_Request REFERENCES dbo.TA_Travel (RequestId) ON DELETE CASCADE,
    LineId    NVARCHAR(64)  NOT NULL,
    SortOrder INT           NOT NULL,
    Item      NVARCHAR(60)  NOT NULL CONSTRAINT DF_TA_TravelEstimate_Item DEFAULT N'',
    Amount    DECIMAL(18,2) NULL CONSTRAINT CK_TA_TravelEstimate_Amount CHECK (Amount IS NULL OR Amount >= 0),
    Remarks   NVARCHAR(300) NOT NULL CONSTRAINT DF_TA_TravelEstimate_Rem DEFAULT N'',
    CONSTRAINT PK_TA_TravelEstimate PRIMARY KEY (RequestId, LineId)
  );
END
GO
IF OBJECT_ID(N'dbo.TA_Advance', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_Advance (
    RequestId       UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_TA_Advance PRIMARY KEY
                    CONSTRAINT FK_TA_Advance_Request REFERENCES dbo.TA_Request (RequestId) ON DELETE CASCADE,
    PeriodFrom      DATE NULL,
    PeriodTo        DATE NULL,
    Amount          DECIMAL(18,2) NULL CONSTRAINT CK_TA_Advance_Amount CHECK (Amount IS NULL OR Amount >= 0),
    Purpose         NVARCHAR(200) NOT NULL CONSTRAINT DF_TA_Advance_Purpose DEFAULT N'',
    Remarks         NVARCHAR(MAX) NOT NULL CONSTRAINT DF_TA_Advance_Remarks DEFAULT N'',
    AlongWith       NVARCHAR(300) NOT NULL CONSTRAINT DF_TA_Advance_Along DEFAULT N'',
    CreateLeave     BIT NOT NULL CONSTRAINT DF_TA_Advance_Leave DEFAULT 0,
    TravelRequestNo NVARCHAR(40)  NOT NULL CONSTRAINT DF_TA_Advance_TR DEFAULT N'',   -- number of the linked travel request, or ''
    IsSettled       BIT NOT NULL CONSTRAINT DF_TA_Advance_Settled DEFAULT 0,         -- set by a settlement process (not part of the screens yet)
    ApproverRemarks NVARCHAR(MAX) NOT NULL CONSTRAINT DF_TA_Advance_AR DEFAULT N''
  );
END
GO

/* ---------------------------------------------------------------------------------------------------------------------------
   Files and receipts.  A file is stored once (TA_Attachment, written by TA_usp_UploadAttachment); TA_AttachmentLink says which
   request/line shows it, so one file can appear on several requests (e.g. a copied draft) and one line can carry many files.
--------------------------------------------------------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.TA_Attachment', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_Attachment (
    AttachmentId   UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_TA_Attachment PRIMARY KEY CONSTRAINT DF_TA_Attachment_Id DEFAULT NEWID(),
    OwnerCode      NVARCHAR(30)  NOT NULL,              -- uploader (ExecutedBy)
    DocType        NVARCHAR(40)  NOT NULL,              -- folder: TA_CLAIM | TA_RECEIPT | TA_TRAVEL | TA_ADVANCE
    StoredFileName NVARCHAR(260) NOT NULL,              -- server-generated name on disk
    FileName       NVARCHAR(260) NOT NULL,              -- the user's original name
    SizeBytes      BIGINT        NOT NULL,
    MimeType       NVARCHAR(100) NOT NULL,
    UploadedAt     DATETIME2(0)  NOT NULL CONSTRAINT DF_TA_Attachment_At DEFAULT SYSDATETIME()
  );
  CREATE UNIQUE INDEX UX_TA_Attachment_File ON dbo.TA_Attachment (DocType, StoredFileName);
END
GO
IF OBJECT_ID(N'dbo.TA_AttachmentLink', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_AttachmentLink (
    AttachmentId UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_TA_AttachmentLink_File REFERENCES dbo.TA_Attachment (AttachmentId),
    RequestId    UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_TA_AttachmentLink_Request REFERENCES dbo.TA_Request (RequestId) ON DELETE CASCADE,
    LineId       NVARCHAR(64) NOT NULL CONSTRAINT DF_TA_AttachmentLink_Line DEFAULT N'',   -- '' = attached to the request itself (travel/advance documents)
    SortOrder    INT NOT NULL CONSTRAINT DF_TA_AttachmentLink_Sort DEFAULT 0,
    CONSTRAINT PK_TA_AttachmentLink PRIMARY KEY (RequestId, LineId, AttachmentId)
  );
  CREATE INDEX IX_TA_AttachmentLink_File ON dbo.TA_AttachmentLink (AttachmentId);
END
GO
IF OBJECT_ID(N'dbo.TA_Receipt', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_Receipt (
    ReceiptId        UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_TA_Receipt PRIMARY KEY CONSTRAINT DF_TA_Receipt_Id DEFAULT NEWID(),
    OwnerCode        NVARCHAR(30)  NOT NULL,
    AttachmentId     UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_TA_Receipt_File REFERENCES dbo.TA_Attachment (AttachmentId),
    UploadedAt       DATETIME2(0)  NOT NULL CONSTRAINT DF_TA_Receipt_At DEFAULT SYSDATETIME(),
    BillDate         DATE NULL,
    BillerName       NVARCHAR(200) NOT NULL CONSTRAINT DF_TA_Receipt_Biller DEFAULT N'',
    BillNumber       NVARCHAR(100) NOT NULL CONSTRAINT DF_TA_Receipt_No DEFAULT N'',
    Amount           DECIMAL(18,2) NULL CONSTRAINT CK_TA_Receipt_Amount CHECK (Amount IS NULL OR Amount >= 0),
    Notes            NVARCHAR(500) NOT NULL CONSTRAINT DF_TA_Receipt_Notes DEFAULT N'',
    UsedInRequestId  UNIQUEIDENTIFIER NULL CONSTRAINT FK_TA_Receipt_Request REFERENCES dbo.TA_Request (RequestId),
    UsedInLineId     NVARCHAR(64) NULL,                 -- a receipt sits on at most one line of one claim: these two columns cannot hold two
    CONSTRAINT CK_TA_Receipt_Used CHECK ((UsedInRequestId IS NULL AND UsedInLineId IS NULL) OR (UsedInRequestId IS NOT NULL AND UsedInLineId IS NOT NULL))
  );
  CREATE UNIQUE INDEX UX_TA_Receipt_File ON dbo.TA_Receipt (AttachmentId);
  CREATE INDEX IX_TA_Receipt_Owner ON dbo.TA_Receipt (OwnerCode, UploadedAt DESC);
  CREATE INDEX IX_TA_Receipt_Used  ON dbo.TA_Receipt (UsedInRequestId) WHERE UsedInRequestId IS NOT NULL;
END
GO

/* Audit trail of every state-changing action. Rows are never updated or deleted by the module. */
IF OBJECT_ID(N'dbo.TA_RequestHistory', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.TA_RequestHistory (
    HistoryId   BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_TA_RequestHistory PRIMARY KEY,
    RequestId   UNIQUEIDENTIFIER NOT NULL,       -- no FK on purpose: history must outlive a deleted draft
    RequestNumber NVARCHAR(40) NULL,
    Action      NVARCHAR(20) NOT NULL,           -- Saved | Submitted | Approved | Rejected | Deleted | Copied
    ActedBy     NVARCHAR(30) NOT NULL,
    ActedAt     DATETIME2(0) NOT NULL CONSTRAINT DF_TA_RequestHistory_At DEFAULT SYSDATETIME(),
    Details     NVARCHAR(1000) NULL
  );
  CREATE INDEX IX_TA_RequestHistory_Request ON dbo.TA_RequestHistory (RequestId, ActedAt);
END
GO

-- Stamp: this script is installed at revision 2026-10-28-b (the app compares it with the revision it expects).
MERGE dbo.TA_SchemaVersion AS t USING (VALUES (N'01_tables', N'2026-10-28-b')) AS s (ScriptName, Rev) ON t.ScriptName = s.ScriptName
WHEN MATCHED THEN UPDATE SET Rev = s.Rev, AppliedAt = SYSDATETIME()
WHEN NOT MATCHED THEN INSERT (ScriptName, Rev) VALUES (s.ScriptName, s.Rev);
GO
