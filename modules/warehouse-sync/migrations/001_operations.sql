-- ============================================================================
-- Module: warehouse-sync
-- Migration: 001_operations
-- Description: Source-side (Postgres) operations tables for the Supabase →
--   Snowflake pipeline. These mirror, on the Gatewaze side, the bookkeeping the
--   warehouse OPERATIONS schema keeps (§9.1) — the pieces that must live next to
--   the source: replication-slot health history (§10.4), the reconciliation
--   row-count snapshots the warehouse tests diff against (§12.3), and an alert
--   log (§12.4). All tables are prefixed `warehouse_sync_`.
-- ============================================================================

-- Slot health history — one row per slot per monitor tick (§10.4 control #1).
CREATE TABLE IF NOT EXISTS public.warehouse_sync_slot_health (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sampled_at        timestamptz NOT NULL DEFAULT now(),
  slot_name         text        NOT NULL,
  active            boolean     NOT NULL,
  retained_bytes    bigint      NOT NULL,
  flush_lag_bytes   bigint      NOT NULL,
  inactive_seconds  double precision,
  lag_seconds       double precision,
  -- highest severity raised on this sample: null | 'warning' | 'critical'
  alert_severity    text CHECK (alert_severity IN ('warning','critical'))
);

CREATE INDEX IF NOT EXISTS warehouse_sync_slot_health_recent
  ON public.warehouse_sync_slot_health (slot_name, sampled_at DESC);

COMMENT ON TABLE public.warehouse_sync_slot_health IS
  'Time series of pg_replication_slots samples for the CDC slot (§10.4). Pruned to retention.operations_log_days by the monitor.';

-- Alert log — threshold breaches (§10.4 thresholds, §12.4 paging).
CREATE TABLE IF NOT EXISTS public.warehouse_sync_alerts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  raised_at     timestamptz NOT NULL DEFAULT now(),
  slot_name     text,
  code          text NOT NULL,     -- retained_wal | replication_lag | slot_inactive | slot_missing
  severity      text NOT NULL CHECK (severity IN ('warning','critical')),
  value         double precision,
  message       text NOT NULL,
  -- de-dupe / flap suppression: null until cleared
  resolved_at   timestamptz,
  -- whether the outbound webhook (if configured) accepted the alert
  notified      boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS warehouse_sync_alerts_open
  ON public.warehouse_sync_alerts (slot_name, code)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE public.warehouse_sync_alerts IS
  'CDC health alerts (§10.4/§12.4). An open (resolved_at IS NULL) row per (slot,code) is kept; the monitor clears it when the condition recovers.';

-- Reconciliation snapshots — source-side row counts per in-scope table (§12.3).
-- The warehouse daily test compares STAGING counts against the latest snapshot.
CREATE TABLE IF NOT EXISTS public.warehouse_sync_reconcile (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  captured_at    timestamptz NOT NULL DEFAULT now(),
  table_name     text        NOT NULL,   -- e.g. 'public.send_log'
  live_rows      bigint      NOT NULL,    -- COUNT(*) excluding soft-deleted
  deleted_rows   bigint      NOT NULL DEFAULT 0,
  max_updated_at timestamptz              -- freshness anchor (§12.3 freshness)
);

CREATE INDEX IF NOT EXISTS warehouse_sync_reconcile_recent
  ON public.warehouse_sync_reconcile (table_name, captured_at DESC);

COMMENT ON TABLE public.warehouse_sync_reconcile IS
  'Daily source-side row-count baseline the warehouse reconciliation test diffs STAGING against (§12.3).';
