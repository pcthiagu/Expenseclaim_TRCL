-- Runs every install script in the right order. Use SQLCMD mode (SSMS: Query > SQLCMD Mode) or:  sqlcmd -S <server> -d <database> -i install_all.sqlcmd.sql
-- Run it from this folder (the :r paths are relative). Re-runnable. Development files 08 and 99 are NOT included.
:on error exit
:r .\01_tables.sql
:r .\02_seed_reference.sql
:r .\03_functions.sql
:r .\04_procs_session_files.sql
:r .\05_procs_requests.sql
:r .\06_procs_approvals.sql
:r .\07_procs_receipts.sql
SELECT ScriptName, Rev, AppliedAt FROM dbo.TA_SchemaVersion ORDER BY ScriptName;   -- every row must show the revision the app expects (src/config/schemaRev.ts)
