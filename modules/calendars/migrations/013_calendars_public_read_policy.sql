-- =====================================================================
-- Module: calendars
-- Migration: 013_calendars_public_read_policy
-- =====================================================================
-- Migration 001 enables RLS on the related tables (calendars_members,
-- scrapers_calendars, etc.) but never adds a SELECT policy to the parent
-- public.calendars table. Supabase Cloud auto-enables RLS on new public
-- tables, so the result is RLS=on with zero policies — meaning anon and
-- authenticated see zero rows, and the portal /calendars listing comes up
-- empty even when calendars exist. Service-role bypass is why the admin
-- side and scrapers were unaffected.
--
-- Add an explicit public-read policy that mirrors the portal query
-- (is_active=true AND visibility='public') and a parallel read policy
-- for authenticated viewers. Write operations stay locked to service-role
-- (no INSERT/UPDATE/DELETE policy → only bypass roles can mutate).
-- =====================================================================

ALTER TABLE public.calendars ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "calendars_select_public" ON public.calendars;
CREATE POLICY "calendars_select_public"
  ON public.calendars FOR SELECT TO anon
  USING (is_active = true AND visibility = 'public');

DROP POLICY IF EXISTS "calendars_select_authenticated" ON public.calendars;
CREATE POLICY "calendars_select_authenticated"
  ON public.calendars FOR SELECT TO authenticated
  USING (is_active = true AND visibility = 'public');
