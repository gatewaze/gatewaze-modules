-- =====================================================================
-- Module: calendars
-- Migration: 014_calendars_events_public_read_policy
-- =====================================================================
-- Sister fix to 013: migration 001 enabled RLS on the calendars_events
-- junction table and added an admin-only SELECT policy, but no anon /
-- authenticated read policy. Result on Supabase Cloud is that the
-- portal — which queries with the anon key — gets zero rows back from
-- /calendars_events even when the parent calendar is public, so:
--   * the calendar microsite's Events tab is hidden (visibility check
--     counts calendars_events rows for the calendar; sees 0)
--   * getCalendarWithEvents() returns an empty events list
-- Service-role bypass kept admin/scrapers unaffected, masking the bug
-- until a calendar with events shipped to production.
--
-- The link table doesn't need extra gating beyond the parent: both
-- public.calendars (per migration 013) and public.events already filter
-- on visibility/is_live_in_production, so a USING (true) anon read here
-- mirrors the events-module pattern and stays consistent.
-- =====================================================================

DROP POLICY IF EXISTS "calendar_events_select_public" ON public.calendars_events;
CREATE POLICY "calendar_events_select_public"
  ON public.calendars_events FOR SELECT TO anon
  USING (true);

DROP POLICY IF EXISTS "calendar_events_select_authenticated_read" ON public.calendars_events;
CREATE POLICY "calendar_events_select_authenticated_read"
  ON public.calendars_events FOR SELECT TO authenticated
  USING (true);
