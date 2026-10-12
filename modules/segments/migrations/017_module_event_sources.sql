-- ============================================================================
-- Module: segments
-- Migration: 017_module_event_sources
-- Description: Resolve discount_claimed, competition_entered, offer_viewed and
-- offer_accepted conditions against the tables those modules write, the way
-- 007 did for event_registered / event_attended.
--
-- Context: these four event types fell through to the people_events stream,
-- which nothing writes them to. Every such condition matched 0 people, e.g.
-- "has performed discount_claimed where event title contains PyTorch" returned
-- 0 on tech.tickets although 1,235 people hold a PyTorch claim.
--
-- Sources:
--   discount_claimed     events_discount_claims (by email) + events_discounts
--                        + events. Default: every claim status except
--                        'viewed' (saw the offer, never claimed). A status
--                        filter replaces the default.
--   competition_entered  events_competition_entries (by person_id)
--                        + events_competitions + events. Default: status
--                        other than 'viewed'. A status filter replaces it.
--   offer_viewed         integrations_offer_interactions (by email),
--   offer_accepted       offer_status 'viewed' / 'accepted'. Event filters
--                        match the offer slug (offer_id).
--
-- Every other event type keeps the 007 behaviour unchanged. A source table
-- that is not installed falls back to people_events, as before.
-- ============================================================================
SET LOCAL check_function_bodies = off;

-- Per-person lookups match on lower(email); index both email-keyed sources.
DO $$
BEGIN
  IF to_regclass('public.events_discount_claims') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_events_discount_claims_lower_email
      ON public.events_discount_claims (lower(email));
  END IF;
  IF to_regclass('public.integrations_offer_interactions') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_integrations_offer_interactions_lower_email
      ON public.integrations_offer_interactions (lower(email), offer_status);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.segments_event_to_sql(cond jsonb)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_name     text := cond->>'event_type';
  v_op       text := cond->>'operator';
  v_count    int  := GREATEST(COALESCE(NULLIF(cond->>'value', '')::int, 1), 0);
  v_tw       jsonb := cond->'time_window';
  v_filters  jsonb := COALESCE(cond->'event_filters', cond->'property_filters');
  v_kind     text := NULL;      -- which authoritative source handles v_name
  v_src      text := NULL;      -- FROM clause for the authoritative path
  v_time_col text := 'r.created_at';
  v_where    text;
  v_default  text := '';        -- default status scope, dropped by a status filter
  v_time     text := '';
  v_filt     text := '';
  v_f        jsonb;
  v_prop     text;
  v_fop      text;
  v_val      text;
  v_col      text;
  v_has_status_filter boolean := false;
BEGIN
  IF v_name IS NULL OR v_name = '' THEN
    RETURN 'true';
  END IF;

  -- Pick the authoritative source for this event type, if installed.
  IF v_name = 'event_registered' AND to_regclass('public.events_registrations') IS NOT NULL THEN
    v_kind := 'registration';
    v_src := 'public.events_registrations r';
    v_where := 'r.person_id = p.id';
  ELSIF v_name = 'event_attended' AND to_regclass('public.events_attendance') IS NOT NULL THEN
    v_kind := 'attendance';
    v_src := 'public.events_attendance r';
    v_where := 'r.person_id = p.id';
  ELSIF v_name = 'discount_claimed'
        AND to_regclass('public.events_discount_claims') IS NOT NULL
        AND to_regclass('public.events_discounts') IS NOT NULL THEN
    v_kind := 'discount';
    v_src := 'public.events_discount_claims r'
          || ' JOIN public.events_discounts d ON d.id = r.discount_id'
          || ' LEFT JOIN public.events ev ON ev.id = d.event_id';
    v_where := 'lower(r.email) = lower(p.email)';
    v_time_col := 'COALESCE(r.accepted_at, r.created_at)';
    v_default := ' AND r.status IS DISTINCT FROM ''viewed''';
  ELSIF v_name = 'competition_entered'
        AND to_regclass('public.events_competition_entries') IS NOT NULL
        AND to_regclass('public.events_competitions') IS NOT NULL THEN
    v_kind := 'competition';
    v_src := 'public.events_competition_entries r'
          || ' JOIN public.events_competitions c ON c.id = r.competition_id'
          || ' LEFT JOIN public.events ev ON ev.id = c.event_id';
    v_where := 'r.person_id = p.id';
    v_time_col := 'COALESCE(r.entered_at, r.created_at)';
    v_default := ' AND r.status IS DISTINCT FROM ''viewed''';
  ELSIF v_name IN ('offer_viewed', 'offer_accepted')
        AND to_regclass('public.integrations_offer_interactions') IS NOT NULL THEN
    v_kind := 'offer';
    v_src := 'public.integrations_offer_interactions r';
    v_where := format('lower(r.email) = lower(p.email) AND r.offer_status = %L',
                      CASE v_name WHEN 'offer_viewed' THEN 'viewed' ELSE 'accepted' END);
    v_time_col := 'COALESCE(r."timestamp", r.created_at)';
  END IF;

  -- ---- Authoritative source path -------------------------------------------
  IF v_kind IS NOT NULL THEN
    IF v_tw IS NOT NULL AND COALESCE(v_tw->>'type', 'relative') = 'relative' THEN
      v_time := format(' AND %s >= now() - ((%L || '' '' || %L)::interval)', v_time_col,
        COALESCE(NULLIF(v_tw->>'relative_value', '')::int, 30)::text,
        COALESCE(NULLIF(v_tw->>'relative_unit', ''), 'days'));
    ELSIF v_tw IS NOT NULL AND v_tw->>'type' = 'absolute' THEN
      IF v_tw ? 'start_date' THEN v_time := v_time || format(' AND %s >= %L', v_time_col, v_tw->>'start_date'); END IF;
      IF v_tw ? 'end_date'   THEN v_time := v_time || format(' AND %s <= %L', v_time_col, v_tw->>'end_date'); END IF;
    END IF;

    IF v_filters IS NOT NULL AND jsonb_typeof(v_filters) = 'array' THEN
      FOR v_f IN SELECT * FROM jsonb_array_elements(v_filters)
      LOOP
        v_prop := v_f->>'property';
        v_fop  := COALESCE(v_f->>'operator', 'equals');
        v_val  := v_f->>'value';
        CONTINUE WHEN v_prop IS NULL OR v_prop = '';
        -- Column expressions come only from this fixed map; values are quoted
        -- with %L below. Unknown properties are ignored (don't constrain).
        v_col := CASE v_kind
          WHEN 'offer' THEN CASE v_prop
            WHEN 'event_title'   THEN 'r.offer_id'
            WHEN 'event_name'    THEN 'r.offer_id'
            WHEN 'event_id'      THEN 'r.offer_id'
            WHEN 'offer_id'      THEN 'r.offer_id'
            WHEN 'offer_partner' THEN 'r.offer_partner'
            WHEN 'offer_type'    THEN 'r.offer_type'
            ELSE NULL END
          WHEN 'discount' THEN CASE v_prop
            WHEN 'event_city'         THEN 'ev.event_city'
            WHEN 'event_country_code' THEN 'ev.event_country_code'
            WHEN 'event_country'      THEN 'ev.event_country_code'
            -- Older discounts have no event; fall back to the discount title.
            WHEN 'event_title'        THEN 'COALESCE(ev.event_title, d.title)'
            WHEN 'event_name'         THEN 'COALESCE(ev.event_title, d.title)'
            WHEN 'event_id'           THEN 'ev.event_id'
            WHEN 'status'             THEN 'r.status'
            ELSE NULL END
          WHEN 'competition' THEN CASE v_prop
            WHEN 'event_city'         THEN 'ev.event_city'
            WHEN 'event_country_code' THEN 'ev.event_country_code'
            WHEN 'event_country'      THEN 'ev.event_country_code'
            WHEN 'event_title'        THEN 'COALESCE(ev.event_title, c.title)'
            WHEN 'event_name'         THEN 'COALESCE(ev.event_title, c.title)'
            WHEN 'event_id'           THEN 'ev.event_id'
            WHEN 'status'             THEN 'r.status'
            ELSE NULL END
          ELSE CASE v_prop
            WHEN 'event_city'         THEN 'ev.event_city'
            WHEN 'event_country_code' THEN 'ev.event_country_code'
            WHEN 'event_country'      THEN 'ev.event_country_code'
            WHEN 'event_title'        THEN 'ev.event_title'
            WHEN 'event_name'         THEN 'ev.event_title'
            WHEN 'event_id'           THEN 'ev.event_id'
            WHEN 'status'             THEN 'r.status'
            ELSE NULL END
        END;
        CONTINUE WHEN v_col IS NULL;
        IF v_col = 'r.status' THEN v_has_status_filter := true; END IF;
        v_filt := v_filt || CASE v_fop
          WHEN 'equals'       THEN format(' AND %s = %L', v_col, COALESCE(v_val, ''))
          WHEN 'not_equals'   THEN format(' AND %s IS DISTINCT FROM %L', v_col, COALESCE(v_val, ''))
          WHEN 'contains'     THEN format(' AND %s ILIKE %L', v_col, '%' || COALESCE(v_val, '') || '%')
          WHEN 'not_contains' THEN format(' AND (%s IS NULL OR %s NOT ILIKE %L)', v_col, v_col, '%' || COALESCE(v_val, '') || '%')
          WHEN 'starts_with'  THEN format(' AND %s ILIKE %L', v_col, COALESCE(v_val, '') || '%')
          WHEN 'is_set'       THEN format(' AND %s IS NOT NULL AND %s <> ''''', v_col, v_col)
          WHEN 'is_not_set'   THEN format(' AND (%s IS NULL OR %s = '''')', v_col, v_col)
          WHEN 'in_list'      THEN format(' AND %s = ANY (string_to_array(%L, '',''))', v_col, COALESCE(v_val, ''))
          WHEN 'not_in_list'  THEN format(' AND (%s IS NULL OR NOT (%s = ANY (string_to_array(%L, '','')))) ', v_col, v_col, COALESCE(v_val, ''))
          ELSE ''
        END;
      END LOOP;
    END IF;

    IF NOT v_has_status_filter THEN
      v_where := v_where || v_default;
    END IF;
    v_where := v_where || v_filt || v_time;

    -- Registrations/attendance only JOIN events when a filter needs it (keeps
    -- the simple case cheap, as in 007). The other sources join up front.
    IF v_kind IN ('registration', 'attendance') AND position('ev.' in v_filt) > 0 THEN
      v_src := v_src || ' JOIN public.events ev ON ev.id = r.event_id';
    END IF;

    CASE v_op
      WHEN 'performed'          THEN RETURN format('EXISTS (SELECT 1 FROM %s WHERE %s)', v_src, v_where);
      WHEN 'not_performed'      THEN RETURN format('NOT EXISTS (SELECT 1 FROM %s WHERE %s)', v_src, v_where);
      WHEN 'performed_at_least' THEN RETURN format('(SELECT count(*) FROM %s WHERE %s) >= %s', v_src, v_where, v_count);
      WHEN 'performed_at_most'  THEN RETURN format('(SELECT count(*) FROM %s WHERE %s) <= %s', v_src, v_where, v_count);
      WHEN 'performed_count'    THEN RETURN format('(SELECT count(*) FROM %s WHERE %s) = %s', v_src, v_where, v_count);
      ELSE RETURN 'true';
    END CASE;
  END IF;

  -- ---- Fallback: behavioural people_events stream (unchanged from 007) -----
  IF to_regclass('public.people_events') IS NULL THEN
    RETURN CASE WHEN v_op = 'not_performed' THEN 'true' ELSE 'false' END;
  END IF;

  v_where := format('e.person_id = p.id AND e.event_name = %L', v_name);
  IF v_tw IS NOT NULL AND COALESCE(v_tw->>'type', 'relative') = 'relative' THEN
    v_time := format(' AND e.occurred_at >= now() - ((%L || '' '' || %L)::interval)',
      COALESCE(NULLIF(v_tw->>'relative_value', '')::int, 30)::text,
      COALESCE(NULLIF(v_tw->>'relative_unit', ''), 'days'));
  ELSIF v_tw IS NOT NULL AND v_tw->>'type' = 'absolute' THEN
    IF v_tw ? 'start_date' THEN v_time := v_time || format(' AND e.occurred_at >= %L', v_tw->>'start_date'); END IF;
    IF v_tw ? 'end_date'   THEN v_time := v_time || format(' AND e.occurred_at <= %L', v_tw->>'end_date'); END IF;
  END IF;
  IF v_filters IS NOT NULL AND jsonb_typeof(v_filters) = 'array' THEN
    FOR v_f IN SELECT * FROM jsonb_array_elements(v_filters)
    LOOP
      v_prop := v_f->>'property';
      v_fop  := COALESCE(v_f->>'operator', 'equals');
      v_val  := v_f->>'value';
      CONTINUE WHEN v_prop IS NULL OR v_prop = '';
      v_col := format('(e.event_data->>%L)', v_prop);
      v_filt := v_filt || CASE v_fop
        WHEN 'equals'       THEN format(' AND %s = %L', v_col, COALESCE(v_val, ''))
        WHEN 'not_equals'   THEN format(' AND %s IS DISTINCT FROM %L', v_col, COALESCE(v_val, ''))
        WHEN 'contains'     THEN format(' AND %s ILIKE %L', v_col, '%' || COALESCE(v_val, '') || '%')
        WHEN 'not_contains' THEN format(' AND (%s IS NULL OR %s NOT ILIKE %L)', v_col, v_col, '%' || COALESCE(v_val, '') || '%')
        WHEN 'starts_with'  THEN format(' AND %s ILIKE %L', v_col, COALESCE(v_val, '') || '%')
        WHEN 'is_set'       THEN format(' AND %s IS NOT NULL AND %s <> ''''', v_col, v_col)
        WHEN 'is_not_set'   THEN format(' AND (%s IS NULL OR %s = '''')', v_col, v_col)
        WHEN 'in_list'      THEN format(' AND %s = ANY (string_to_array(%L, '',''))', v_col, COALESCE(v_val, ''))
        WHEN 'not_in_list'  THEN format(' AND (%s IS NULL OR NOT (%s = ANY (string_to_array(%L, '','')))) ', v_col, v_col, COALESCE(v_val, ''))
        ELSE ''
      END;
    END LOOP;
  END IF;
  v_where := v_where || v_filt;
  CASE v_op
    WHEN 'performed'          THEN RETURN format('EXISTS (SELECT 1 FROM public.people_events e WHERE %s%s)', v_where, v_time);
    WHEN 'not_performed'      THEN RETURN format('NOT EXISTS (SELECT 1 FROM public.people_events e WHERE %s%s)', v_where, v_time);
    WHEN 'performed_at_least' THEN RETURN format('(SELECT count(*) FROM public.people_events e WHERE %s%s) >= %s', v_where, v_time, v_count);
    WHEN 'performed_at_most'  THEN RETURN format('(SELECT count(*) FROM public.people_events e WHERE %s%s) <= %s', v_where, v_time, v_count);
    WHEN 'performed_count'    THEN RETURN format('(SELECT count(*) FROM public.people_events e WHERE %s%s) = %s', v_where, v_time, v_count);
    ELSE RETURN 'true';
  END CASE;
END;
$$;

-- List the source-backed event types in the builder's event picker whenever
-- their table is installed, alongside the names found in people_events.
CREATE OR REPLACE FUNCTION public.segments_event_names()
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_names text[] := '{}';
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF to_regclass('public.people_events') IS NOT NULL THEN
    EXECUTE $q$
      SELECT COALESCE(array_agg(DISTINCT event_name), '{}')
      FROM public.people_events
      WHERE event_name IS NOT NULL AND event_name <> ''
    $q$ INTO v_names;
  END IF;

  IF to_regclass('public.events_registrations') IS NOT NULL THEN v_names := v_names || 'event_registered'::text; END IF;
  IF to_regclass('public.events_attendance') IS NOT NULL THEN v_names := v_names || 'event_attended'::text; END IF;
  IF to_regclass('public.events_discount_claims') IS NOT NULL THEN v_names := v_names || 'discount_claimed'::text; END IF;
  IF to_regclass('public.events_competition_entries') IS NOT NULL THEN v_names := v_names || 'competition_entered'::text; END IF;
  IF to_regclass('public.integrations_offer_interactions') IS NOT NULL THEN
    v_names := v_names || ARRAY['offer_viewed', 'offer_accepted']::text[];
  END IF;

  RETURN ARRAY(SELECT DISTINCT n FROM unnest(v_names) AS n ORDER BY n);
END;
$$;

REVOKE ALL ON FUNCTION public.segments_event_names() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.segments_event_names() TO authenticated;
