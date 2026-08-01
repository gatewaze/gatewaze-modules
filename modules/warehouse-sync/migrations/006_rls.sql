-- Row-Level Security for warehouse-sync's operational tables.
--
-- These tables hold sensitive ops data — replication-slot names + lag, alert
-- messages, per-source-table row counts (people, send_log, …), and Airbyte
-- connection status/error strings. They were created (001, 004, 005) WITHOUT
-- RLS, so with the standard Supabase anon/authenticated PostgREST roles they
-- were readable by any caller. Every other module in this repo RLS-enables its
-- public tables; this brings warehouse-sync in line.
--
-- Model: the tables are written only by the module's workers via the
-- service-role client (which bypasses RLS), so no user-facing write policies
-- are needed. Reads are admin-only — this is operational data, not content —
-- so SELECT is gated on public.is_admin(). The module's own admin API
-- (api/register-routes.ts) reads via service-role and is separately gated by
-- requireJwt + an admin_profiles role check.

ALTER TABLE public.warehouse_sync_slot_health          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_sync_alerts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_sync_reconcile            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_sync_airbyte_connections  ENABLE ROW LEVEL SECURITY;

-- Admin-only SELECT. (No INSERT/UPDATE/DELETE policies: writes come from the
-- service-role workers, which bypass RLS. Absent write policies, non-service
-- roles are denied all writes by default — the desired posture.)
CREATE POLICY "warehouse_sync_slot_health_select"
  ON public.warehouse_sync_slot_health
  FOR SELECT TO authenticated USING (public.is_admin());

CREATE POLICY "warehouse_sync_alerts_select"
  ON public.warehouse_sync_alerts
  FOR SELECT TO authenticated USING (public.is_admin());

CREATE POLICY "warehouse_sync_reconcile_select"
  ON public.warehouse_sync_reconcile
  FOR SELECT TO authenticated USING (public.is_admin());

CREATE POLICY "warehouse_sync_airbyte_connections_select"
  ON public.warehouse_sync_airbyte_connections
  FOR SELECT TO authenticated USING (public.is_admin());

-- The health views (004) are defined over the tables above. Without
-- security_invoker a view executes with the view OWNER's rights and so
-- BYPASSES the underlying tables' RLS — re-opening the leak the policies above
-- close. security_invoker makes the view run with the querying user's rights,
-- so the is_admin() policies apply through the view too. (Postgres 15+.)
ALTER VIEW public.warehouse_sync_slot_health_latest SET (security_invoker = true);
ALTER VIEW public.warehouse_sync_open_alerts        SET (security_invoker = true);
