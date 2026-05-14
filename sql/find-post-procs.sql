-- find-post-procs.sql
--
-- Phase 2 discovery. Lists every stored procedure on the connected database
-- whose name suggests it might be the one Canopy invokes when a user clicks
-- "Post" on an AR batch. The hope is to identify the right proc so the script
-- can EXEC it inside the same transaction (gated behind config.autoPost).
--
-- If this query returns nothing useful, the fallback is to run an Extended
-- Events / SQL Profiler trace filtered to the Canopy service account while
-- a user clicks Post on a manually-keyed batch in Canopy. The trace captures
-- exactly which proc(s) the UI calls and with what arguments.

SELECT
    SCHEMA_NAME(schema_id)                 AS schema_name,
    name                                   AS procedure_name,
    create_date,
    modify_date,
    LEFT(OBJECT_DEFINITION(object_id), 4000) AS definition_preview
FROM sys.procedures
WHERE name LIKE '%Post%'
   OR name LIKE '%BatchReceipt%'
   OR name LIKE '%CommitBatch%'
ORDER BY name;
