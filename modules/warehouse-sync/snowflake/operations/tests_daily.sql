-- =============================================================================
-- Daily data-correctness tests (§12.3). Results → AAIF.OPERATIONS.TEST_RESULTS.
-- Run under AAIF_STAGING_ROLE (reads STAGING + SOURCE_ROW_COUNTS, writes results).
-- Wire as a scheduled Task or a dbt test run in Phase 3.
-- =============================================================================
USE ROLE AAIF_STAGING_ROLE;
USE DATABASE AAIF;
USE SCHEMA OPERATIONS;

-- ── Row-count delta: STAGING vs latest source snapshot (§12.3) ───────────────
-- Reference/dimension tables: EXACT match. Large facts: within 0.1% or 1,000
-- rows, whichever is larger. Tolerance is expressed per table below.
WITH src AS (
  SELECT table_name, live_rows,
         ROW_NUMBER() OVER (PARTITION BY table_name ORDER BY captured_at DESC) rn
  FROM AAIF.OPERATIONS.SOURCE_ROW_COUNTS
),
latest_src AS (SELECT table_name, live_rows FROM src WHERE rn = 1),
staging_counts AS (
  SELECT 'public.people'              AS table_name, COUNT(*) AS n FROM AAIF.STAGING.people              WHERE NOT is_deleted
  UNION ALL SELECT 'public.person_emails',       COUNT(*) FROM AAIF.STAGING.person_emails       WHERE NOT is_deleted
  UNION ALL SELECT 'public.people_events',       COUNT(*) FROM AAIF.STAGING.people_events        WHERE NOT is_deleted
  UNION ALL SELECT 'public.events',              COUNT(*) FROM AAIF.STAGING.events               WHERE NOT is_deleted
  UNION ALL SELECT 'public.event_registrations', COUNT(*) FROM AAIF.STAGING.event_registrations  WHERE NOT is_deleted
  UNION ALL SELECT 'public.send_log',            COUNT(*) FROM AAIF.STAGING.send_log             WHERE NOT is_deleted
  UNION ALL SELECT 'public.email_interactions',  COUNT(*) FROM AAIF.STAGING.email_interactions   WHERE NOT is_deleted
  UNION ALL SELECT 'public.newsletter_sends',    COUNT(*) FROM AAIF.STAGING.newsletter_sends     WHERE NOT is_deleted
),
-- large facts get the relative tolerance; everything else must match exactly.
tol AS (
  SELECT 'public.send_log' AS table_name UNION ALL SELECT 'public.email_interactions' UNION ALL SELECT 'public.people_events'
)
INSERT INTO AAIF.OPERATIONS.TEST_RESULTS (suite, test_name, target, passed, observed, expected, detail)
SELECT
  'daily', 'row_count_delta', s.table_name,
  CASE
    WHEN t.table_name IS NOT NULL
      THEN ABS(sc.n - s.live_rows) <= GREATEST(1000, CEIL(s.live_rows * 0.001))
    ELSE sc.n = s.live_rows
  END,
  sc.n::STRING, s.live_rows::STRING,
  'delta=' || (sc.n - s.live_rows) || CASE WHEN t.table_name IS NOT NULL THEN ' (large-fact tolerance)' ELSE ' (exact)' END
FROM latest_src s
JOIN staging_counts sc ON sc.table_name = s.table_name
LEFT JOIN tol t ON t.table_name = s.table_name;

-- ── Freshness: MAX(_synced_at) within 30 min of now (§12.3) ──────────────────
INSERT INTO AAIF.OPERATIONS.TEST_RESULTS (suite, test_name, target, passed, observed, expected, detail)
SELECT 'daily', 'freshness', 'STAGING.people',
       MAX(_synced_at) >= DATEADD(minute, -30, CURRENT_TIMESTAMP()),
       MAX(_synced_at)::STRING, DATEADD(minute, -30, CURRENT_TIMESTAMP())::STRING,
       'STAGING must be materialised within 30 min during operational hours'
FROM AAIF.STAGING.people;

-- ── Masking: the analyst role must NOT read plaintext PII (§12.3, PII-1) ─────
-- This assertion is executed while impersonating AAIF_ANALYST_ROLE in the test
-- harness; here we record the intended check. A domain-only email must never
-- contain a local-part, and full_name must be NULL for the analyst role.
INSERT INTO AAIF.OPERATIONS.TEST_RESULTS (suite, test_name, target, passed, observed, expected, detail)
SELECT 'daily', 'masking', 'STAGING.people.email',
       COUNT_IF(email IS NOT NULL AND email NOT LIKE '***@%') = 0,
       COUNT_IF(email IS NOT NULL AND email NOT LIKE '***@%')::STRING, '0',
       'run under AAIF_ANALYST_ROLE: no un-masked local-part may be visible'
FROM AAIF.STAGING.people;

-- Checksum sampling (§12.3) — 1,000 random PKs/day, hash of stable columns
-- excluding _synced_at — is added per large table in Phase 3 (needs the
-- source-side hash exported into SOURCE_ROW_COUNTS' sibling sample table).
