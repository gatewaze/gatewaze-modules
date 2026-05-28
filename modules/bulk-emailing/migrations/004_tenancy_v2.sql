-- =============================================================================
-- Module: bulk-emailing
-- Migration: 004_tenancy_v2
-- Description: dual-track v1/v2 RLS on the event-scoped bulk-emailing
--              table (events_communication_settings). Replaces the
--              `authenticated_all_events_communication_settings`
--              `USING (true)` policy with a flag-gated v1 / v2 pair.
--
-- Out of scope (deferred to follow-up): email_subscriptions,
-- email_events, email_send_log, email_interactions,
-- email_interaction_scores, email_batch_jobs, notification_logs,
-- email_topic_labels. These are platform-wide tables keyed by email
-- (not event_id or account_id). Tenant-scoping them requires adding
-- account_id columns plus a per-tenant subscription model — a larger
-- product decision tracked separately.
--
-- Depends on: gatewaze core 00024_tenancy_v2_helpers.sql.
-- =============================================================================

DROP POLICY IF EXISTS "authenticated_all_events_communication_settings"
  ON public.events_communication_settings;

CREATE POLICY "events_comm_settings_auth_v1"
  ON public.events_communication_settings FOR ALL TO authenticated
  USING (NOT public.tenancy_v2_enforced())
  WITH CHECK (NOT public.tenancy_v2_enforced());

CREATE POLICY "events_comm_settings_select_v2"
  ON public.events_communication_settings FOR SELECT TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = events_communication_settings.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

CREATE POLICY "events_comm_settings_modify_v2"
  ON public.events_communication_settings FOR ALL TO authenticated
  USING (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = events_communication_settings.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  )
  WITH CHECK (
    public.tenancy_v2_enforced()
    AND (
      EXISTS (
        SELECT 1 FROM public.events e
        WHERE e.id = events_communication_settings.event_id
          AND public.account_in_scope(e.account_id)
      )
      OR public.is_super_admin()
    )
  );

CREATE POLICY "events_comm_settings_service_role"
  ON public.events_communication_settings FOR ALL TO service_role
  USING (true) WITH CHECK (true);
