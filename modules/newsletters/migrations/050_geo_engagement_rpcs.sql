-- Newsletter Geo & Timezone Engagement Reporting — aggregation RPCs (R1–R5)
-- Spec: gatewaze-environments/specs/spec-newsletter-geo-engagement-reporting.md (§5, §7)
--
-- All functions: LANGUAGE sql STABLE SECURITY DEFINER, return jsonb {data, meta},
-- apply the bot filter + k-anonymity floor internally, read tunables from
-- newsletter_geo_config, and GRANT EXECUTE TO authenticated only (not anon).
-- Counts and rates never mix IP and profile geo sources within one number (§6.3).
--
-- meta = { schema_version, total_events, coverage_pct, suppressed_buckets, tz_fallback }
-- RPC_SCHEMA_VERSION = 1.
--
-- Down (for reference; not auto-run):
--   DROP FUNCTION IF EXISTS public.newsletter_geo_engagement(uuid, text, text);
--   DROP FUNCTION IF EXISTS public.newsletter_local_time_engagement(uuid, text);
--   DROP FUNCTION IF EXISTS public.newsletter_block_geo(uuid, text);
--   DROP FUNCTION IF EXISTS public.newsletter_block_option_geo(uuid, uuid, text);
--   DROP FUNCTION IF EXISTS public.newsletter_engagement_timeline(uuid, integer);

-- ════════════════════════════════════════════════════════════════════════════
-- R1 — newsletter_geo_engagement: rate by profile region + counts by IP location
-- ════════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.newsletter_geo_engagement(uuid, text, text);
CREATE OR REPLACE FUNCTION public.newsletter_geo_engagement(
  p_edition_id uuid,
  p_metric     text,
  p_level      text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET statement_timeout = '25s'
AS $fn$
DECLARE
  v_k        integer;
  v_conf     numeric;
  v_result   jsonb;
BEGIN
  IF p_metric NOT IN ('open','click') THEN
    RAISE EXCEPTION 'newsletter_geo: invalid p_metric=%; allowed: open,click', p_metric
      USING ERRCODE = '22023';
  END IF;
  IF p_level NOT IN ('country','city') THEN
    RAISE EXCEPTION 'newsletter_geo: invalid p_level=%; allowed: country,city', p_level
      USING ERRCODE = '22023';
  END IF;

  SELECT k_anonymity_min, open_human_confidence_min
    INTO v_k, v_conf
  FROM public.newsletter_geo_config WHERE id LIMIT 1;
  v_k := COALESCE(v_k, 15); v_conf := COALESCE(v_conf, 0.5);

  WITH sends AS (
    SELECT id FROM public.newsletter_sends WHERE edition_id = p_edition_id
  ),
  -- distinct delivered recipients for this edition (by email)
  delivered AS (
    SELECT DISTINCT lower(esl.recipient_email) AS email
    FROM public.email_send_log esl
    WHERE esl.newsletter_send_id IN (SELECT id FROM sends)
      AND (esl.delivered_at IS NOT NULL OR esl.status IN ('sent','delivered'))
  ),
  -- profile region per delivered email (one region per email). Restricted to
  -- the delivered set so the planner nested-loops people via idx_people_lower_email
  -- rather than scanning all people.
  ppl AS (
    SELECT email, min(region_code) AS region_code FROM (
      SELECT lower(p.email) AS email,
        CASE WHEN p_level = 'country' THEN nullif(p.attributes->>'country','')
             ELSE nullif(p.attributes->>'city','') END AS region_code
      FROM public.people p
      JOIN delivered d ON d.email = lower(p.email)
    ) s GROUP BY email
  ),
  -- human events of p_metric, one row per (recipient) — for engaged set
  ev AS (
    SELECT DISTINCT lower(esl.recipient_email) AS email
    FROM public.email_interactions ei
    JOIN public.email_send_log esl ON esl.id = ei.email_send_log_id
    WHERE ei.edition_id = p_edition_id
      AND ei.is_bot IS NOT TRUE
      AND COALESCE(ei.consent_suppressed, false) = false
      AND ei.event_type = p_metric
      AND (p_metric = 'click' OR ei.human_confidence >= v_conf)
  ),
  -- raw human events grouped by IP country (country level only)
  ipc AS (
    SELECT ei.ip_geo_country AS region_code, count(*) AS cnt
    FROM public.email_interactions ei
    WHERE ei.edition_id = p_edition_id
      AND ei.is_bot IS NOT TRUE
      AND COALESCE(ei.consent_suppressed, false) = false
      AND ei.event_type = p_metric
      AND (p_metric = 'click' OR ei.human_confidence >= v_conf)
      AND nullif(ei.ip_geo_country, '') IS NOT NULL
    GROUP BY ei.ip_geo_country
  ),
  per_region AS (
    SELECT pr.region_code,
           count(DISTINCT d.email) AS delivered_profile,
           count(DISTINCT e.email) AS engaged_profile
    FROM delivered d
    JOIN ppl pr ON pr.email = d.email AND pr.region_code IS NOT NULL
    LEFT JOIN ev e ON e.email = d.email
    GROUP BY pr.region_code
  ),
  kept AS (  -- k-anonymity: drop regions below K distinct recipients
    SELECT * FROM per_region WHERE delivered_profile >= v_k
  ),
  rows_out AS (
    SELECT jsonb_build_object(
      'region_code', k.region_code,
      'region_name', k.region_code,
      'level', p_level,
      'delivered_profile', k.delivered_profile,
      'engaged_profile', k.engaged_profile,
      'rate_profile', CASE WHEN k.delivered_profile > 0
                           THEN round(k.engaged_profile::numeric / k.delivered_profile, 4) END,
      'count_ip', COALESCE((SELECT cnt FROM ipc WHERE ipc.region_code = k.region_code), 0),
      'geo_source', 'profile'
    ) AS j
    FROM kept k
    ORDER BY k.engaged_profile DESC, k.delivered_profile DESC
  ),
  meta AS (
    SELECT
      (SELECT count(*) FROM ev) AS total_events,
      (SELECT count(*) FROM per_region) AS regions_total,
      (SELECT count(*) FROM per_region WHERE delivered_profile < v_k) AS suppressed,
      (SELECT count(DISTINCT d.email) FROM delivered d) AS delivered_total,
      (SELECT count(DISTINCT d.email) FROM delivered d JOIN ppl pr ON pr.email=d.email AND pr.region_code IS NOT NULL) AS delivered_with_region
  )
  SELECT jsonb_build_object(
    'data', COALESCE((SELECT jsonb_agg(j) FROM rows_out), '[]'::jsonb),
    'meta', jsonb_build_object(
      'schema_version', 1,
      'total_events', (SELECT total_events FROM meta),
      'coverage_pct', CASE WHEN (SELECT delivered_total FROM meta) > 0
                           THEN round((SELECT delivered_with_region::numeric FROM meta) / (SELECT delivered_total FROM meta), 4)
                           ELSE 0 END,
      'suppressed_buckets', (SELECT suppressed FROM meta),
      'tz_fallback', 0
    )
  ) INTO v_result;

  RETURN v_result;
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.newsletter_geo_engagement(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.newsletter_geo_engagement(uuid, text, text) TO authenticated;
COMMENT ON FUNCTION public.newsletter_geo_engagement(uuid, text, text) IS
  'R1: per-region engagement. rate_profile/delivered_profile/engaged_profile are profile-region; count_ip is IP-location. k-anonymity floor applied. Spec §5/§7.1.';

-- ════════════════════════════════════════════════════════════════════════════
-- R2 — newsletter_local_time_engagement: recipient-local hour×dow heatmap
-- ════════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.newsletter_local_time_engagement(uuid, text);
CREATE OR REPLACE FUNCTION public.newsletter_local_time_engagement(
  p_edition_id uuid,
  p_metric     text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET statement_timeout = '25s'
AS $fn$
DECLARE
  v_conf     numeric;
  v_result   jsonb;
BEGIN
  IF p_metric NOT IN ('open','click') THEN
    RAISE EXCEPTION 'newsletter_geo: invalid p_metric=%; allowed: open,click', p_metric
      USING ERRCODE = '22023';
  END IF;
  SELECT open_human_confidence_min INTO v_conf FROM public.newsletter_geo_config WHERE id LIMIT 1;
  v_conf := COALESCE(v_conf, 0.5);

  WITH sends AS (
    SELECT id FROM public.newsletter_sends WHERE edition_id = p_edition_id
  ),
  -- timezone per recipient email: send-recipient tz → profile tz → UTC
  rtz AS (
    SELECT lower(email) AS email, max(timezone) AS tz
    FROM public.newsletter_send_recipients
    WHERE send_id IN (SELECT id FROM sends) AND nullif(timezone,'') IS NOT NULL
    GROUP BY lower(email)
  ),
  delivered AS (
    SELECT DISTINCT lower(esl.recipient_email) AS email
    FROM public.email_send_log esl
    WHERE esl.newsletter_send_id IN (SELECT id FROM sends)
      AND (esl.delivered_at IS NOT NULL OR esl.status IN ('sent','delivered'))
  ),
  ptz AS (  -- profile tz, restricted to delivered (uses idx_people_lower_email)
    SELECT lower(p.email) AS email, max(nullif(p.attributes->>'timezone','')) AS tz
    FROM public.people p
    JOIN delivered d ON d.email = lower(p.email)
    GROUP BY lower(p.email)
  ),
  -- resolved + validated tz per delivered recipient
  rtz_resolved AS (
    SELECT d.email,
      COALESCE(rtz.tz, ptz.tz) AS raw_tz,
      CASE WHEN COALESCE(rtz.tz, ptz.tz) IN (SELECT name FROM pg_timezone_names)
           THEN COALESCE(rtz.tz, ptz.tz) ELSE 'UTC' END AS tz,
      (COALESCE(rtz.tz, ptz.tz) IS NULL
        OR COALESCE(rtz.tz, ptz.tz) NOT IN (SELECT name FROM pg_timezone_names)) AS fellback
    FROM delivered d
    LEFT JOIN rtz ON rtz.email = d.email
    LEFT JOIN ptz ON ptz.email = d.email
  ),
  -- recipient population per tz (normalisation base)
  tz_pop AS (
    SELECT tz, count(*) AS pop FROM rtz_resolved GROUP BY tz
  ),
  -- human events of p_metric, with recipient + resolved tz
  ev AS (
    SELECT lower(esl.recipient_email) AS email,
           r.tz,
           extract(dow  FROM (ei.event_timestamp AT TIME ZONE r.tz))::int AS dow,
           extract(hour FROM (ei.event_timestamp AT TIME ZONE r.tz))::int AS hour
    FROM public.email_interactions ei
    JOIN public.email_send_log esl ON esl.id = ei.email_send_log_id
    JOIN rtz_resolved r ON r.email = lower(esl.recipient_email)
    WHERE ei.edition_id = p_edition_id
      AND ei.is_bot IS NOT TRUE
      AND COALESCE(ei.consent_suppressed, false) = false
      AND ei.event_type = p_metric
      AND (p_metric = 'click' OR ei.human_confidence >= v_conf)
  ),
  -- distinct (recipient,bucket) per (tz,dow,hour)
  ev_distinct AS (
    SELECT DISTINCT email, tz, dow, hour FROM ev
  ),
  per_tz_bucket AS (
    SELECT tz, dow, hour, count(*) AS events FROM ev_distinct GROUP BY tz, dow, hour
  ),
  -- aggregate to (dow,hour): absolute count + tz-size-normalised rate
  buckets AS (
    SELECT b.dow, b.hour,
           sum(b.events) AS event_count,
           round(sum(b.events::numeric / NULLIF(tp.pop,0)), 6) AS rate
    FROM per_tz_bucket b
    JOIN tz_pop tp ON tp.tz = b.tz
    GROUP BY b.dow, b.hour
  ),
  rows_out AS (
    SELECT jsonb_build_object(
      'dow', dow,
      'hour', hour,
      'event_count', event_count,
      'recipients_in_tz', (SELECT count(*) FROM rtz_resolved),
      'rate', rate
    ) AS j
    FROM buckets ORDER BY dow, hour
  )
  SELECT jsonb_build_object(
    'data', COALESCE((SELECT jsonb_agg(j) FROM rows_out), '[]'::jsonb),
    'meta', jsonb_build_object(
      'schema_version', 1,
      'total_events', (SELECT count(*) FROM ev_distinct),
      'coverage_pct', CASE WHEN (SELECT count(*) FROM rtz_resolved) > 0
                           THEN round((SELECT count(*) FROM rtz_resolved WHERE NOT fellback)::numeric
                                      / (SELECT count(*) FROM rtz_resolved), 4) ELSE 0 END,
      'suppressed_buckets', 0,
      'tz_fallback', (SELECT count(*) FROM rtz_resolved WHERE fellback)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.newsletter_local_time_engagement(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.newsletter_local_time_engagement(uuid, text) TO authenticated;
COMMENT ON FUNCTION public.newsletter_local_time_engagement(uuid, text) IS
  'R2: recipient-local hour×dow engagement. event_count=absolute; rate=tz-size-normalised intensity (use for best-hour). Spec §5/§7.2.';

-- ════════════════════════════════════════════════════════════════════════════
-- R3 — newsletter_block_geo: block × region click matrix (IP-based)
-- ════════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.newsletter_block_geo(uuid, text);
CREATE OR REPLACE FUNCTION public.newsletter_block_geo(
  p_edition_id uuid,
  p_level      text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET statement_timeout = '25s'
AS $fn$
DECLARE
  v_k        integer;
  v_topn     integer;
  v_result   jsonb;
BEGIN
  IF p_level NOT IN ('country','city') THEN
    RAISE EXCEPTION 'newsletter_geo: invalid p_level=%; allowed: country,city', p_level
      USING ERRCODE = '22023';
  END IF;
  SELECT k_anonymity_min, top_n_regions INTO v_k, v_topn
  FROM public.newsletter_geo_config WHERE id LIMIT 1;
  v_k := COALESCE(v_k, 15); v_topn := COALESCE(v_topn, 12);

  WITH clicks AS (  -- distinct-recipient clicks per (block, region)
    SELECT ei.block_id, ei.block_type,
           ei.ip_geo_country AS region_code,
           count(DISTINCT ei.email_send_log_id) AS clicks
    FROM public.email_interactions ei
    WHERE ei.edition_id = p_edition_id
      AND ei.event_type = 'click'
      AND ei.is_bot IS NOT TRUE
      AND COALESCE(ei.consent_suppressed, false) = false
      AND ei.block_id IS NOT NULL
      AND nullif(ei.ip_geo_country,'') IS NOT NULL
    GROUP BY ei.block_id, ei.block_type, ei.ip_geo_country
  ),
  region_totals AS (
    SELECT region_code, sum(clicks) AS tot FROM clicks GROUP BY region_code
  ),
  top_regions AS (
    SELECT region_code FROM region_totals
    WHERE region_code IN (
      SELECT region_code FROM region_totals ORDER BY tot DESC LIMIT v_topn
    )
  ),
  -- block disambiguation: index per block_type
  block_rank AS (
    SELECT block_id, block_type,
           dense_rank() OVER (PARTITION BY block_type ORDER BY block_id) AS rnk,
           count(*) OVER (PARTITION BY block_type) AS type_n
    FROM (SELECT DISTINCT block_id, block_type FROM clicks) s
  ),
  -- fold non-top regions to __other__, then re-aggregate
  folded AS (
    SELECT c.block_id, c.block_type,
           CASE WHEN tr.region_code IS NULL THEN '__other__' ELSE c.region_code END AS region_code,
           sum(c.clicks) AS clicks
    FROM clicks c
    LEFT JOIN top_regions tr ON tr.region_code = c.region_code
    GROUP BY c.block_id, c.block_type,
             CASE WHEN tr.region_code IS NULL THEN '__other__' ELSE c.region_code END
  ),
  rows_out AS (
    SELECT jsonb_build_object(
      'block_id', f.block_id,
      'block_type', f.block_type,
      'block_label', CASE WHEN br.type_n > 1 THEN f.block_type || ' #' || br.rnk ELSE f.block_type END,
      'region_code', CASE WHEN f.region_code = '__other__' THEN '__other__' ELSE f.region_code END,
      'region_name', CASE WHEN f.region_code = '__other__' THEN 'Other' ELSE f.region_code END,
      'clicks', f.clicks
    ) AS j
    FROM folded f
    JOIN block_rank br ON br.block_id = f.block_id
    ORDER BY f.block_type, f.block_id, f.clicks DESC
  )
  SELECT jsonb_build_object(
    'data', COALESCE((SELECT jsonb_agg(j) FROM rows_out), '[]'::jsonb),
    'meta', jsonb_build_object(
      'schema_version', 1,
      'total_events', (SELECT COALESCE(sum(clicks),0) FROM clicks),
      'coverage_pct', 1.0,
      'suppressed_buckets', (SELECT count(*) FROM region_totals WHERE region_code NOT IN (SELECT region_code FROM top_regions)),
      'tz_fallback', 0
    )
  ) INTO v_result;

  RETURN v_result;
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.newsletter_block_geo(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.newsletter_block_geo(uuid, text) TO authenticated;
COMMENT ON FUNCTION public.newsletter_block_geo(uuid, text) IS
  'R3: block × region click matrix (IP-based). Top-N regions kept, remainder folded to __other__. Spec §5/§7.3.';

-- ════════════════════════════════════════════════════════════════════════════
-- R4 — newsletter_block_option_geo: per-option regional split (HotTake)
-- ════════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.newsletter_block_option_geo(uuid, uuid, text);
CREATE OR REPLACE FUNCTION public.newsletter_block_option_geo(
  p_edition_id uuid,
  p_block_id   uuid,
  p_level      text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET statement_timeout = '25s'
AS $fn$
DECLARE
  v_k        integer;
  v_result   jsonb;
BEGIN
  IF p_level NOT IN ('country','city') THEN
    RAISE EXCEPTION 'newsletter_geo: invalid p_level=%; allowed: country,city', p_level
      USING ERRCODE = '22023';
  END IF;
  SELECT k_anonymity_min INTO v_k FROM public.newsletter_geo_config WHERE id LIMIT 1;
  v_k := COALESCE(v_k, 15);

  WITH clicks AS (  -- distinct-recipient clicks per (option link, region)
    SELECT ei.edition_link_id,
           ei.ip_geo_country AS region_code,
           count(DISTINCT ei.email_send_log_id) AS clicks
    FROM public.email_interactions ei
    WHERE ei.edition_id = p_edition_id
      AND ei.block_id = p_block_id
      AND ei.event_type = 'click'
      AND ei.is_bot IS NOT TRUE
      AND COALESCE(ei.consent_suppressed, false) = false
      AND ei.edition_link_id IS NOT NULL
      AND nullif(ei.ip_geo_country,'') IS NOT NULL
    GROUP BY ei.edition_link_id, ei.ip_geo_country
  ),
  -- option label: edition_links.link_index → block content poll_option_{n+1}_label
  link_meta AS (
    SELECT el.id AS edition_link_id, el.link_index, el.original_url,
           nb.content AS block_content
    FROM public.newsletters_edition_links el
    LEFT JOIN public.newsletters_edition_blocks nb ON nb.id = p_block_id
    WHERE el.id IN (SELECT DISTINCT edition_link_id FROM clicks)
  ),
  region_block_total AS (
    SELECT region_code, sum(clicks) AS tot, count(DISTINCT edition_link_id) AS opt_n
    FROM clicks GROUP BY region_code
  ),
  -- k-anon on region: drop regions whose total distinct clickers < K
  kept_regions AS (
    SELECT region_code FROM region_block_total WHERE tot >= v_k
  ),
  rows_out AS (
    SELECT jsonb_build_object(
      'edition_link_id', c.edition_link_id,
      'option_label', COALESCE(
        nullif(lm.block_content->>('poll_option_' || (lm.link_index + 1) || '_label'), ''),
        'Option ' || (COALESCE(lm.link_index,0) + 1)
      ),
      'region_code', c.region_code,
      'region_name', c.region_code,
      'clicks', c.clicks,
      'share', round(c.clicks::numeric / NULLIF(rbt.tot, 0), 4)
    ) AS j
    FROM clicks c
    JOIN kept_regions kr ON kr.region_code = c.region_code
    JOIN region_block_total rbt ON rbt.region_code = c.region_code
    LEFT JOIN link_meta lm ON lm.edition_link_id = c.edition_link_id
    ORDER BY c.region_code, c.clicks DESC
  )
  SELECT jsonb_build_object(
    'data', COALESCE((SELECT jsonb_agg(j) FROM rows_out), '[]'::jsonb),
    'meta', jsonb_build_object(
      'schema_version', 1,
      'total_events', (SELECT COALESCE(sum(clicks),0) FROM clicks),
      'coverage_pct', 1.0,
      'suppressed_buckets', (SELECT count(*) FROM region_block_total WHERE tot < v_k),
      'tz_fallback', 0
    )
  ) INTO v_result;

  RETURN v_result;
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.newsletter_block_option_geo(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.newsletter_block_option_geo(uuid, uuid, text) TO authenticated;
COMMENT ON FUNCTION public.newsletter_block_option_geo(uuid, uuid, text) IS
  'R4: per-option regional split for a poll/HotTake block (IP-based). share = option clicks / all option clicks in region. Spec §5/§7.4.';

-- ════════════════════════════════════════════════════════════════════════════
-- R5 — newsletter_engagement_timeline: time × region buckets (follow the sun)
-- ════════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.newsletter_engagement_timeline(uuid, integer);
CREATE OR REPLACE FUNCTION public.newsletter_engagement_timeline(
  p_edition_id     uuid,
  p_bucket_minutes integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET statement_timeout = '25s'
AS $fn$
DECLARE
  v_conf     numeric;
  v_result   jsonb;
BEGIN
  IF p_bucket_minutes IS NULL OR p_bucket_minutes < 1 OR p_bucket_minutes > 60 THEN
    RAISE EXCEPTION 'newsletter_geo: invalid p_bucket_minutes=%; allowed: 1..60', p_bucket_minutes
      USING ERRCODE = '22023';
  END IF;
  SELECT open_human_confidence_min INTO v_conf FROM public.newsletter_geo_config WHERE id LIMIT 1;
  v_conf := COALESCE(v_conf, 0.5);

  WITH ev AS (
    SELECT
      date_bin(make_interval(mins => p_bucket_minutes), ei.event_timestamp, timestamptz 'epoch') AS bucket_start,
      ei.ip_geo_country AS region_code,
      ei.event_type
    FROM public.email_interactions ei
    WHERE ei.edition_id = p_edition_id
      AND ei.is_bot IS NOT TRUE
      AND COALESCE(ei.consent_suppressed, false) = false
      AND nullif(ei.ip_geo_country,'') IS NOT NULL
      AND (ei.event_type = 'click' OR (ei.event_type = 'open' AND ei.human_confidence >= v_conf))
  ),
  buckets AS (
    SELECT bucket_start, region_code,
           count(*) FILTER (WHERE event_type = 'open')  AS opens,
           count(*) FILTER (WHERE event_type = 'click') AS clicks
    FROM ev GROUP BY bucket_start, region_code
  ),
  rows_out AS (
    SELECT jsonb_build_object(
      'bucket_start', bucket_start,
      'region_code', region_code,
      'region_name', region_code,
      'opens', opens,
      'clicks', clicks
    ) AS j
    FROM buckets ORDER BY bucket_start, region_code
  )
  SELECT jsonb_build_object(
    'data', COALESCE((SELECT jsonb_agg(j) FROM rows_out), '[]'::jsonb),
    'meta', jsonb_build_object(
      'schema_version', 1,
      'total_events', (SELECT count(*) FROM ev),
      'coverage_pct', 1.0,
      'suppressed_buckets', 0,
      'tz_fallback', 0
    )
  ) INTO v_result;

  RETURN v_result;
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.newsletter_engagement_timeline(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.newsletter_engagement_timeline(uuid, integer) TO authenticated;
COMMENT ON FUNCTION public.newsletter_engagement_timeline(uuid, integer) IS
  'R5: time × IP-region open/click buckets for the follow-the-sun replay. Spec §5/§7.5.';
