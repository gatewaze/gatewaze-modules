-- Re-apply 011 with `luma_guest_count > 0` filter throughout. Zero-count
-- events are almost always future/unopened (registration hasn't started
-- yet) — keeping them inflates event counts and pulls medians to zero.

CREATE OR REPLACE FUNCTION public.get_calendar_stats(p_calendar_id uuid)
RETURNS json
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_total_members int;
  v_total_events int;
  v_upcoming_events int;
  v_past_events int;
  v_total_guests int;
  v_total_tickets int;
  v_events_with_luma int;
  v_avg_all int;
  v_avg_6mo int;
  v_avg_tickets_all int;
  v_avg_tickets_6mo int;
  v_median_all numeric;
  v_median_6mo numeric;
  v_trim_all numeric;
  v_trim_6mo numeric;
  v_iqr_q1 numeric;
  v_iqr_q3 numeric;
  v_iqr_upper numeric;
  v_count_all int;
  v_count_6mo int;
  v_p10 numeric;
  v_p90 numeric;
  v_p10_6mo numeric;
  v_p90_6mo numeric;
BEGIN
  SELECT COUNT(*) INTO v_total_members
    FROM public.calendars_members
    WHERE calendar_id = p_calendar_id AND membership_status = 'active';

  SELECT COUNT(*) INTO v_total_events
    FROM public.calendars_events WHERE calendar_id = p_calendar_id;

  SELECT COUNT(*) INTO v_upcoming_events
    FROM public.calendars_events ce
    JOIN public.events e ON e.id = ce.event_id
    WHERE ce.calendar_id = p_calendar_id AND e.event_start > now();

  SELECT COUNT(*) INTO v_past_events
    FROM public.calendars_events ce
    JOIN public.events e ON e.id = ce.event_id
    WHERE ce.calendar_id = p_calendar_id AND e.event_end < now();

  -- Totals (include zeros) but count/avg only for events with actual attendance
  SELECT COALESCE(SUM(e.luma_guest_count), 0),
         COALESCE(SUM(e.luma_ticket_count), 0),
         COUNT(*) FILTER (WHERE e.luma_guest_count > 0),
         COALESCE(ROUND(AVG(e.luma_guest_count) FILTER (WHERE e.luma_guest_count > 0))::int, 0),
         COALESCE(ROUND(AVG(e.luma_ticket_count) FILTER (WHERE e.luma_ticket_count > 0))::int, 0)
  INTO v_total_guests, v_total_tickets, v_events_with_luma, v_avg_all, v_avg_tickets_all
  FROM public.calendars_events ce
  JOIN public.events e ON e.id = ce.event_id
  WHERE ce.calendar_id = p_calendar_id;

  SELECT COALESCE(ROUND(AVG(e.luma_guest_count))::int, 0),
         COALESCE(ROUND(AVG(e.luma_ticket_count))::int, 0)
  INTO v_avg_6mo, v_avg_tickets_6mo
  FROM public.calendars_events ce
  JOIN public.events e ON e.id = ce.event_id
  WHERE ce.calendar_id = p_calendar_id
    AND e.event_start >= now() - interval '6 months'
    AND e.luma_guest_count > 0;

  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY e.luma_guest_count),
         percentile_cont(0.1) WITHIN GROUP (ORDER BY e.luma_guest_count),
         percentile_cont(0.9) WITHIN GROUP (ORDER BY e.luma_guest_count),
         percentile_cont(0.25) WITHIN GROUP (ORDER BY e.luma_guest_count),
         percentile_cont(0.75) WITHIN GROUP (ORDER BY e.luma_guest_count),
         COUNT(*)
  INTO v_median_all, v_p10, v_p90, v_iqr_q1, v_iqr_q3, v_count_all
  FROM public.calendars_events ce
  JOIN public.events e ON e.id = ce.event_id
  WHERE ce.calendar_id = p_calendar_id AND e.luma_guest_count > 0;

  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY e.luma_guest_count),
         percentile_cont(0.1) WITHIN GROUP (ORDER BY e.luma_guest_count),
         percentile_cont(0.9) WITHIN GROUP (ORDER BY e.luma_guest_count),
         COUNT(*)
  INTO v_median_6mo, v_p10_6mo, v_p90_6mo, v_count_6mo
  FROM public.calendars_events ce
  JOIN public.events e ON e.id = ce.event_id
  WHERE ce.calendar_id = p_calendar_id
    AND e.event_start >= now() - interval '6 months'
    AND e.luma_guest_count > 0;

  v_iqr_upper := COALESCE(v_iqr_q3 + (v_iqr_q3 - v_iqr_q1) * 1.5, NULL);

  IF v_count_all >= 5 THEN
    SELECT AVG(e.luma_guest_count)
    INTO v_trim_all
    FROM public.calendars_events ce
    JOIN public.events e ON e.id = ce.event_id
    WHERE ce.calendar_id = p_calendar_id
      AND e.luma_guest_count > 0
      AND e.luma_guest_count BETWEEN v_p10 AND v_p90;
  ELSE
    v_trim_all := v_avg_all;
  END IF;

  IF v_count_6mo >= 5 THEN
    SELECT AVG(e.luma_guest_count)
    INTO v_trim_6mo
    FROM public.calendars_events ce
    JOIN public.events e ON e.id = ce.event_id
    WHERE ce.calendar_id = p_calendar_id
      AND e.event_start >= now() - interval '6 months'
      AND e.luma_guest_count > 0
      AND e.luma_guest_count BETWEEN v_p10_6mo AND v_p90_6mo;
  ELSE
    v_trim_6mo := v_avg_6mo;
  END IF;

  RETURN json_build_object(
    'total_members', v_total_members,
    'total_events', v_total_events,
    'upcoming_events', v_upcoming_events,
    'past_events', v_past_events,
    'total_luma_guests', v_total_guests,
    'total_luma_tickets', v_total_tickets,
    'avg_luma_guests_all_time', v_avg_all,
    'avg_luma_guests_6mo', COALESCE(v_avg_6mo, 0),
    'avg_luma_tickets_all_time', v_avg_tickets_all,
    'avg_luma_tickets_6mo', COALESCE(v_avg_tickets_6mo, 0),
    'median_luma_guests_all_time', COALESCE(ROUND(v_median_all)::int, 0),
    'median_luma_guests_6mo', COALESCE(ROUND(v_median_6mo)::int, 0),
    'trimmed_mean_luma_guests_all_time', COALESCE(ROUND(v_trim_all)::int, 0),
    'trimmed_mean_luma_guests_6mo', COALESCE(ROUND(v_trim_6mo)::int, 0),
    'iqr_upper_luma_guests', COALESCE(ROUND(v_iqr_upper)::int, NULL),
    'events_with_luma_data', v_events_with_luma
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_calendar_guest_timeline(p_calendar_id uuid)
RETURNS TABLE(
  event_id uuid,
  event_title text,
  event_start timestamptz,
  luma_guest_count int,
  is_outlier boolean
)
LANGUAGE sql
STABLE
AS $function$
  WITH bounds AS (
    SELECT
      percentile_cont(0.25) WITHIN GROUP (ORDER BY e.luma_guest_count) AS q1,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY e.luma_guest_count) AS q3
    FROM public.calendars_events ce
    JOIN public.events e ON e.id = ce.event_id
    WHERE ce.calendar_id = p_calendar_id AND e.luma_guest_count > 0
  )
  SELECT
    e.id,
    e.event_title,
    e.event_start,
    e.luma_guest_count,
    (e.luma_guest_count > (b.q3 + (b.q3 - b.q1) * 1.5)) AS is_outlier
  FROM public.calendars_events ce
  JOIN public.events e ON e.id = ce.event_id
  CROSS JOIN bounds b
  WHERE ce.calendar_id = p_calendar_id
    AND e.luma_guest_count > 0
    AND e.event_start IS NOT NULL
  ORDER BY e.event_start;
$function$;
