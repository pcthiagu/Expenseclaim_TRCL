CREATE   PROCEDURE dbo.usp_LogAudit
    @JsonParam NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO dbo.AuditLog (EmployeeId, Action, Details, IpAddress, UserAgent)
    VALUES (
        JSON_VALUE(@JsonParam, '$.EmployeeId'),
        JSON_VALUE(@JsonParam, '$.Action'),
        JSON_VALUE(@JsonParam, '$.Details'),
        JSON_VALUE(@JsonParam, '$.IpAddress'),
        JSON_VALUE(@JsonParam, '$.UserAgent')
    );
    SELECT (SELECT CAST(1 AS BIT) AS logged FOR JSON 
PATH, WITHOUT_ARRAY_WRAPPER) AS JsonResult;
END

--  table object --- 

CREATE TABLE [dbo].[AuditLog](
	[LogId] [int] IDENTITY(1,1) NOT NULL,
	[EmployeeId] [nvarchar](20) NULL,
	[Action] [nvarchar](50) NOT NULL,
	[Details] [nvarchar](500) NULL,
	[IpAddress] [nvarchar](64) NULL,
	[UserAgent] [nvarchar](300) NULL,
	[CreatedAt] [datetime2](7) NOT NULL,
PRIMARY KEY CLUSTERED 
(
	[LogId] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO

ALTER TABLE [dbo].[AuditLog] ADD  DEFAULT (sysutcdatetime()) FOR [CreatedAt]
GO

---- 
CREATE   PROCEDURE dbo.usp_AuthInsertRefreshToken
    @JsonParam NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO dbo.RefreshTokens (EmployeeId, TokenHash, ExpiresAt, CreatedByIp)
    VALUES (
        JSON_VALUE(@JsonParam, '$.EmployeeId'),
        JSON_VALUE(@JsonParam, '$.TokenHash'),
        TRY_CAST(JSON_VALUE(@JsonParam, '$.ExpiresAt') AS DATETIME2),
        JSON_VALUE(@JsonParam, '$.CreatedByIp')
    );
    SELECT (SELECT CAST(1 AS BIT) AS inserted FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS JsonResult;
END

--- table 

CREATE TABLE [dbo].[RefreshTokens](
	[TokenId] [int] IDENTITY(1,1) NOT NULL,
	[EmployeeId] [nvarchar](20) NOT NULL,
	[TokenHash] [char](64) NOT NULL,
	[ExpiresAt] [datetime2](7) NOT NULL,
	[RevokedAt] [datetime2](7) NULL,
	[ReplacedByTokenHash] [char](64) NULL,
	[CreatedAt] [datetime2](7) NOT NULL,
	[CreatedByIp] [nvarchar](64) NULL,
PRIMARY KEY CLUSTERED 
(
	[TokenId] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
UNIQUE NONCLUSTERED 
(
	[TokenHash] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO

ALTER TABLE [dbo].[RefreshTokens] ADD  DEFAULT (sysutcdatetime()) FOR [CreatedAt]
GO


---- table --


CREATE TABLE [dbo].[Users](
	[UserId] [int] IDENTITY(1,1) NOT NULL,
	[EmployeeId] [nvarchar](20) NOT NULL,
	[EmployeeName] [nvarchar](150) NOT NULL,
	[Email] [nvarchar](150) NULL,
	[Department] [nvarchar](100) NULL,
	[PasswordHash] [nvarchar](255) NULL,
	[Role] [nvarchar](50) NOT NULL,
	[IsActive] [bit] NOT NULL,
	[FailedLoginAttempts] [int] NOT NULL,
	[LockedUntil] [datetime2](7) NULL,
	[LastLoginAt] [datetime2](7) NULL,
	[MustChangePassword] [bit] NOT NULL,
	[CreatedAt] [datetime2](7) NOT NULL,
	[emp_position] [varchar](100) NULL,
	[unit] [varchar](100) NULL,
	[Grade] [nvarchar](20) NULL,
	[ReportingToEmpCode] [nvarchar](20) NULL,
	[FunctionalArea] [nvarchar](100) NULL,
	[Designation] [nvarchar](100) NULL,
	[Location] [nvarchar](100) NULL,
PRIMARY KEY CLUSTERED 
(
	[UserId] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
UNIQUE NONCLUSTERED 
(
	[EmployeeId] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO

ALTER TABLE [dbo].[Users] ADD  DEFAULT ('Approver') FOR [Role]
GO

ALTER TABLE [dbo].[Users] ADD  DEFAULT ((1)) FOR [IsActive]
GO

ALTER TABLE [dbo].[Users] ADD  DEFAULT ((0)) FOR [FailedLoginAttempts]
GO

ALTER TABLE [dbo].[Users] ADD  DEFAULT ((0)) FOR [MustChangePassword]
GO

ALTER TABLE [dbo].[Users] ADD  DEFAULT (sysutcdatetime()) FOR [CreatedAt]
GO


--- sp

CREATE   PROCEDURE dbo.usp_AuthLoginOutcome
    @JsonParam NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @EmployeeId      NVARCHAR(20) = JSON_VALUE(@JsonParam, '$.EmployeeId');
    DECLARE @Success         BIT          = TRY_CAST(JSON_VALUE(@JsonParam, '$.Success') AS BIT);
    DECLARE @MaxAttempts     INT       
   = ISNULL(TRY_CAST(JSON_VALUE(@JsonParam, '$.MaxAttempts') AS INT), 5);
    DECLARE @LockoutMinutes  INT          = ISNULL(TRY_CAST(JSON_VALUE(@JsonParam, '$.LockoutMinutes') AS INT), 15);

    IF @Success = 1
    BEGIN
        UPDATE dbo.Users
	        
SET FailedLoginAttempts = 0, LockedUntil = NULL, LastLoginAt = SYSUTCDATETIME()
        WHERE EmployeeId = @EmployeeId;

        SELECT (SELECT CAST(0 AS BIT) AS locked FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS JsonResult;
    END
    ELSE
    BEGIN
      
  DECLARE @NewCount INT = (SELECT FailedLoginAttempts + 1 FROM dbo.Users WHERE EmployeeId = @EmployeeId);

        UPDATE dbo.Users
        SET FailedLoginAttempts = @NewCount,
            LockedUntil = CASE WHEN @NewCount >= @MaxAttempts THEN DATEADD(MINUTE, @LockoutMinutes, SYSUTCDATETIME()) ELSE LockedUntil END
        WHERE EmployeeId = @EmployeeId;

        SELECT (
            SELECT CAST(CASE WHEN @NewCount >= @MaxAttempts THEN 1 ELSE 0 END AS BIT) AS locked
            FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
        ) AS JsonResult;
    END
END

---

CREATE   PROCEDURE dbo.usp_AuthGetRefreshToken
    @JsonParam NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @TokenHash CHAR(64) = JSON_VALUE(@JsonParam, '$.TokenHash');

    SELECT (
        SELECT EmployeeId AS employeeId, ExpiresAt AS expiresAt, RevokedAt AS revokedAt
        FROM dbo.RefreshTokens
        WHERE TokenHash = @TokenHash
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
    ) AS JsonResult;
END

--- usp_AuthRevokeAllRefreshTokensForUser
CREATE   PROCEDURE dbo.usp_AuthRevokeAllRefreshTokensForUser
    @JsonParam NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE dbo.RefreshTokens
    SET RevokedAt = SYSUTCDATETIME()
    WHERE EmployeeId = JSON_VALUE(@JsonParam, '$.EmployeeId') AND RevokedAt IS NULL;

    SELECT (SELECT CAST(1 AS BIT) AS revoked FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS JsonResult;
END

--- usp_AuthGetUserForLogin

CREATE   PROCEDURE dbo.usp_AuthGetUserForLogin
    @JsonParam NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @EmployeeId NVARCHAR(20) = JSON_VALUE(@JsonParam, '$.EmployeeId');

    SELECT (
        SELECT
            EmployeeId AS employeeId, EmployeeName AS employeeName, Email AS email,
            Role AS role, IsActive AS isActive, PasswordHash AS passwordHash,
            FailedLoginAttempts AS failedLoginAttempts, LockedUntil AS lockedUntil,
            MustChangePassword  AS mustChangePassword
        FROM dbo.Users
        WHERE EmployeeId = @EmployeeId
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
    ) AS JsonResult;
END


--- usp_AuthRotateRefreshToken
CREATE   PROCEDURE dbo.usp_AuthRotateRefreshToken
    @JsonParam NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @OldHash NVARCHAR(64) = JSON_VALUE(@JsonParam, '$.OldTokenHash');
    DECLARE @NewHash NVARCHAR(64) = JSON_VALUE(@JsonParam, '$.NewTokenHash');
    DECLARE @NewExpiresAt DATETIME2 = TRY_CAST(JSON_VALUE(@JsonParam, '$.NewExpiresAt') AS DATETIME2);
    DECLARE @CreatedByIp NVARCHAR(64) = JSON_VALUE(@JsonParam, '$.CreatedByIp');
    DECLARE @EmployeeId NVARCHAR(20) = (SELECT EmployeeId FROM dbo.RefreshTokens WHERE TokenHash = @OldHash);

    UPDATE dbo.RefreshTokens
    SET RevokedAt = SYSUTCDATETIME(), ReplacedByTokenHash = @NewHash
    WHERE TokenHash = @OldHash;

    INSERT INTO dbo.RefreshTokens (EmployeeId, TokenHash, ExpiresAt, CreatedByIp)
    VALUES (@EmployeeId, @NewHash, @NewExpiresAt, @CreatedByIp);

    SELECT (SELECT CAST(1 AS BIT) AS rotated FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS JsonResult;
END

---usp_AuthRevokeRefreshToken
CREATE   PROCEDURE dbo.usp_AuthRevokeRefreshToken
    @JsonParam NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE dbo.RefreshTokens
    SET RevokedAt = SYSUTCDATETIME()
    WHERE TokenHash = JSON_VALUE(@JsonParam, '$.TokenHash') AND RevokedAt IS NULL;

    SELECT (SELECT CAST(1 AS BIT) AS revoked FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS JsonResult;
END


--usp_AuthGetUserForLogin
CREATE   PROCEDURE dbo.usp_AuthGetUserForLogin
    @JsonParam NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @EmployeeId NVARCHAR(20) = JSON_VALUE(@JsonParam, '$.EmployeeId');

    SELECT (
        SELECT
            EmployeeId AS employeeId, EmployeeName AS employeeName, Email AS email,
            Role AS role, IsActive AS isActive, PasswordHash AS passwordHash,
            FailedLoginAttempts AS failedLoginAttempts, LockedUntil AS lockedUntil,
            MustChangePassword  AS mustChangePassword
        FROM dbo.Users
        WHERE EmployeeId = @EmployeeId
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
    ) AS JsonResult;
END


--- usp_AuthChangePassword

CREATE   PROCEDURE dbo.usp_AuthChangePassword
 
   @JsonParam NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @EmployeeId NVARCHAR(20) = JSON_VALUE(@JsonParam, '$.EmployeeId');
    DECLARE @NewHash NVARCHAR(255) = JSON_VALUE(@JsonParam, '$.NewPasswordHash');

    UPDATE dbo.Users
    SET PasswordHash = @NewHash, MustChangePassword = 0
    WHERE EmployeeId = @EmployeeId;

    UPDATE dbo.RefreshTokens
    SET RevokedAt = SYSUTCDATETIME()
    WHERE EmployeeId = @EmployeeId AND RevokedAt IS NULL;

    SELECT (SELECT CAST(1 AS BIT) AS updated FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS JsonResult;
END



---usp_AuthCreatePasswordResetToken

CREATE   PROCEDURE dbo.usp_AuthCreatePasswordResetToken
    @JsonParam NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @EmployeeId NVARCHAR(20) = JSON_VALUE(@JsonParam, '$.EmployeeId');
    DECLARE @ExpiryMinutes INT = ISNULL(TRY_CAST(JSON_VALUE(@JsonParam, '$.ExpiryMinutes') AS INT), 30);
    DECLARE @NewGuid UNIQUEIDENTIFIER = NEWID();
    DECLARE @ExpiresAt DATETIME2 = DATEADD(MINUTE, @ExpiryMinutes, SYSUTCDATETIME());

    -- Invalidate any earlier still-active reset tokens for this user first
    -- (only the newest link should ever work).
    UPDATE dbo.PasswordResetTokens SET Status = 'Expired' WHERE EmployeeId = @EmployeeId AND Status = 'Active';

    INSERT INTO dbo.PasswordResetTokens (EmployeeId, TokenGuid, ExpiresAt)
    VALUES (@EmployeeId, @NewGuid, @ExpiresAt);

    SELECT (
        SELECT @NewGuid AS tokenGuid, @ExpiresAt AS expiresAt
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
    ) AS JsonResult;
END

-- table 
CREATE TABLE [dbo].[PasswordResetTokens](
	[ResetId] [int] IDENTITY(1,1) NOT NULL,
	[EmployeeId] [nvarchar](20) NOT NULL,
	[TokenGuid] [uniqueidentifier] NOT NULL,
	[GeneratedAt] [datetime2](7) NOT NULL,
	[ExpiresAt] [datetime2](7) NOT NULL,
	[Status] [nvarchar](10) NOT NULL,
PRIMARY KEY CLUSTERED 
(
	[ResetId] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO

ALTER TABLE [dbo].[PasswordResetTokens] ADD  DEFAULT (newid()) FOR [TokenGuid]
GO

ALTER TABLE [dbo].[PasswordResetTokens] ADD  DEFAULT (sysutcdatetime()) FOR [GeneratedAt]
GO

ALTER TABLE [dbo].[PasswordResetTokens] ADD  DEFAULT ('Active') FOR [Status]
GO


---- usp_AuthGetPasswordResetToken

CREATE   PROCEDURE dbo.usp_AuthGetPasswordResetToken
    @JsonParam NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @TokenGuid UNIQUEIDENTIFIER = TRY_CAST(JSON_VALUE(@JsonParam, '$.TokenGuid') AS UNIQUEIDENTIFIER);

    SELECT (
        SELECT EmployeeId AS employeeId, ExpiresAt AS expiresAt, Status AS status
        FROM dbo.PasswordResetTokens
        WHERE TokenGuid = @TokenGuid
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
    ) AS JsonResult;
END

--usp_AuthCompletePasswordReset

CREATE   PROCEDURE dbo.usp_AuthCompletePasswordReset
    @JsonParam NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @TokenGuid UNIQUEIDENTIFIER = TRY_CAST(JSON_VALUE(@JsonParam, '$.TokenGuid') AS UNIQUEIDENTIFIER);
    DECLARE @NewHash NVARCHAR(255) = JSON_VALUE(@JsonParam, '$.NewPasswordHash');
    DECLARE @EmployeeId NVARCHAR(20) = (SELECT EmployeeId FROM dbo.PasswordResetTokens WHERE TokenGuid = @TokenGuid);

    UPDATE dbo.PasswordResetTokens SET Status = 'Used' WHERE TokenGuid = @TokenGuid;
    UPDATE dbo.Users SET PasswordHash = @NewHash, MustChangePassword = 0, FailedLoginAttempts = 0, LockedUntil = NULL
        WHERE EmployeeId = @EmployeeId;
    UPDATE dbo.RefreshTokens SET RevokedAt = SYSUTCDATETIME() WHERE EmployeeId = @EmployeeId AND RevokedAt IS NULL;

    SELECT (SELECT CAST(1 AS BIT) AS updated FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS JsonResult;
END


--usp_ValidateAndConsumeMagicLink

CREATE   PROCEDURE dbo.usp_ValidateAndConsumeMagicLink
    @JsonParam NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @TokenGuid UNIQUEIDENTIFIER = TRY_CAST(JSON_VALUE(@JsonParam, '$.TokenGuid') AS UNIQUEIDENTIFIER);
    DECLARE @IpAddress NVARCHAR(64) = JSON_VALUE(@JsonParam, '$.IpAddress');
    DECLARE @BrowserInfo NVARCHAR(300) = JSON_VALUE(@JsonParam, '$.BrowserInfo');

    DECLARE @Status NVARCHAR(10), @ExpiresAt DATETIME2, @EmployeeId NVARCHAR(20),
            @TransactionNo NVARCHAR(30), @RedirectUrl NVARCHAR(500);

    SELECT @Status = Status, @ExpiresAt = ExpiresAt, @EmployeeId = EmployeeId,
           @TransactionNo = TransactionNo, @RedirectUrl = RedirectUrl
    FROM dbo.MagicLinkTokens WHERE TokenGuid = @TokenGuid;

    DECLARE @Reason NVARCHAR(50) = NULL;
    IF @Status IS NULL SET @Reason = 'not_found';
    ELSE IF @Status <> 'Active' SET @Reason = 'already_used_or_revoked';
    ELSE IF @ExpiresAt < SYSUTCDATETIME() SET @Reason = 'expired';

    IF @Reason IS NULL
    BEGIN
        UPDATE dbo.MagicLinkTokens
        SET Status = 'Used', LoginAt = SYSUTCDATETIME(), IpAddress = @IpAddress, BrowserInfo = @BrowserInfo
        WHERE TokenGuid = @TokenGuid;
    END

    SELECT (
        SELECT
            CAST(CASE WHEN @Reason IS NULL THEN 1 ELSE 0 END AS BIT) AS valid,
            @EmployeeId AS employeeId,
            @TransactionNo AS transactionNo,
            @RedirectUrl AS redirectUrl,
            @Reason AS reason
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
    ) AS JsonResult;
END


---  table 
CREATE TABLE [dbo].[MagicLinkTokens](
	[MagicLinkId] [int] IDENTITY(1,1) NOT NULL,
	[TokenGuid] [uniqueidentifier] NOT NULL,
	[EmployeeId] [nvarchar](20) NOT NULL,
	[Email] [nvarchar](150) NULL,
	[TransactionNo] [nvarchar](30) NULL,
	[RedirectUrl] [nvarchar](500) NULL,
	[GeneratedAt] [datetime2](7) NOT NULL,
	[ExpiresAt] [datetime2](7) NOT NULL,
	[Status] [nvarchar](10) NOT NULL,
	[LoginAt] [datetime2](7) NULL,
	[IpAddress] [nvarchar](64) NULL,
	[BrowserInfo] [nvarchar](300) NULL,
PRIMARY KEY CLUSTERED 
(
	[MagicLinkId] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO

ALTER TABLE [dbo].[MagicLinkTokens] ADD  DEFAULT (newid()) FOR [TokenGuid]
GO

ALTER TABLE [dbo].[MagicLinkTokens] ADD  DEFAULT (sysutcdatetime()) FOR [GeneratedAt]
GO

ALTER TABLE [dbo].[MagicLinkTokens] ADD  DEFAULT ('Active') FOR [Status]
GO

--usp_AuthGetUserForLogin

CREATE   PROCEDURE dbo.usp_AuthGetUserForLogin
    @JsonParam NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @EmployeeId NVARCHAR(20) = JSON_VALUE(@JsonParam, '$.EmployeeId');

    SELECT (
        SELECT
            EmployeeId AS employeeId, EmployeeName AS employeeName, Email AS email,
            Role AS role, IsActive AS isActive, PasswordHash AS passwordHash,
            FailedLoginAttempts AS failedLoginAttempts, LockedUntil AS lockedUntil,
            MustChangePassword AS mustChangePassword
        FROM dbo.Users
        WHERE EmployeeId = @EmployeeId
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
    ) AS JsonResult;
END
