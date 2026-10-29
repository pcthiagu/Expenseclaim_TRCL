const { sql, getPool } = require("../config/db");

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
async function execProcedure(spName, paramsObject) {
  const pool = await getPool();
  const request = pool.request();

  const jsonParam = JSON.stringify(paramsObject || {});
  request.input("JsonParam", sql.NVarChar(sql.MAX), jsonParam);

  const result = await request.execute(spName);
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
