
CREATE   PROCEDURE dbo.usp_GetRequestsNeedingPdfRegeneration
    @JsonParam NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    SELECT (
        SELECT TRAN_ID AS tran_id,PDF_FILE_NAME,SP_NAME,HTML_TEMPLATE_NAME,USERID
        FROM dbo.PDF_gen_ApprovalRequests 
      WHERE PDF_FLAG in ( 'P'  ) --and tran_id like 'cfm%'
  FOR JSON PATH
    ) AS JsonResult;
END

  

--drop table PDF_gen_ApprovalRequests

--create table PDF_gen_ApprovalRequests
--(
--	APP_TYPE		varchar(50),
--	TRAN_ID			VARCHAR(50),
--	USERID			VARCHAR(50),
--	PDF_FILE_NAME	VARCHAR(100),
--    SP_NAME			VARCHAR(200),
--	PDF_FLAG		VARCHAR(10),
--	HTML_TEMPLATE_NAME	VARCHAR(100),
--	CREATE_dATE		DATETIME,
--	MODIFY_DATE		DATETIME 
--)


