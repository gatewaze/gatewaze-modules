-- ============================================================================
-- Migration: templates_007_ab_helpers
-- Description: Aggregate / promote helpers used by the builtin A/B engine.
-- ============================================================================

-- ==========================================================================
-- templates_ab_summary(p_test_id uuid) RETURNS jsonb
-- ==========================================================================
-- Aggregates impression / conversion events per variant for a test.
-- Returned shape matches the AbSummary TypeScript type.

CREATE OR REPLACE FUNCTION public.templates_ab_summary(p_test_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH counts AS (
    SELECT
      e.variant,
      COUNT(*) FILTER (WHERE e.kind = 'impression')              AS impressions,
      COUNT(*) FILTER (WHERE e.kind = 'conversion')              AS conversions
    FROM public.templates_ab_events e
    WHERE e.test_id = p_test_id
    GROUP BY e.variant
  )
  SELECT jsonb_build_object(
    'testId', p_test_id::text,
    'variants', COALESCE(jsonb_agg(jsonb_build_object(
      'key',           variant,
      'impressions',   impressions,
      'conversions',   conversions,
      'conversionRate', CASE WHEN impressions = 0 THEN 0
                            ELSE ROUND(conversions::numeric / impressions::numeric, 6) END
    ) ORDER BY variant), '[]'::jsonb)
  )
  FROM counts;
$$;

COMMENT ON FUNCTION public.templates_ab_summary(uuid) IS
  'Per-variant impression / conversion counts for an A/B test. Used by the builtin engine.';

-- ==========================================================================
-- templates_ab_promote_winner(p_test_id uuid, p_variant text)
-- ==========================================================================
-- Mark a test as concluded with the given winner variant.

CREATE OR REPLACE FUNCTION public.templates_ab_promote_winner(p_test_id uuid, p_variant text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.templates_ab_tests
     SET status         = 'concluded',
         winner_variant = p_variant,
         ended_at       = COALESCE(ended_at, now())
   WHERE id = p_test_id;
END;
$$;

-- ==========================================================================
-- Unique index on (test_id, session_key) for race-safe assignment writes.
-- The PRIMARY KEY in 003 already provides this; restating for clarity.
-- ==========================================================================
-- (no-op: PK already exists on (test_id, session_key))
