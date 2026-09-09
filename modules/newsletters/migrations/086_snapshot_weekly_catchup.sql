-- ============================================================================
-- Module: newsletters
-- Migration: 086_snapshot_weekly_catchup
-- Description: The snapshot worker re-snapshots an edition every 2h only while
-- it is "young" (send within p_min_age_days, default 30). After that the cache
-- froze forever — so a late open/click on an older edition never showed. Add a
-- weekly catch-all: re-snapshot ANY edition whose current snapshot is > p_stale_
-- days (default 7) old, regardless of age. Engagement is essentially final after
-- a few weeks, so weekly is plenty; the worker is throttled (p_limit/tick) so the
-- extra load is negligible.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.newsletter_find_editions_needing_snapshot(
  p_limit integer DEFAULT 50,
  p_min_age_days integer DEFAULT 30,
  p_stale_days integer DEFAULT 7
)
RETURNS TABLE(edition_id uuid, data_version_ts timestamptz)
LANGUAGE sql STABLE
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
    -- Young (opens/clicks still arriving fast): re-snapshot every 2h.
    OR EXISTS (
      SELECT 1 FROM public.newsletter_edition_stats_snapshots s
      WHERE s.edition_id = r.edition_id AND s.rpc_name = 'engagement' AND s.params_key = ''
        AND r.ver > (now() - (p_min_age_days || ' days')::interval)
        AND s.snapshot_at < now() - interval '2 hours'
    )
    -- Weekly catch-all: mature editions still get a late open/click occasionally.
    OR EXISTS (
      SELECT 1 FROM public.newsletter_edition_stats_snapshots s
      WHERE s.edition_id = r.edition_id AND s.rpc_name = 'engagement' AND s.params_key = ''
        AND s.data_version_ts = r.ver
        AND s.snapshot_at < now() - (p_stale_days || ' days')::interval
    )
  )
  ORDER BY r.ver DESC
  LIMIT p_limit
$function$;
