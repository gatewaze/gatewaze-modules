-- ============================================================================
-- Module: newsletters
-- Migration: 084_snapshot_all_completed_editions
-- Description: Cache engagement for EVERY completed edition, not "all but the
-- last 2 sends per collection" (074). 074 deliberately kept the 2 freshest sends
-- per collection LIVE (uncached) for real-time accuracy — but the live compute
-- is expensive, so those recent finished sends were exactly the ones loading
-- slowly on the stats table. The expectation is: a finished send serves cached
-- results. So snapshot all completed editions; keep recent ones fresh by
-- re-refreshing young editions (ver within p_min_age_days) every 2h instead of
-- 12h (they're now cached rather than live, so refresh a bit more eagerly).
-- Still-sending editions (no completed send) are excluded and stay live.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.newsletter_find_editions_needing_snapshot(
  p_limit integer DEFAULT 50,
  p_min_age_days integer DEFAULT 30
)
RETURNS TABLE(edition_id uuid, data_version_ts timestamp with time zone)
LANGUAGE sql
STABLE
AS $function$
  WITH ranked AS (
    SELECT e.id AS edition_id, public.newsletter_edition_data_version(e.id) AS ver
    FROM public.newsletters_editions e
    WHERE EXISTS (
      SELECT 1 FROM public.newsletter_sends s
      WHERE s.edition_id = e.id AND s.completed_at IS NOT NULL
    )
  )
  SELECT r.edition_id, r.ver
  FROM ranked r
  WHERE (
    -- No current snapshot: never taken, or invalidated by a newer send.
    NOT EXISTS (
      SELECT 1 FROM public.newsletter_edition_stats_snapshots s
      WHERE s.edition_id = r.edition_id AND s.rpc_name = 'engagement' AND s.params_key = ''
        AND s.data_version_ts = r.ver
    )
    -- Or the edition is still young (opens/clicks still arriving) and its
    -- snapshot is getting old — re-snapshot so recent numbers stay accurate.
    OR EXISTS (
      SELECT 1 FROM public.newsletter_edition_stats_snapshots s
      WHERE s.edition_id = r.edition_id AND s.rpc_name = 'engagement' AND s.params_key = ''
        AND r.ver > (now() - (p_min_age_days || ' days')::interval)
        AND s.snapshot_at < now() - interval '2 hours'
    )
  )
  ORDER BY r.ver DESC
  LIMIT p_limit
$function$;

COMMENT ON FUNCTION public.newsletter_find_editions_needing_snapshot(integer, integer) IS
  'Editions the snapshot worker should (re)snapshot: every edition with a completed send that lacks a current snapshot, plus young editions (<p_min_age_days) whose snapshot is >2h old. Caches all finished sends (fast stats table); still-sending editions stay live.';
