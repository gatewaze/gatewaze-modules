-- ============================================================================
-- Module: newsletters
-- Migration: 089_snapshot_in_progress_sends
-- Description: the snapshot finder only considered editions whose send had
-- COMPLETED, so an edition mid-send (a 58k-recipient send runs for most of a
-- day) was never cached and the dashboard recomputed its engagement live
-- (~30s) on every load for as long as the send ran. Consider any edition
-- whose send has STARTED. newsletter_edition_data_version already keys the
-- snapshot on COALESCE(completed_at, started_at, …), so an in-progress
-- snapshot is refreshed on the young-edition 2h cadence and invalidated the
-- moment the send completes (the version changes to completed_at).
-- Same body as 086 otherwise.
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
      WHERE s.edition_id = e.id AND s.started_at IS NOT NULL
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
