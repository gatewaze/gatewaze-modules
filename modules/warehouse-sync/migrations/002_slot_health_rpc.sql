-- ============================================================================
-- Module: warehouse-sync
-- Migration: 002_slot_health_rpc
-- Description: SECURITY DEFINER RPCs the slot-monitor + reconcile workers call
--   through the service_role Supabase client (so the workers never need direct
--   catalog access or a separate Postgres connection). Two read-only functions:
--
--     warehouse_sync_slot_health(text)  — pg_replication_slots sample (§10.4)
--     warehouse_sync_table_counts(...)  — reconciliation counts (§12.3)
--
--   Plus a guardrail reporter for max_slot_wal_keep_size (§10.4 control #3).
--
--   These read pg system catalogs, so they must be owned by a role with
--   pg_read_all_stats (Supabase migrations run as such). Executable by
--   service_role only — NOT authenticated/anon.
-- ============================================================================

-- ── Slot health (§10.4) ──────────────────────────────────────────────────────
-- Joins pg_replication_slots → pg_stat_replication (on active_pid = pid) for a
-- time-based replay lag when a walsender is attached. inactive_since is only
-- present on PG16+, so the query is built dynamically to stay version-safe.
CREATE OR REPLACE FUNCTION public.warehouse_sync_slot_health(p_slot_name text DEFAULT NULL)
RETURNS TABLE (
  slot_name        text,
  active           boolean,
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

  v_inactive_expr := CASE
    WHEN v_has_inactive THEN
      'CASE WHEN s.active THEN NULL ELSE EXTRACT(EPOCH FROM (now() - s.inactive_since)) END'
    ELSE 'NULL::double precision'
  END;

  v_sql := format($q$
    SELECT
      s.slot_name::text,
      s.active,
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
  'One row per logical replication slot: retained WAL, flush-lag bytes, inactive seconds, replay-lag seconds (§10.4). service_role only.';

-- ── max_slot_wal_keep_size guardrail (§10.4 control #3) ──────────────────────
CREATE OR REPLACE FUNCTION public.warehouse_sync_slot_guardrail()
RETURNS TABLE (max_slot_wal_keep_size text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT current_setting('max_slot_wal_keep_size', true);
$fn$;

REVOKE ALL ON FUNCTION public.warehouse_sync_slot_guardrail() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.warehouse_sync_slot_guardrail() TO service_role;

-- ── Reconciliation counts (§12.3) ────────────────────────────────────────────
-- Returns live/deleted row counts + freshness anchor for one in-scope table.
-- Uses %I quoting so the schema/table/column names from the manifest cannot be
-- turned into injection. The soft-delete column is optional (hard-delete tables
-- pass NULL → deleted_rows = 0).
CREATE OR REPLACE FUNCTION public.warehouse_sync_table_counts(
  p_schema      text,
  p_table       text,
  p_deleted_col text DEFAULT NULL,
  p_updated_col text DEFAULT NULL
)
RETURNS TABLE (
  live_rows      bigint,
  deleted_rows   bigint,
  max_updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_live_where  text := '';
  v_deleted_sel text := '0::bigint';
  v_updated_sel text := 'NULL::timestamptz';
  v_sql text;
BEGIN
  -- Reject unknown relations early (avoids leaking errors for typo'd names).
  IF to_regclass(format('%I.%I', p_schema, p_table)) IS NULL THEN
    RAISE EXCEPTION 'warehouse_sync_table_counts: unknown relation %.%', p_schema, p_table;
  END IF;

  IF p_deleted_col IS NOT NULL THEN
    v_live_where  := format('WHERE %I IS NULL', p_deleted_col);
    v_deleted_sel := format('(SELECT count(*) FROM %I.%I WHERE %I IS NOT NULL)',
                            p_schema, p_table, p_deleted_col);
  END IF;
  IF p_updated_col IS NOT NULL THEN
    v_updated_sel := format('(SELECT max(%I) FROM %I.%I)', p_updated_col, p_schema, p_table);
  END IF;

  v_sql := format(
    'SELECT (SELECT count(*) FROM %I.%I %s)::bigint, %s::bigint, %s',
    p_schema, p_table, v_live_where, v_deleted_sel, v_updated_sel
  );
  RETURN QUERY EXECUTE v_sql;
END;
$fn$;

REVOKE ALL ON FUNCTION public.warehouse_sync_table_counts(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.warehouse_sync_table_counts(text, text, text, text) TO service_role;

COMMENT ON FUNCTION public.warehouse_sync_table_counts(text, text, text, text) IS
  'Live/deleted row counts + max(updated_at) for one in-scope table; source-side baseline for the warehouse reconciliation test (§12.3). service_role only.';
