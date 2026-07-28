-- ============================================================================
-- Module: newsletters
-- Migration: 074_snapshot_all_but_last_two
-- Description: Broaden the edition-stats snapshot cache so recent editions are
-- cached too. Previously only editions whose latest send was ≥30 days old got
-- snapshotted (newsletter_find_editions_needing_snapshot), so the newest ~month
-- of editions always computed the expensive engagement RPC live — e.g. the
-- MLOps stats page loaded 147 editions with 5 uncached recent ones costing ~8s
-- (cold ~28s).
--
-- New rule: snapshot EVERY edition except the last 2 sends per collection (the
-- freshest, which stay live). Young snapshotted editions (latest send within
-- p_min_age_days) are re-refreshed when their snapshot is >12h old, so their
-- open/click numbers stay accurate as engagement trickles in; once past the
-- settle window they snapshot once and freeze. Invalidation on a new send is
-- unchanged (data_version_ts).
--
-- Function-only change (the edition-snapshot worker calls this by name and
-- picks up the new logic on its next tick — no worker rebuild needed).
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
    SELECT
      e.id AS edition_id,
      public.newsletter_edition_data_version(e.id) AS ver,
      row_number() OVER (
        PARTITION BY e.collection_id
        ORDER BY public.newsletter_edition_data_version(e.id) DESC NULLS LAST
      ) AS rn
    FROM public.newsletters_editions e
    WHERE EXISTS (
      SELECT 1 FROM public.newsletter_sends s
      WHERE s.edition_id = e.id AND s.completed_at IS NOT NULL
    )
  )
  SELECT r.edition_id, r.ver
  FROM ranked r
  WHERE r.rn > 2   -- snapshot all but the 2 most recent sends per collection
    AND (
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
          AND s.snapshot_at < now() - interval '12 hours'
      )
    )
  ORDER BY r.ver DESC
  LIMIT p_limit
$function$;

COMMENT ON FUNCTION public.newsletter_find_editions_needing_snapshot(integer, integer) IS
  'Editions the snapshot worker should (re)snapshot: every edition except the last 2 sends per collection, that lack a current snapshot OR are still young (<p_min_age_days) with a snapshot >12h old. Keeps recent editions cached + fresh; the last 2 stay live.';
