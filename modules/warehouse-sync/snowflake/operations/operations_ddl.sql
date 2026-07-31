-- =============================================================================
-- AAIF.OPERATIONS — pipeline bookkeeping (§9.1) + tombstone-purge task (§7.2.1)
-- Run by AAIF_STAGING_ROLE. Replace AAIF with the brand database if not AAIF.
-- =============================================================================
USE ROLE AAIF_STAGING_ROLE;
USE DATABASE AAIF;
USE SCHEMA OPERATIONS;

-- ── Correctness-test results (§12.3) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS AAIF.OPERATIONS.TEST_RESULTS (
  run_at        TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ,
  suite         STRING NOT NULL,          -- daily | weekly
  test_name     STRING NOT NULL,          -- row_count_delta | checksum_sample | freshness | masking | delete_propagation | segment_identity_match
  target        STRING,                   -- table / subject the test covers
  passed        BOOLEAN NOT NULL,
  observed      STRING,                    -- observed value (count/delta/pct), free-form
  expected      STRING,
  detail        STRING
);

-- ── Reconciliation snapshot mirrored from Postgres (§12.3) ───────────────────
-- The source-side counts (public.warehouse_sync_reconcile) are loaded here
-- so the daily test can diff STAGING against them in one place. Loading can be
-- a small COPY/insert from an exported file, a Snowflake→Postgres query via the
-- reverse path, or a tiny task — chosen in Phase 3.
CREATE TABLE IF NOT EXISTS AAIF.OPERATIONS.SOURCE_ROW_COUNTS (
  captured_at    TIMESTAMP_NTZ NOT NULL,
  table_name     STRING NOT NULL,          -- e.g. 'public.send_log'
  live_rows      NUMBER(38,0) NOT NULL,
  deleted_rows   NUMBER(38,0) NOT NULL DEFAULT 0,
  max_updated_at TIMESTAMP_NTZ
);

-- ── Connector status snapshots (§12.4) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS AAIF.OPERATIONS.CONNECTOR_STATUS (
  observed_at         TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ,
  last_snapshot_at    TIMESTAMP_NTZ,
  last_cdc_commit_at  TIMESTAMP_NTZ,
  replication_lag_sec NUMBER(38,0),
  error_rate          FLOAT,
  credits_consumed    FLOAT
);

-- =============================================================================
-- Tombstone purge (§7.2.1): delete hard-delete tombstone rows older than the
-- retention window (default 90 days). A stored procedure discovers every
-- STAGING table with an is_deleted column and purges expired tombstones, so new
-- tables are covered automatically.
-- =============================================================================
CREATE OR REPLACE PROCEDURE AAIF.OPERATIONS.PURGE_TOMBSTONES(retention_days NUMBER)
RETURNS STRING
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
DECLARE
  purged   NUMBER DEFAULT 0;
  tbl      STRING;
  c1 CURSOR FOR
    SELECT table_name
      FROM AAIF.INFORMATION_SCHEMA.COLUMNS
     WHERE table_schema = 'STAGING' AND column_name = 'is_deleted';
BEGIN
  FOR rec IN c1 DO
    tbl := rec.table_name;
    EXECUTE IMMEDIATE
      'DELETE FROM AAIF.STAGING.' || tbl ||
      ' WHERE is_deleted = TRUE AND deleted_at < DATEADD(day, -' || retention_days || ', CURRENT_TIMESTAMP())';
    purged := purged + SQLROWCOUNT;
  END FOR;
  INSERT INTO AAIF.OPERATIONS.TEST_RESULTS (suite, test_name, target, passed, observed, detail)
    VALUES ('maintenance', 'tombstone_purge', 'STAGING.*', TRUE, purged::STRING,
            'purged tombstones older than ' || retention_days || ' days');
  RETURN 'purged ' || purged || ' tombstone rows';
END;
$$;

-- Scheduled Task (§7.2.1: purge by task, never manually). Daily 04:00 UTC.
CREATE OR REPLACE TASK AAIF.OPERATIONS.TOMBSTONE_PURGE_TASK
  WAREHOUSE = AAIF_LOADING_WH
  SCHEDULE  = 'USING CRON 0 4 * * * UTC'
  COMMENT   = 'Purge STAGING tombstones older than 90 days (§7.2.1, §13).'
AS
  CALL AAIF.OPERATIONS.PURGE_TOMBSTONES(90);

-- Tasks are created suspended; resume after review.
-- ALTER TASK AAIF.OPERATIONS.TOMBSTONE_PURGE_TASK RESUME;
