-- =====================================================================
-- Module: calendars
-- Migration: 014_calendars_admin_write_policies
-- =====================================================================
-- Migration 013 enabled RLS on public.calendars with only SELECT policies
-- for anon/authenticated (filtered to is_active=true AND visibility='public').
-- Its comment claimed writes would flow through "service-role bypass", but
-- the admin app uses the anon key with user auth (authenticated role) and
-- not service_role — so every UPDATE/INSERT/DELETE was silently rejected
-- by RLS, returning 0 rows and surfacing as "Cannot coerce the result to a
-- single JSON object" via PostgREST's .single() handler.
--
-- This migration adds the missing write policies, mirroring the pattern
-- used in migration 001 for calendars_events / calendars_members /
-- scrapers_calendars, and adds an admin-scoped SELECT so super-admins and
-- granted admins can also see private/unlisted calendars they manage.
-- =====================================================================

-- Admin-scoped SELECT — lets admins view private/unlisted calendars they
-- have permission to manage. The two existing public-read policies stay
-- in place; PostgREST applies the union of all matching policies.
DROP POLICY IF EXISTS "calendars_select_admin" ON public.calendars;
CREATE POLICY "calendars_select_admin"
  ON public.calendars FOR SELECT TO authenticated
  USING (public.can_admin_calendar(id));

-- INSERT — only super-admins can create calendars from scratch. A regular
-- admin needs a permission row, but a permission row can't exist before
-- the calendar does, so the create-time check has to be super-admin only.
-- After creation, the super-admin can grant access to other admins.
DROP POLICY IF EXISTS "calendars_insert_admin" ON public.calendars;
CREATE POLICY "calendars_insert_admin"
  ON public.calendars FOR INSERT TO authenticated
  WITH CHECK (public.is_super_admin());

-- UPDATE / DELETE — gated on can_admin_calendar(id), which covers super
-- admins as well as admins who have been granted manage permission via
-- admin_calendar_permissions.
DROP POLICY IF EXISTS "calendars_update_admin" ON public.calendars;
CREATE POLICY "calendars_update_admin"
  ON public.calendars FOR UPDATE TO authenticated
  USING (public.can_admin_calendar(id))
  WITH CHECK (public.can_admin_calendar(id));

DROP POLICY IF EXISTS "calendars_delete_admin" ON public.calendars;
CREATE POLICY "calendars_delete_admin"
  ON public.calendars FOR DELETE TO authenticated
  USING (public.can_admin_calendar(id));
