-- =============================================================================
-- Weekly data-correctness tests (§12.3). Results → AAIF.OPERATIONS.TEST_RESULTS.
-- =============================================================================
USE ROLE AAIF_STAGING_ROLE;
USE DATABASE AAIF;
USE SCHEMA OPERATIONS;

-- ── Delete-propagation test (§8.3, §12.3) ────────────────────────────────────
-- Harness (external, orchestrated in Phase 3):
--   1. Seed a clearly-marked non-real test subject in Supabase
--      (email like 'erasure-test+<runid>@example.invalid').
--   2. Delete / anonymise it in Supabase.
--   3. Wait up to the 24h SLA, then run the assertion below.
-- Assertion: the subject is tombstoned/removed AND its direct identifiers are
-- nulled in STAGING within SLA.
INSERT INTO AAIF.OPERATIONS.TEST_RESULTS (suite, test_name, target, passed, observed, expected, detail)
SELECT
  'weekly', 'delete_propagation', 'STAGING.people',
  -- pass when no live row remains for the test subject and any tombstone has
  -- nulled identifiers.
  COUNT_IF(NOT is_deleted) = 0
    AND COUNT_IF(is_deleted AND (full_name IS NOT NULL OR email NOT LIKE '***@%')) = 0,
  COUNT(*)::STRING, '0 live / identifiers nulled',
  'erasure must reflect in STAGING within 24h of the Supabase operation (§8.3 SLA)'
FROM AAIF.STAGING.people
WHERE email_sha256 = LOWER(SHA2('erasure-test@example.invalid', 256));  -- parameterise per run

-- ── Segment identity-match test (§11, §12.3) ─────────────────────────────────
-- Sample 1,000 recent identified events; verify userId resolves to a
-- STAGING.people.id at ≥ 99%. Requires the Segment Snowflake location from
-- Appendix B; the table refs below are placeholders until appendix-b.yaml lands.
-- Uncomment and fill from manifest/appendix-b.yaml in Phase 0/3.
--
-- WITH recent AS (
--   SELECT CAST(user_id AS STRING) AS uid
--   FROM SEGMENT_MARKETING_OPS.AAIF_WEB.TRACKS
--   WHERE timestamp >= DATEADD(day, -7, CURRENT_TIMESTAMP()) AND user_id IS NOT NULL
--   ORDER BY timestamp DESC LIMIT 1000
-- ),
-- matched AS (
--   SELECT r.uid, p.id IS NOT NULL AS is_match
--   FROM recent r
--   LEFT JOIN AAIF.STAGING.people p ON CAST(p.id AS STRING) = r.uid
-- )
-- INSERT INTO AAIF.OPERATIONS.TEST_RESULTS (suite, test_name, target, passed, observed, expected, detail)
-- SELECT 'weekly', 'segment_identity_match', 'segment.tracks.user_id',
--        AVG(IFF(is_match, 1, 0)) >= 0.99,
--        TO_VARCHAR(AVG(IFF(is_match, 1, 0)) * 100, 'FM999.00') || '%', '>= 99%',
--        'Segment userId must resolve to STAGING.people.id (§11)'
-- FROM matched;
