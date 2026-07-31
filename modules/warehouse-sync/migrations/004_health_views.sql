-- ============================================================================
-- Module: warehouse-sync
-- Migration: 004_health_views
-- Description: Convenience read surface for the admin CDC-Health dashboard
--   (§12.4) and the operations-log prune (retention §13). No external platform
--   dependency — pure views + one prune function over the 001 tables.
-- ============================================================================

-- Latest sample per slot (drives the dashboard "current" tiles).
CREATE OR REPLACE VIEW public.warehouse_sync_slot_health_latest AS
SELECT DISTINCT ON (slot_name)
  slot_name, sampled_at, active, retained_bytes, flush_lag_bytes,
  inactive_seconds, lag_seconds, alert_severity
FROM public.warehouse_sync_slot_health
ORDER BY slot_name, sampled_at DESC;

COMMENT ON VIEW public.warehouse_sync_slot_health_latest IS
  'Most recent slot-health sample per slot (§12.4 dashboard).';

-- Open (unresolved) alerts, newest first.
CREATE OR REPLACE VIEW public.warehouse_sync_open_alerts AS
SELECT id, raised_at, slot_name, code, severity, value, message, notified
FROM public.warehouse_sync_alerts
WHERE resolved_at IS NULL
ORDER BY raised_at DESC;

-- Retention prune (§13): slot-health + resolved alerts + reconcile snapshots.
-- Called by the slot-monitor worker each tick with retention.operations_log_days.
CREATE OR REPLACE FUNCTION public.warehouse_sync_prune_operations(p_days integer DEFAULT 30)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  DELETE FROM public.warehouse_sync_slot_health
   WHERE sampled_at < now() - make_interval(days => p_days);
  DELETE FROM public.warehouse_sync_alerts
   WHERE resolved_at IS NOT NULL AND resolved_at < now() - make_interval(days => p_days);
  -- Keep at least the most recent snapshot per table regardless of age.
  DELETE FROM public.warehouse_sync_reconcile r
   WHERE r.captured_at < now() - make_interval(days => p_days)
     AND r.id NOT IN (
       SELECT DISTINCT ON (table_name) id
       FROM public.warehouse_sync_reconcile
       ORDER BY table_name, captured_at DESC
     );
END;
$fn$;

REVOKE ALL ON FUNCTION public.warehouse_sync_prune_operations(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.warehouse_sync_prune_operations(integer) TO service_role;
