/**
 * Revision of the database scripts in sql/TA that this build of the app expects. Every install script stamps its own row in dbo.TA_SchemaVersion
 * when it finishes; TA_usp_GetSession returns those rows as `schema`. If a script was not (re)run, the app says which one instead of failing with a
 * confusing error from an older procedure. Change this ONLY together with the stamps at the end of the SQL files (a contract test checks they match).
 */
export const EXPECTED_SCHEMA_REV = '2026-10-28-b';
/** Install scripts that contain objects the app depends on (02 is data only; 08 and 99 are development helpers). */
export const SCHEMA_SCRIPTS = ['01_tables', '03_functions', '04_procs_session_files', '05_procs_requests', '06_procs_approvals', '07_procs_receipts'] as const;

/** Scripts whose stamp is missing or older than this build expects. An empty list means the database matches the app. */
export function staleScripts(schema: Record<string, string> | undefined | null): string[] {
  return SCHEMA_SCRIPTS.filter((name) => (schema ?? {})[name] !== EXPECTED_SCHEMA_REV).map((n) => `${n}.sql`);
}
