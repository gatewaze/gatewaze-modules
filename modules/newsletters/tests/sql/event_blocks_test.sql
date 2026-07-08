-- Assertions for newsletter_local_events / newsletter_virtual_events (migration 066).
-- Self-contained: seeds events in a transaction and ROLLS BACK, so local data is
-- untouched. Run: docker exec -i aaif-supabase-db psql -U postgres -d postgres < this
BEGIN;

INSERT INTO public.events (event_id, event_title, event_start, publish_state,
                           event_city, event_country_code, event_region,
                           event_latitude, event_longitude)
VALUES
  -- New York metro (within 100km of 40.71,-74.01)
  ('t_nyc1', 'NYC Meetup A',   now() + interval '5 days',  'published', 'New York',    'US', 'na', 40.7128, -74.0060),
  ('t_nyc2', 'Jersey City B',  now() + interval '10 days', 'published', 'Jersey City', 'US', 'na', 40.7178, -74.0431),
  -- Boston (~300km from NYC → outside a 100km NYC radius, but its own radius hit)
  ('t_bos1', 'Boston C',       now() + interval '7 days',  'published', 'Boston',      'US', 'na', 42.3601, -71.0589),
  -- Berlin (city-tier fallback target)
  ('t_ber1', 'Berlin D',       now() + interval '3 days',  'published', 'Berlin',      'DE', 'eu', 52.5200,  13.4050),
  -- Virtual / online
  ('t_virt1','Virtual Summit', now() + interval '4 days',  'published', 'Online',      NULL, 'on', NULL, NULL),
  -- Past NYC event (excluded — event_start <= now)
  ('t_past1','NYC Past',       now() - interval '5 days',  'published', 'New York',    'US', 'na', 40.7130, -74.0059),
  -- Draft NYC event (excluded — not published)
  ('t_drf1', 'NYC Draft',      now() + interval '6 days',  'draft',     'New York',    'US', 'na', 40.7131, -74.0058);

DO $$
DECLARE
  v_ids text[];
  v_n   int;
BEGIN
  -- 1. Local (geo) around NYC: E1,E2 in radius, ordered by start; NOT Boston,
  --    virtual, past, or draft.
  SELECT array_agg(event_title ORDER BY event_start) INTO v_ids
    FROM public.newsletter_local_events(40.7128, -74.0060, 'New York', now(), 100, 3);
  IF v_ids IS DISTINCT FROM ARRAY['NYC Meetup A','Jersey City B'] THEN
    RAISE EXCEPTION 'NYC local geo tier wrong: %', v_ids;
  END IF;

  -- 2. Radius boundary: from Boston coords, only Boston is within 100km (NYC ~300km away).
  SELECT array_agg(event_title) INTO v_ids
    FROM public.newsletter_local_events(42.3601, -71.0589, 'Boston', now(), 100, 3);
  IF v_ids IS DISTINCT FROM ARRAY['Boston C'] THEN
    RAISE EXCEPTION 'Boston radius wrong (NYC should be outside 100km): %', v_ids;
  END IF;

  -- 3. City-tier fallback: no coords, city='Berlin' → Berlin only.
  SELECT array_agg(event_title) INTO v_ids
    FROM public.newsletter_local_events(NULL, NULL, 'Berlin', now(), 100, 3);
  IF v_ids IS DISTINCT FROM ARRAY['Berlin D'] THEN
    RAISE EXCEPTION 'Berlin city tier wrong: %', v_ids;
  END IF;

  -- 4. No match: unknown city, no coords → empty (block omitted).
  SELECT count(*) INTO v_n
    FROM public.newsletter_local_events(NULL, NULL, 'Nowheresville', now(), 100, 3);
  IF v_n <> 0 THEN RAISE EXCEPTION 'expected 0 for unknown location, got %', v_n; END IF;

  -- 5. p_limit respected.
  SELECT count(*) INTO v_n
    FROM public.newsletter_local_events(40.7128, -74.0060, 'New York', now(), 100, 1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'p_limit=1 not respected, got %', v_n; END IF;

  -- 6. Virtual events: only the online one, excludes in-person/past/draft.
  SELECT array_agg(event_title) INTO v_ids FROM public.newsletter_virtual_events(now(), 5);
  IF v_ids IS DISTINCT FROM ARRAY['Virtual Summit'] THEN
    RAISE EXCEPTION 'virtual events wrong: %', v_ids;
  END IF;

  -- 7. Local never includes the virtual event even at same coords-less city path.
  SELECT count(*) INTO v_n
    FROM public.newsletter_local_events(NULL, NULL, 'Online', now(), 100, 5);
  IF v_n <> 0 THEN RAISE EXCEPTION 'local tier leaked a virtual/Online event, got %', v_n; END IF;

  RAISE NOTICE 'ALL EVENT-BLOCK RPC ASSERTIONS PASSED';
END $$;

ROLLBACK;
