-- ============================================================================
-- Module: broadcasts
-- Migration: 024_engagement_snapshot_refresh
-- Description: Give broadcast engagement the same refresh lifecycle newsletters
-- have. broadcast_engagement_data_version keys off completed_at, which never
-- changes as opens/clicks arrive — so a cached broadcast's stats froze at the
-- first read after it finished sending. Add a background refresh:
--   * broadcast_refresh_engagement_snapshot(id) — recompute via _live + upsert
--     (force, bump snapshot_at) even though data_version is unchanged.
--   * broadcast_find_sends_needing_snapshot() — completed broadcasts whose
--     snapshot is missing, young (< young_days) and > 2h stale, OR > stale_days
--     old (weekly catch-all for late opens/clicks on mature broadcasts).
-- A 5-min cron worker (broadcasts:engagement-snapshot) drives it, so the admin
-- list always reads a warm, current cache.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.broadcast_refresh_engagement_snapshot(p_broadcast_id uuid)
RETURNS integer
LANGUAGE plpgsql
SET statement_timeout TO '600000'
SET search_path = public
AS $fn$
DECLARE v_ver timestamptz; r record;
BEGIN
  v_ver := public.broadcast_engagement_data_version(p_broadcast_id);
  IF v_ver IS NULL THEN RETURN 0; END IF;
  SELECT * INTO r FROM public.broadcast_engagement_live(ARRAY[p_broadcast_id]) LIMIT 1;
  IF NOT FOUND THEN RETURN 0; END IF;
  INSERT INTO public.broadcast_engagement_snapshots (broadcast_id, data_version_ts, payload, snapshot_at)
  VALUES (p_broadcast_id, v_ver, to_jsonb(r), now())
  ON CONFLICT (broadcast_id) DO UPDATE
    SET data_version_ts = EXCLUDED.data_version_ts, payload = EXCLUDED.payload, snapshot_at = now();
  RETURN 1;
END $fn$;

CREATE OR REPLACE FUNCTION public.broadcast_find_sends_needing_snapshot(
  p_limit integer DEFAULT 50,
  p_young_days integer DEFAULT 30,
  p_stale_days integer DEFAULT 7
)
RETURNS TABLE(broadcast_id uuid, data_version_ts timestamptz)
LANGUAGE sql STABLE
AS $fn$
  WITH ranked AS (
    SELECT b.id AS broadcast_id, public.broadcast_engagement_data_version(b.id) AS ver
    FROM public.broadcasts b
    WHERE EXISTS (
      SELECT 1 FROM public.broadcast_sends s
      WHERE s.broadcast_id = b.id AND s.status IN ('sent','completed')
    )
  )
  SELECT r.broadcast_id, r.ver
  FROM ranked r
  WHERE r.ver IS NOT NULL AND (
    -- No current snapshot (never taken or invalidated by a change).
    NOT EXISTS (
      SELECT 1 FROM public.broadcast_engagement_snapshots s
      WHERE s.broadcast_id = r.broadcast_id AND s.data_version_ts = r.ver
    )
    -- Young: re-snapshot every 2h.
    OR EXISTS (
      SELECT 1 FROM public.broadcast_engagement_snapshots s
      WHERE s.broadcast_id = r.broadcast_id AND s.data_version_ts = r.ver
        AND r.ver > (now() - (p_young_days || ' days')::interval)
        AND s.snapshot_at < now() - interval '2 hours'
    )
    -- Weekly catch-all for mature broadcasts.
    OR EXISTS (
      SELECT 1 FROM public.broadcast_engagement_snapshots s
      WHERE s.broadcast_id = r.broadcast_id AND s.data_version_ts = r.ver
        AND s.snapshot_at < now() - (p_stale_days || ' days')::interval
    )
  )
  ORDER BY r.ver DESC
  LIMIT p_limit
$fn$;
