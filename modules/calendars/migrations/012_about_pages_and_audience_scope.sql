-- =====================================================================
-- Module: calendars
-- Migration: 012_about_pages_and_audience_scope
-- =====================================================================
-- Adds:
--   1. About page rich-text columns on calendars: about_organisers,
--      about_faq, about_sponsors. Each stores HTML produced by the admin
--      Tiptap editor.
--   2. Extends resolve_calendar_audience(...) so participation groups
--      carry a `scope` ("specific" | "any_past_calendar_event") and the
--      `kind` ("registered" | "attended") is properly honoured.
--      "attended" filters on events_registrations.checked_in_at IS NOT NULL.
--      "any_past_calendar_event" ignores event_ids and matches any event
--      in the calendar with event_start < now().
-- =====================================================================

ALTER TABLE public.calendars
  ADD COLUMN IF NOT EXISTS about_organisers text,
  ADD COLUMN IF NOT EXISTS about_faq        text,
  ADD COLUMN IF NOT EXISTS about_sponsors   text;

COMMENT ON COLUMN public.calendars.about_organisers IS 'Rich-text HTML rendered on the calendar About page (Organisers section).';
COMMENT ON COLUMN public.calendars.about_faq        IS 'Rich-text HTML rendered on the calendar About page (FAQ section).';
COMMENT ON COLUMN public.calendars.about_sponsors   IS 'Rich-text HTML rendered on the calendar About page (Sponsors section).';

-- Member interests captured at join time (chips populated from upcoming
-- events' topics on the join form). Stored as a free-form text[] so future
-- audience targeting can filter on it without further schema changes.
ALTER TABLE public.calendars_members
  ADD COLUMN IF NOT EXISTS interests text[];

COMMENT ON COLUMN public.calendars_members.interests IS 'Topics the member said they care about at signup. Free-form (not constrained to a fixed taxonomy).';

-- ---------------------------------------------------------------------
-- resolve_calendar_audience: kind-aware + scope-aware participation
-- ---------------------------------------------------------------------
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
        -- Each group is a predicate the member must satisfy.
        -- Predicate logic depends on mode + kind + scope.
        public.calendar_audience_group_match(p_calendar_id, b.person_id, g)
      )
    )
  )
  SELECT f.member_id, f.person_id, f.email, f.phone, f.membership_type
  FROM filtered f;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_calendar_audience(uuid, jsonb, text) TO authenticated, service_role, anon;

-- ---------------------------------------------------------------------
-- Helper: evaluate one participation group for one person.
-- Group shape:
--   {
--     mode:      'any_of' | 'all_of' | 'none_of',
--     kind:      'registered' | 'attended',
--     scope:     'specific' | 'any_past_calendar_event',  -- optional, default 'specific'
--     event_ids: uuid[]                                    -- ignored when scope='any_past_calendar_event'
--   }
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calendar_audience_group_match(
  p_calendar_id uuid,
  p_person_id   uuid,
  g             jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mode      text := COALESCE(g->>'mode', 'any_of');
  v_kind      text := COALESCE(g->>'kind', 'registered');
  v_scope     text := COALESCE(g->>'scope', 'specific');
  v_event_ids uuid[];
  v_target_ct int;
  v_match_ct  int;
BEGIN
  IF v_scope = 'any_past_calendar_event' THEN
    -- Resolve "any past event in this calendar" to the concrete event_id set.
    v_event_ids := ARRAY(
      SELECT ce.event_id
      FROM public.calendars_events ce
      JOIN public.events e ON e.id = ce.event_id
      WHERE ce.calendar_id = p_calendar_id
        AND e.event_start IS NOT NULL
        AND e.event_start < now()
    );
  ELSE
    v_event_ids := COALESCE(
      ARRAY(SELECT (jsonb_array_elements_text(g->'event_ids'))::uuid),
      ARRAY[]::uuid[]
    );
  END IF;

  -- Empty target set: any_of/all_of are vacuously false; none_of is vacuously true.
  IF array_length(v_event_ids, 1) IS NULL THEN
    RETURN v_mode = 'none_of';
  END IF;

  IF v_mode IN ('any_of', 'none_of') THEN
    SELECT COUNT(*) INTO v_match_ct
    FROM public.events_registrations er
    WHERE er.person_id = p_person_id
      AND er.event_id = ANY(v_event_ids)
      AND (v_kind <> 'attended' OR er.checked_in_at IS NOT NULL);

    IF v_mode = 'any_of'  THEN RETURN v_match_ct > 0; END IF;
    IF v_mode = 'none_of' THEN RETURN v_match_ct = 0; END IF;
  END IF;

  IF v_mode = 'all_of' THEN
    v_target_ct := array_length(v_event_ids, 1);
    SELECT COUNT(DISTINCT er.event_id) INTO v_match_ct
    FROM public.events_registrations er
    WHERE er.person_id = p_person_id
      AND er.event_id = ANY(v_event_ids)
      AND (v_kind <> 'attended' OR er.checked_in_at IS NOT NULL);
    RETURN v_match_ct = v_target_ct;
  END IF;

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.calendar_audience_group_match(uuid, uuid, jsonb) TO authenticated, service_role, anon;
