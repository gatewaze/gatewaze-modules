-- ============================================================================
-- Module: calendars
-- Migration: 007_fix_audience_event_column
-- Description: Fixes resolve_calendar_audience() and count_calendar_audience()
--              to reference events_registrations.event_id (the uuid FK)
--              instead of the non-existent er.event_uuid. The original 004
--              was written against a speculative schema where the column
--              was called event_uuid; the actual column is event_id.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.resolve_calendar_audience(
  p_calendar_id uuid,
  p_filter      jsonb,
  p_channel     text DEFAULT 'email'
) RETURNS TABLE (
  member_id        uuid,
  person_id        uuid,
  email            text,
  phone            text,
  membership_type  text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_membership_types text[];
  v_status_filter text[];
  v_require_email boolean;
  v_groups jsonb;
BEGIN
  v_membership_types := COALESCE(
    ARRAY(SELECT jsonb_array_elements_text(p_filter->'membership_types')),
    ARRAY[]::text[]
  );
  v_status_filter := COALESCE(
    ARRAY(SELECT jsonb_array_elements_text(p_filter->'membership_status')),
    ARRAY['active']::text[]
  );
  v_require_email := COALESCE((p_filter->>'require_email_notifications')::boolean, p_channel = 'email');
  v_groups := COALESCE(p_filter->'event_participation', '[]'::jsonb);

  RETURN QUERY
  WITH base AS (
    SELECT
      cm.id            AS member_id,
      cm.person_id     AS person_id,
      COALESCE(cm.email, p.email)  AS email,
      p.phone          AS phone,
      cm.membership_type
    FROM public.calendars_members cm
    LEFT JOIN public.people p ON p.id = cm.person_id
    WHERE cm.calendar_id = p_calendar_id
      AND cm.membership_status = ANY(v_status_filter)
      AND (array_length(v_membership_types, 1) IS NULL OR cm.membership_type = ANY(v_membership_types))
      AND (
        p_channel <> 'email'
        OR (
          (NOT v_require_email OR cm.email_notifications = true)
          AND cm.confirmed_at IS NOT NULL
          AND cm.unsubscribed_at IS NULL
          AND COALESCE(cm.email, p.email) IS NOT NULL
        )
      )
      AND (
        p_channel NOT IN ('sms','whatsapp')
        OR p.phone IS NOT NULL
      )
  ),
  filtered AS (
    SELECT b.*
    FROM base b
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_groups) AS g
      WHERE NOT (
        CASE g->>'mode'
          WHEN 'any_of' THEN
            EXISTS (
              SELECT 1
              FROM (
                SELECT er.person_id
                FROM public.events_registrations er
                JOIN public.events e ON e.id = er.event_id
                WHERE g->>'kind' = 'registered'
                  AND er.person_id = b.person_id
                  AND e.event_id = ANY(ARRAY(SELECT jsonb_array_elements_text(g->'event_ids')))
                UNION
                SELECT er.person_id
                FROM public.events_registrations er
                JOIN public.events e ON e.id = er.event_id
                WHERE g->>'kind' = 'attended'
                  AND er.person_id = b.person_id
                  AND er.checked_in_at IS NOT NULL
                  AND e.event_id = ANY(ARRAY(SELECT jsonb_array_elements_text(g->'event_ids')))
              ) match
            )
          WHEN 'all_of' THEN
            (
              SELECT count(DISTINCT e.event_id)
              FROM public.events_registrations er
              JOIN public.events e ON e.id = er.event_id
              WHERE er.person_id = b.person_id
                AND e.event_id = ANY(ARRAY(SELECT jsonb_array_elements_text(g->'event_ids')))
                AND (g->>'kind' = 'registered' OR (g->>'kind' = 'attended' AND er.checked_in_at IS NOT NULL))
            ) = jsonb_array_length(g->'event_ids')
          WHEN 'none_of' THEN
            NOT EXISTS (
              SELECT 1
              FROM public.events_registrations er
              JOIN public.events e ON e.id = er.event_id
              WHERE er.person_id = b.person_id
                AND e.event_id = ANY(ARRAY(SELECT jsonb_array_elements_text(g->'event_ids')))
                AND (g->>'kind' = 'registered' OR (g->>'kind' = 'attended' AND er.checked_in_at IS NOT NULL))
            )
          ELSE TRUE
        END
      )
    )
  )
  SELECT
    f.member_id,
    f.person_id,
    f.email,
    f.phone,
    f.membership_type
  FROM filtered f;
END;
$$;
