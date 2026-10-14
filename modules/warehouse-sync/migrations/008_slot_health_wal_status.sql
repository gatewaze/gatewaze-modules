-- ============================================================================
-- Module: warehouse-sync
-- Migration: 008_slot_health_wal_status
-- Description: Fixes the §10.4 slot monitor, which had never produced a single
--   sample, and teaches it about slot invalidation.
--
--   Two problems, both found after the AAIF prod slot was invalidated unnoticed
--   on 2026-09-02:
--
--   1. warehouse_sync_slot_health() failed on EVERY call with "structure of
--      query does not match function result type". EXTRACT() returns numeric on
--      PG14+ (prod is 17.6) and the inactive_since branch was not cast, so the
--      column did not match the declared double precision. The monitor threw on
--      every tick, wrote no samples and raised no alerts.
--
--   2. The data model could not represent what actually went wrong. A slot whose
--      retained WAL passes max_slot_wal_keep_size is marked 'unreserved' and then
--      'lost' once the WAL is removed, at which point CDC cannot resume and the
--      slot must be recreated. Neither state was sampled, so the one failure the
--      monitor exists to catch was invisible. restart_lsn also goes NULL once a
--      slot is lost, which makes retained_bytes NULL and hides it from the
--      retained-WAL threshold.
--
--   Adds wal_status to the RPC, the samples table and the dashboard view. The
--   return type changes, so the function is dropped rather than replaced.
-- ============================================================================

-- ── Samples table + dashboard view ──────────────────────────────────────────
ALTER TABLE public.warehouse_sync_slot_health
  ADD COLUMN IF NOT EXISTS wal_status text;

COMMENT ON COLUMN public.warehouse_sync_slot_health.wal_status IS
  'pg_replication_slots.wal_status: reserved | extended | unreserved | lost. "unreserved" is the last warning before "lost", at which point the slot is unusable and must be recreated (§10.4).';

-- CREATE OR REPLACE VIEW cannot reorder or rename existing columns, and
-- wal_status is inserted mid-list, so the view is dropped and rebuilt.
DROP VIEW IF EXISTS public.warehouse_sync_slot_health_latest;

CREATE VIEW public.warehouse_sync_slot_health_latest AS
SELECT DISTINCT ON (slot_name)
  slot_name, sampled_at, active, wal_status, retained_bytes, flush_lag_bytes,
  inactive_seconds, lag_seconds, alert_severity
FROM public.warehouse_sync_slot_health
ORDER BY slot_name, sampled_at DESC;

COMMENT ON VIEW public.warehouse_sync_slot_health_latest IS
  'Most recent slot-health sample per slot (§12.4 dashboard).';

-- ── Slot health RPC (§10.4) ─────────────────────────────────────────────────
-- Return type changes, so CREATE OR REPLACE is not enough.
DROP FUNCTION IF EXISTS public.warehouse_sync_slot_health(text);

CREATE FUNCTION public.warehouse_sync_slot_health(p_slot_name text DEFAULT NULL)
RETURNS TABLE (
  slot_name        text,
  active           boolean,
  wal_status       text,
  retained_bytes   bigint,
  flush_lag_bytes  bigint,
  inactive_seconds double precision,
  lag_seconds      double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_has_inactive boolean;
  v_inactive_expr text;
  v_sql text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'pg_catalog.pg_replication_slots'::regclass
      AND attname = 'inactive_since' AND NOT attisdropped
  ) INTO v_has_inactive;

  -- EXTRACT() returns numeric on PG14+, so every branch MUST be cast to double
  -- precision or the column will not match the declared RETURNS TABLE.
  v_inactive_expr := CASE
    WHEN v_has_inactive THEN
      '(CASE WHEN s.active THEN NULL ELSE EXTRACT(EPOCH FROM (now() - s.inactive_since)) END)::double precision'
    ELSE 'NULL::double precision'
  END;

  v_sql := format($q$
    SELECT
      s.slot_name::text,
      s.active,
      s.wal_status::text                                                    AS wal_status,
      pg_wal_lsn_diff(pg_current_wal_lsn(), s.restart_lsn)::bigint          AS retained_bytes,
      pg_wal_lsn_diff(pg_current_wal_lsn(), s.confirmed_flush_lsn)::bigint  AS flush_lag_bytes,
      %s                                                                    AS inactive_seconds,
      EXTRACT(EPOCH FROM r.replay_lag)::double precision                    AS lag_seconds
    FROM pg_catalog.pg_replication_slots s
    LEFT JOIN pg_catalog.pg_stat_replication r ON r.pid = s.active_pid
    WHERE s.slot_type = 'logical'
      AND (%L IS NULL OR s.slot_name = %L)
  $q$, v_inactive_expr, p_slot_name, p_slot_name);

  RETURN QUERY EXECUTE v_sql;
END;
$fn$;

REVOKE ALL ON FUNCTION public.warehouse_sync_slot_health(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.warehouse_sync_slot_health(text) TO service_role;

COMMENT ON FUNCTION public.warehouse_sync_slot_health(text) IS
  'One row per logical replication slot: wal_status, retained WAL, flush-lag bytes, inactive seconds, replay-lag seconds (§10.4). service_role only.';
