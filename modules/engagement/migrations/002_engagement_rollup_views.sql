-- ============================================================================
-- Module: engagement
-- Migration: 002_engagement_rollup_views
-- Description: Materialised views for per-(person, calendar) and global
--              engagement totals. Refreshed by the engagement-rollup worker.
--              Per spec-engagement-module.md §4.5, §4.6.
-- ============================================================================

-- ==========================================================================
-- 1. engagement_scores_calendar — per-(person, calendar) totals
-- ==========================================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS public.engagement_scores_calendar AS
SELECT
  person_id,
  calendar_id,
  COUNT(*)                  AS event_count,
  COALESCE(SUM(points), 0)  AS total_points,
  MAX(occurred_at)          AS last_active_at
FROM public.engagement_events
WHERE calendar_id IS NOT NULL
GROUP BY person_id, calendar_id;

-- Unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_engagement_scores_calendar_unique
  ON public.engagement_scores_calendar (person_id, calendar_id);
CREATE INDEX IF NOT EXISTS idx_engagement_scores_calendar_leaderboard
  ON public.engagement_scores_calendar (calendar_id, total_points DESC);

-- ==========================================================================
-- 2. engagement_scores_global — platform-wide totals
-- ==========================================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS public.engagement_scores_global AS
SELECT
  person_id,
  COUNT(DISTINCT calendar_id) FILTER (WHERE calendar_id IS NOT NULL) AS calendar_count,
  COUNT(*)                                                            AS event_count,
  COALESCE(SUM(points), 0)                                            AS total_points,
  MAX(occurred_at)                                                    AS last_active_at
FROM public.engagement_events
GROUP BY person_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_engagement_scores_global_unique
  ON public.engagement_scores_global (person_id);
CREATE INDEX IF NOT EXISTS idx_engagement_scores_global_leaderboard
  ON public.engagement_scores_global (total_points DESC);

-- ==========================================================================
-- 3. Refresh helper — called by the engagement-rollup edge function
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.engagement_refresh_views()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.engagement_scores_calendar;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.engagement_scores_global;
EXCEPTION WHEN OTHERS THEN
  -- If CONCURRENTLY fails (e.g. first run without data), fall back to plain REFRESH
  REFRESH MATERIALIZED VIEW public.engagement_scores_calendar;
  REFRESH MATERIALIZED VIEW public.engagement_scores_global;
END;
$$;

COMMENT ON FUNCTION public.engagement_refresh_views() IS
  'Called by engagement-rollup edge function on a 5-minute cron to refresh the materialised leaderboard views.';
