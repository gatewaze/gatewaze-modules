-- Assertion harness for the geo-engagement RPCs against the seeded fixture.
-- Run after geo_engagement_fixture.sql. Each check RAISEs on failure; the final
-- NOTICE 'ALL GEO RPC CHECKS PASSED' only prints if every assertion held.
\set ON_ERROR_STOP on

DO $checks$
DECLARE
  ed   uuid := 'a51a0000-0000-0000-0000-000000000001';
  b1   uuid := 'a51a0000-0000-0000-0000-0000000000b1';
  j    jsonb;
  d    jsonb;
  m    jsonb;
  n    numeric;
BEGIN
  -- ── R1 geo_engagement (click, country) ────────────────────────────────
  j := public.newsletter_geo_engagement(ed, 'click', 'country');
  d := j->'data'; m := j->'meta';
  -- NZ (delivered 6 < K=15) must be suppressed
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(d) e WHERE e->>'region_code'='NZ') THEN
    RAISE EXCEPTION 'R1: NZ should be suppressed (sub-K)';
  END IF;
  -- US present, rate 30/60 = 0.5, count_ip (raw) = 30 hot_take + floor(30/3)=10 generic + floor(30/5)=6 podcast = 46
  SELECT e INTO d FROM jsonb_array_elements(j->'data') e WHERE e->>'region_code'='US';
  IF d IS NULL THEN RAISE EXCEPTION 'R1: US missing'; END IF;
  IF (d->>'delivered_profile')::int <> 60 THEN RAISE EXCEPTION 'R1 US delivered=% want 60', d->>'delivered_profile'; END IF;
  IF (d->>'engaged_profile')::int <> 30  THEN RAISE EXCEPTION 'R1 US engaged=% want 30', d->>'engaged_profile'; END IF;
  IF (d->>'rate_profile')::numeric <> 0.5 THEN RAISE EXCEPTION 'R1 US rate=% want 0.5', d->>'rate_profile'; END IF;
  IF (d->>'count_ip')::int <> 46 THEN RAISE EXCEPTION 'R1 US count_ip=% want 46', d->>'count_ip'; END IF;
  IF (m->>'suppressed_buckets')::int <> 1 THEN RAISE EXCEPTION 'R1 suppressed=% want 1', m->>'suppressed_buckets'; END IF;
  IF (m->>'schema_version')::int <> 1 THEN RAISE EXCEPTION 'R1 schema_version wrong'; END IF;
  -- total_events = distinct clicking recipients = 30+20+16+9+7+4+6 = 92
  IF (m->>'total_events')::int <> 92 THEN RAISE EXCEPTION 'R1 total_events=% want 92', m->>'total_events'; END IF;

  -- invalid metric raises 22023
  BEGIN
    PERFORM public.newsletter_geo_engagement(ed, 'bogus', 'country');
    RAISE EXCEPTION 'R1: invalid metric should have raised';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  -- ── R2 local_time_engagement (click) ──────────────────────────────────
  j := public.newsletter_local_time_engagement(ed, 'click');
  m := j->'meta';
  -- ZZ has invalid tz 'Not/AZone' → 16 recipients fall back to UTC
  IF (m->>'tz_fallback')::int <> 16 THEN RAISE EXCEPTION 'R2 tz_fallback=% want 16', m->>'tz_fallback'; END IF;
  -- buckets exist and rate present
  IF jsonb_array_length(j->'data') = 0 THEN RAISE EXCEPTION 'R2: no buckets'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'data') e WHERE (e->>'rate') IS NOT NULL) THEN
    RAISE EXCEPTION 'R2: no normalised rate';
  END IF;

  -- ── R3 block_geo (country) ────────────────────────────────────────────
  j := public.newsletter_block_geo(ed, 'country');
  -- three block types present
  IF (SELECT count(DISTINCT e->>'block_type') FROM jsonb_array_elements(j->'data') e) <> 3 THEN
    RAISE EXCEPTION 'R3: expected 3 block types';
  END IF;
  -- hot_take US clicks (distinct recipients) = 30
  SELECT e INTO d FROM jsonb_array_elements(j->'data') e
   WHERE e->>'block_type'='hot_take' AND e->>'region_code'='US';
  IF (d->>'clicks')::int <> 30 THEN RAISE EXCEPTION 'R3 hot_take US clicks=% want 30', d->>'clicks'; END IF;

  -- ── R4 block_option_geo (hot_take, country) ───────────────────────────
  j := public.newsletter_block_option_geo(ed, b1, 'country');
  d := j->'data'; m := j->'meta';
  -- DE/AU/NZ/ZZ suppressed (clickers < 15); US/GB/IN kept → suppressed_buckets = 4
  IF (m->>'suppressed_buckets')::int <> 4 THEN RAISE EXCEPTION 'R4 suppressed=% want 4', m->>'suppressed_buckets'; END IF;
  -- US option split: opt1 = round(30*0.7)=21, opt2=9; share opt1 = 21/30 = 0.7
  SELECT (e->>'share')::numeric INTO n FROM jsonb_array_elements(d) e
   WHERE e->>'region_code'='US' AND e->>'option_label'='Agree';
  IF n IS NULL THEN RAISE EXCEPTION 'R4: US Agree option missing (label derivation failed)'; END IF;
  IF n <> 0.7 THEN RAISE EXCEPTION 'R4 US Agree share=% want 0.7', n; END IF;
  -- option labels resolved from block content (not "Option N")
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d) e WHERE e->>'option_label'='Disagree') THEN
    RAISE EXCEPTION 'R4: Disagree label not derived';
  END IF;

  -- ── R5 engagement_timeline ────────────────────────────────────────────
  j := public.newsletter_engagement_timeline(ed, 30);
  IF jsonb_array_length(j->'data') = 0 THEN RAISE EXCEPTION 'R5: no timeline buckets'; END IF;
  IF (j->'meta'->>'total_events')::int <> 275 THEN  -- 137 human clicks + 138 human opens
    RAISE EXCEPTION 'R5 total_events=% want 275', j->'meta'->>'total_events';
  END IF;
  -- invalid bucket raises
  BEGIN
    PERFORM public.newsletter_engagement_timeline(ed, 0);
    RAISE EXCEPTION 'R5: invalid bucket should have raised';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  -- ── security: anon denied, authenticated allowed (every RPC) ──────────
  IF has_function_privilege('anon','public.newsletter_geo_engagement(uuid,text,text)','EXECUTE')
     OR has_function_privilege('anon','public.newsletter_local_time_engagement(uuid,text)','EXECUTE')
     OR has_function_privilege('anon','public.newsletter_block_geo(uuid,text)','EXECUTE')
     OR has_function_privilege('anon','public.newsletter_block_option_geo(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('anon','public.newsletter_engagement_timeline(uuid,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'SECURITY: anon must not execute geo RPCs';
  END IF;
  IF NOT has_function_privilege('authenticated','public.newsletter_geo_engagement(uuid,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'SECURITY: authenticated should execute geo RPCs';
  END IF;

  -- ── config matches the opens partial-index predicate (spec §16) ───────
  SELECT open_human_confidence_min INTO n FROM public.newsletter_geo_config WHERE id;
  IF n <> 0.5 THEN
    RAISE EXCEPTION 'CONFIG: open_human_confidence_min=% must equal opens index literal 0.5', n;
  END IF;

  -- ── coverage_pct sane (0..1) ──────────────────────────────────────────
  j := public.newsletter_geo_engagement(ed, 'click', 'country');
  n := (j->'meta'->>'coverage_pct')::numeric;
  IF n < 0 OR n > 1 THEN RAISE EXCEPTION 'coverage_pct out of range: %', n; END IF;

  -- ── block effectiveness (cross-edition) over the fixture edition ──────
  j := public.newsletter_block_effectiveness(ARRAY[ed]);
  d := j->'data';
  -- three block types with clicks: hot_take, generic, podcast
  IF (SELECT count(DISTINCT e->>'block_type') FROM jsonb_array_elements(d) e) <> 3 THEN
    RAISE EXCEPTION 'block_effectiveness: expected 3 block types, got %',
      (SELECT count(DISTINCT e->>'block_type') FROM jsonb_array_elements(d) e);
  END IF;
  -- every clicker clicked the hot_take → 92 distinct clickers
  SELECT (e->>'clickers')::int INTO n FROM jsonb_array_elements(d) e WHERE e->>'block_type'='hot_take';
  IF n <> 92 THEN RAISE EXCEPTION 'block_effectiveness hot_take clickers=% want 92', n; END IF;
  -- anon denied
  IF has_function_privilege('anon','public.newsletter_block_effectiveness(uuid[])','EXECUTE') THEN
    RAISE EXCEPTION 'SECURITY: anon must not execute newsletter_block_effectiveness';
  END IF;

  -- ── send-log fallback (imported edition a51a…0002, no interactions) ────
  DECLARE ed2 uuid := 'a51a0000-0000-0000-0000-000000000002';
  BEGIN
    j := public.newsletter_geo_engagement(ed2, 'open', 'country');
    d := j->'data'; m := j->'meta';
    -- engagement comes from email_send_log.first_opened_at (no email_interactions)
    IF (m->>'total_events')::int <> 45 THEN  -- 30 US + 12 GB + 3 NZ (pre-suppression)
      RAISE EXCEPTION 'send-log R1 total_events=% want 45', m->>'total_events';
    END IF;
    SELECT e INTO d FROM jsonb_array_elements(j->'data') e WHERE e->>'region_code'='US';
    IF d IS NULL OR (d->>'engaged_profile')::int <> 30 OR (d->>'delivered_profile')::int <> 40 THEN
      RAISE EXCEPTION 'send-log R1 US engaged/delivered wrong: %', d;
    END IF;
    -- NZ (6 delivered < K) suppressed
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'data') e WHERE e->>'region_code'='NZ') THEN
      RAISE EXCEPTION 'send-log R1: NZ should be suppressed';
    END IF;
    -- R2 also derives from send-log timestamps
    IF (public.newsletter_local_time_engagement(ed2,'open')->'meta'->>'total_events')::int = 0 THEN
      RAISE EXCEPTION 'send-log R2: expected local-time buckets from send-log';
    END IF;
  END;

  RAISE NOTICE 'ALL GEO RPC CHECKS PASSED';
END;
$checks$;
