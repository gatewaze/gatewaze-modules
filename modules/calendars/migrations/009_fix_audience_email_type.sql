-- =====================================================================
-- Fix resolve_calendar_audience return type mismatch
-- =====================================================================
--
-- calendars_members.email is `character varying`, so COALESCE(cm.email, p.email)
-- evaluates to `character varying`, which mismatches the function's declared
-- `text` return type for column 3 (email) and produces:
--
--   42804: structure of query does not match function result type
--          "Returned type character varying does not match expected type text
--           in column 3."
--
-- Explicit ::text casts on the email and membership_type columns silence the
-- error without changing behaviour. This replaces the function defined in
-- migrations 004_calendar_messaging + 007_fix_audience_event_column.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.resolve_calendar_audience(
  p_calendar_id uuid,
  p_filter      jsonb,
  p_channel     text DEFAULT 'email'
)
RETURNS TABLE (
  member_id       uuid,
  person_id       uuid,
  email           text,
  phone           text,
  membership_type text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_membership_types text[];
  v_status_filter    text[];
  v_require_email    boolean;
  v_groups           jsonb;
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
      cm.id                                    AS member_id,
      cm.person_id                             AS person_id,
      COALESCE(cm.email, p.email)::text        AS email,
      p.phone::text                            AS phone,
      cm.membership_type::text                 AS membership_type
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
                JOIN public.calendars_events ce ON ce.event_id = er.event_id
                WHERE ce.calendar_id = p_calendar_id
                  AND er.event_id = ANY(
                    ARRAY(SELECT (jsonb_array_elements_text(g->'event_ids'))::uuid)
                  )
                UNION ALL
                SELECT ei.person_id
                FROM public.events_interest ei
                JOIN public.calendars_events ce ON ce.event_id = ei.event_id
                WHERE ce.calendar_id = p_calendar_id
                  AND ei.event_id = ANY(
                    ARRAY(SELECT (jsonb_array_elements_text(g->'event_ids'))::uuid)
                  )
              ) q
              WHERE q.person_id = b.person_id
            )
          WHEN 'none_of' THEN
            NOT EXISTS (
              SELECT 1
              FROM (
                SELECT er.person_id
                FROM public.events_registrations er
                JOIN public.calendars_events ce ON ce.event_id = er.event_id
                WHERE ce.calendar_id = p_calendar_id
                  AND er.event_id = ANY(
                    ARRAY(SELECT (jsonb_array_elements_text(g->'event_ids'))::uuid)
                  )
              ) q
              WHERE q.person_id = b.person_id
            )
          ELSE TRUE
        END
      )
    )
  )
  SELECT f.member_id, f.person_id, f.email, f.phone, f.membership_type
  FROM filtered f;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_calendar_audience(uuid, jsonb, text) TO authenticated, service_role, anon;
