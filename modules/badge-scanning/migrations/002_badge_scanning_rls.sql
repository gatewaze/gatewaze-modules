-- ============================================================================
-- Module: badge-scanning
-- Migration: 002_badge_scanning_rls
-- Description: RLS policies for all badge-scanning tables.
--              Moved from core 00007_rls_policies.sql and updated for
--              events_ prefix table names.
-- ============================================================================

-- ==========================================================================
-- Enable RLS
-- ==========================================================================
ALTER TABLE public.events_badge_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_badge_print_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_badge_prints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_qr_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_contact_scans ENABLE ROW LEVEL SECURITY;

-- ==========================================================================
-- events_badge_templates (global, admin-only)
-- ==========================================================================
CREATE POLICY "badge_templates_select"
  ON public.events_badge_templates FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE POLICY "badge_templates_insert"
  ON public.events_badge_templates FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "badge_templates_update"
  ON public.events_badge_templates FOR UPDATE TO authenticated
  USING (public.is_admin());

CREATE POLICY "badge_templates_delete"
  ON public.events_badge_templates FOR DELETE TO authenticated
  USING (public.is_super_admin());

-- ==========================================================================
-- events_badge_print_jobs (uses event_id varchar -> can_admin_event_by_eid)
-- ==========================================================================
CREATE POLICY "badge_print_jobs_select"
  ON public.events_badge_print_jobs FOR SELECT TO authenticated
  USING (public.can_admin_event_by_eid(event_id));

CREATE POLICY "badge_print_jobs_insert"
  ON public.events_badge_print_jobs FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_event_by_eid(event_id));

CREATE POLICY "badge_print_jobs_update"
  ON public.events_badge_print_jobs FOR UPDATE TO authenticated
  USING (public.can_admin_event_by_eid(event_id));

CREATE POLICY "badge_print_jobs_delete"
  ON public.events_badge_print_jobs FOR DELETE TO authenticated
  USING (public.can_admin_event_by_eid(event_id));

-- ==========================================================================
-- events_badge_prints
-- ==========================================================================
CREATE POLICY "badge_prints_select"
  ON public.events_badge_prints FOR SELECT TO authenticated
  USING (public.can_admin_event_by_eid(event_id));

CREATE POLICY "badge_prints_insert"
  ON public.events_badge_prints FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_event_by_eid(event_id));

CREATE POLICY "badge_prints_update"
  ON public.events_badge_prints FOR UPDATE TO authenticated
  USING (public.can_admin_event_by_eid(event_id));

CREATE POLICY "badge_prints_delete"
  ON public.events_badge_prints FOR DELETE TO authenticated
  USING (public.can_admin_event_by_eid(event_id));

-- ==========================================================================
-- events_qr_access_tokens (uses people_profile_id column)
-- ==========================================================================
CREATE POLICY "qr_access_tokens_select"
  ON public.events_qr_access_tokens FOR SELECT TO authenticated
  USING (public.is_own_people_profile(people_profile_id) OR public.is_admin());

CREATE POLICY "qr_access_tokens_insert"
  ON public.events_qr_access_tokens FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY "qr_access_tokens_update"
  ON public.events_qr_access_tokens FOR UPDATE TO authenticated
  USING (public.is_admin());

CREATE POLICY "qr_access_tokens_delete"
  ON public.events_qr_access_tokens FOR DELETE TO authenticated
  USING (public.is_admin());

-- ==========================================================================
-- events_contact_scans
-- ==========================================================================
CREATE POLICY "contact_scans_select"
  ON public.events_contact_scans FOR SELECT TO authenticated
  USING (
    scanner_people_profile_id IN (
      SELECT pp.id FROM public.people_profiles pp
      JOIN public.people p ON p.id = pp.person_id
      WHERE p.auth_user_id = auth.uid()
    )
    OR public.can_admin_event_by_eid(event_id)
  );

CREATE POLICY "contact_scans_insert"
  ON public.events_contact_scans FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "contact_scans_update"
  ON public.events_contact_scans FOR UPDATE TO authenticated
  USING (public.can_admin_event_by_eid(event_id));

CREATE POLICY "contact_scans_delete"
  ON public.events_contact_scans FOR DELETE TO authenticated
  USING (public.can_admin_event_by_eid(event_id));
