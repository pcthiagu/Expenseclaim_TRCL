const { sql, getPool } = require("../config/db");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

/**
 * Convention used across ALL stored procedures in this system:
 *
 *   CREATE PROCEDURE usp_SomeAction
 *     @JsonParam NVARCHAR(MAX)
 *   AS
 *   BEGIN
 *     DECLARE @Filters NVARCHAR(MAX) = JSON_VALUE(@JsonParam, '$.Filters');
 *     ...
 *     -- Return JSON so the API can pass it straight through untouched:
 *     SELECT (
 *       SELECT * FROM SomeTable FOR JSON PATH
 *     ) AS JsonResult;
 *   END
 *
 * This lets the Node layer stay a thin, generic pass-through: one endpoint,
 * one input parameter, one output shape, regardless of which SP is called.
 */
/**
 * Save attachment to disk before executing the SP.
 * Only runs for usp_UploadAttachment.
 */ 
 
async function saveAttachment(params) {

    if (!params.Base64Content) {
        throw new Error("Base64Content is required.");
    }

    const rootFolder =
        process.env.ATTACHMENT_ROOT ||
        "D:\\HRMS\\Attachments";

    const docType =
        (params.DocType || "OTHER").toUpperCase();

    const folder =
        path.join(rootFolder, docType);

    await fs.mkdir(folder, { recursive: true });

    const extension =
        path.extname(params.FileName);

    const employeeId =
        (params.RequestedBy || "SYSTEM")
            .replace(/[^\w]/g, "");

    const timeStamp =
        new Date()
            .toISOString()
            .replace(/[-:TZ.]/g, "")
            .substring(0, 14);

    const randomName =
        crypto.randomUUID().replace(/-/g, "");

    const storedFileName =
        `${employeeId}_${timeStamp}_${randomName}${extension}`;

    const fullPath =
        path.join(folder, storedFileName);

    const buffer =
        Buffer.from(params.Base64Content, "base64");

    await fs.writeFile(fullPath, buffer);

    return {
        storedFileName,
        fullPath
    };
}

async function execProcedure(dbName,spName, paramsObject) {

   let savedFile = null;

   if (spName === "usp_UploadAttachment") {

    uploadedFile = await saveAttachment(paramsObject);

    paramsObject.StoredFileName = uploadedFile.storedFileName;
    paramsObject.FilePath = uploadedFile.fullPath;

    delete paramsObject.Base64Content;
  }

  if (spName === "TA_usp_UploadAttachment") {

    uploadedFile = await saveAttachment(paramsObject);

    paramsObject.StoredFileName = uploadedFile.storedFileName;
    paramsObject.FilePath = uploadedFile.fullPath;

    delete paramsObject.Base64Content;
  }
  
  // if dbName is not provided, default to "RApprovaldb"
  if (!dbName) {
    dbName = "ExpenseClaimDB";
  }

  // console.log('Executing spName',spName)
 
  // const pool = await getPool();
  const pool = await getPool(dbName);
  const request = pool.request(); 
   
  const jsonParam = JSON.stringify(paramsObject || {});
  request.input("JsonParam", sql.NVarChar(sql.MAX), jsonParam);

  const result = await request.execute(spName);

  // Special handling ONLY for employee leave balance.
// All other stored procedures retain the existing behavior.
if (spName === "usp_Get_emp_Leave_Balance") {
  const balanceRaw = result.recordsets?.[0]?.[0]?.JsonResult;
  const transactionsRaw = result.recordsets?.[1]?.[0]?.JsonResult;

  return {
    balance: balanceRaw ? JSON.parse(balanceRaw) : [],
    transactions: transactionsRaw ? JSON.parse(transactionsRaw) : [],
  };
}

  const firstRow = result.recordset && result.recordset[0];

  if (!firstRow) {
    // SP ran but returned no rows at all (e.g. SELECT with no matches and no FOR JSON wrapper).
    return null;
  }

  const columnNames = Object.keys(firstRow);

  // Preferred convention: a single column literally named JsonResult.
  if (columnNames.includes("JsonResult")) {
    const raw = firstRow.JsonResult;
    return raw ? JSON.parse(raw) : null;
  }

  // Common SP-author mistake: forgot to alias the outer `FOR JSON PATH` column,
  // so SQL Server names it its internal placeholder
  // (e.g. "JSON_F52E2B61-18A1-11d1-B105-00805F49916B"). Detect that case instead
  // of silently discarding the payload, so bad SPs fail loudly rather than
  // making the frontend fall back to mock data.
  if (columnNames.length === 1) {
    const [onlyKey] = columnNames;
    const raw = firstRow[onlyKey];
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        // Not JSON after all — fall through to raw recordset below.
      }
    }
  }

  console.warn(
    `[execProcedure] '${spName}' did not return a column named 'JsonResult' ` +
      `(got: ${columnNames.join(", ")}). Returning raw recordset — check the SP's ` +
      `outer FOR JSON PATH has "AS JsonResult".`
  );
  return result.recordset;
}

module.exports = { execProcedure };