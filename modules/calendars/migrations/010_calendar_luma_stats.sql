-- Extend get_calendar_stats with Luma attendance rollups.
--
-- Adds six new fields:
--   total_luma_guests          — sum of luma_guest_count across all calendar events
--   total_luma_tickets         — sum of luma_ticket_count across all calendar events
--   avg_luma_guests_all_time   — average guest count per event (all events with a count)
--   avg_luma_guests_6mo        — same, restricted to events in the last 6 months
--   avg_luma_tickets_all_time  — average ticket count per event (all time)
--   avg_luma_tickets_6mo       — same, last 6 months
--
-- NULL-safe throughout: events without a luma_guest_count are excluded from
-- averages, and 0 is returned instead of NULL when the calendar has no data.
--
-- Depends on the scrapers module's migration 009 having added luma_guest_count
-- and luma_ticket_count to events. If you run calendars without scrapers the
-- RPC will fail — that's by design, you need both modules for these metrics.

CREATE OR REPLACE FUNCTION public.get_calendar_stats(p_calendar_id uuid)
RETURNS json
LANGUAGE sql
STABLE
AS $function$
  SELECT json_build_object(
    'total_members', (
      SELECT COUNT(*)::int FROM public.calendars_members
      WHERE calendar_id = p_calendar_id AND membership_status = 'active'
    ),
    'total_events', (
      SELECT COUNT(*)::int FROM public.calendars_events WHERE calendar_id = p_calendar_id
    ),
    'upcoming_events', (
      SELECT COUNT(*)::int FROM public.calendars_events ce
      JOIN public.events e ON e.id = ce.event_id
      WHERE ce.calendar_id = p_calendar_id AND e.event_start > now()
    ),
    'past_events', (
      SELECT COUNT(*)::int FROM public.calendars_events ce
      JOIN public.events e ON e.id = ce.event_id
      WHERE ce.calendar_id = p_calendar_id AND e.event_end < now()
    ),
    'total_luma_guests', (
      SELECT COALESCE(SUM(e.luma_guest_count), 0)::int FROM public.calendars_events ce
      JOIN public.events e ON e.id = ce.event_id
      WHERE ce.calendar_id = p_calendar_id
    ),
    'total_luma_tickets', (
      SELECT COALESCE(SUM(e.luma_ticket_count), 0)::int FROM public.calendars_events ce
      JOIN public.events e ON e.id = ce.event_id
      WHERE ce.calendar_id = p_calendar_id
    ),
    'avg_luma_guests_all_time', (
      SELECT COALESCE(ROUND(AVG(e.luma_guest_count))::int, 0) FROM public.calendars_events ce
      JOIN public.events e ON e.id = ce.event_id
      WHERE ce.calendar_id = p_calendar_id AND e.luma_guest_count IS NOT NULL
    ),
    'avg_luma_guests_6mo', (
      SELECT COALESCE(ROUND(AVG(e.luma_guest_count))::int, 0) FROM public.calendars_events ce
      JOIN public.events e ON e.id = ce.event_id
      WHERE ce.calendar_id = p_calendar_id
        AND e.luma_guest_count IS NOT NULL
        AND e.event_start >= now() - interval '6 months'
    ),
    'avg_luma_tickets_all_time', (
      SELECT COALESCE(ROUND(AVG(e.luma_ticket_count))::int, 0) FROM public.calendars_events ce
      JOIN public.events e ON e.id = ce.event_id
      WHERE ce.calendar_id = p_calendar_id AND e.luma_ticket_count IS NOT NULL
    ),
    'avg_luma_tickets_6mo', (
      SELECT COALESCE(ROUND(AVG(e.luma_ticket_count))::int, 0) FROM public.calendars_events ce
      JOIN public.events e ON e.id = ce.event_id
      WHERE ce.calendar_id = p_calendar_id
        AND e.luma_ticket_count IS NOT NULL
        AND e.event_start >= now() - interval '6 months'
    ),
    'events_with_luma_data', (
      SELECT COUNT(*)::int FROM public.calendars_events ce
      JOIN public.events e ON e.id = ce.event_id
      WHERE ce.calendar_id = p_calendar_id AND e.luma_guest_count IS NOT NULL
    )
  );
$function$;
