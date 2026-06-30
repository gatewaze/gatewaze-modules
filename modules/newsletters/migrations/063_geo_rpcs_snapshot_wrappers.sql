-- ============================================================================
-- Module: newsletters
-- Migration: 063_geo_rpcs_snapshot_wrappers
-- Description: Extend the migration-061 snapshot cache to the remaining
-- per-edition stats RPCs (geo R1/R2/R3/R5 + poll_results). Same shape as
-- engagement + block_effectiveness wrappers: rename existing fn to *_live,
-- replace the public name with a snapshot-aware wrapper.
--
-- Differences from 061's wrappers:
--   - These RPCs take additional params (metric, level, bucket_minutes), so
--     the snapshot row's `params_key` is a canonical encoding of those args
--     ("metric=open;level=country", "bucket_minutes=5", etc.). Different
--     param combos cache independently.
--   - These wrappers are VOLATILE (vs the 061 ones which are STABLE), so
--     they can lazily upsert a snapshot the first time a stable edition is
--     read. The 061 wrappers couldn't write because they're called from a
--     UNION ALL across multiple editions; here each call resolves to one
--     edition, so an inline upsert is the right shape.
--   - Refresh fn (newsletter_refresh_edition_snapshots) is updated to ALSO
--     populate the common geo param combos so the cron worker pre-warms
--     them for old editions.
--
-- Skipped: newsletter_block_option_geo. It varies per block_id; admin loads
-- it only when a user expands a specific poll. Caching every (edition x
-- block_id x level) combo isn't worth the disk for the access pattern.
-- ============================================================================

-- 1. Rename existing geo RPCs to *_live -------------------------------------

ALTER FUNCTION public.newsletter_geo_engagement(uuid, text, text)
  RENAME TO newsletter_geo_engagement_live;
ALTER FUNCTION public.newsletter_local_time_engagement(uuid, text)
  RENAME TO newsletter_local_time_engagement_live;
ALTER FUNCTION public.newsletter_block_geo(uuid, text)
  RENAME TO newsletter_block_geo_live;
ALTER FUNCTION public.newsletter_engagement_timeline(uuid, integer)
  RENAME TO newsletter_engagement_timeline_live;

-- newsletter_poll_results was overwritten in migration 062 (CREATE OR
-- REPLACE) so we just CREATE OR REPLACE again below; preserve _live as the
-- original 062 body, exposed under a new name.

CREATE OR REPLACE FUNCTION public.newsletter_poll_results_live(p_edition_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET statement_timeout = '25s'
AS $fn$
DECLARE
  v_result jsonb;
BEGIN
  WITH eds AS (
    SELECT e.id AS edition_id, e.edition_date, e.title
    FROM public.newsletters_editions e WHERE e.id = ANY(p_edition_ids)
  ),
  poll_blocks AS (
    SELECT b.id AS block_id, b.edition_id, b.block_type, b.content
    FROM public.newsletters_edition_blocks b
    WHERE b.edition_id = ANY(p_edition_ids)
      AND b.block_type IN ('hot_take','poll','vote','survey')
  ),
  opt_links AS (
    SELECT el.id AS edition_link_id, el.block_id,
      COALESCE(
        NULLIF((regexp_match(el.original_url, 'option-(\d+)'))[1], '')::int,
        NULLIF((regexp_match(el.field,        'poll_option_(\d+)'))[1], '')::int
      ) AS opt_n
    FROM public.newsletters_edition_links el
    JOIN poll_blocks pb ON pb.block_id = el.block_id
    WHERE el.original_url ~ 'option-\d+'
       OR el.field       ~ 'poll_option_\d+'
  ),
  clk AS (
    SELECT ol.block_id, ol.opt_n, count(DISTINCT ei.email_send_log_id) AS clicks
    FROM public.email_interactions ei
    JOIN opt_links ol ON ol.edition_link_id = ei.edition_link_id
    WHERE ei.edition_id = ANY(p_edition_ids)
      AND ei.event_type = 'click'
      AND ei.is_bot IS NOT TRUE
      AND COALESCE(ei.consent_suppressed, false) = false
      AND ol.opt_n IS NOT NULL
    GROUP BY ol.block_id, ol.opt_n
  ),
  rows_out AS (
    SELECT jsonb_build_object(
      'edition_id', pb.edition_id,
      'edition_date', e.edition_date,
      'edition_title', e.title,
      'block_id', pb.block_id,
      'block_type', pb.block_type,
      'option_index', clk.opt_n,
      'option_label', COALESCE(
        NULLIF(pb.content->>('poll_option_' || clk.opt_n || '_label'), ''),
        'Option ' || clk.opt_n),
      'clicks', clk.clicks
    ) AS j
    FROM clk
    JOIN poll_blocks pb ON pb.block_id = clk.block_id
    JOIN eds e ON e.edition_id = pb.edition_id
    ORDER BY e.edition_date DESC NULLS LAST, pb.block_id, clk.opt_n
  )
  SELECT jsonb_build_object(
    'data', COALESCE((SELECT jsonb_agg(j) FROM rows_out), '[]'::jsonb),
    'meta', jsonb_build_object(
      'schema_version', 1,
      'total_events', (SELECT COALESCE(sum(clicks),0) FROM clk),
      'coverage_pct', 1.0,
      'suppressed_buckets', 0,
      'tz_fallback', 0
    )
  ) INTO v_result;

  RETURN v_result;
END;
$fn$;

-- 2. Snapshot-aware wrappers (single-edition jsonb RPCs) --------------------

-- Helper: try snapshot, return null if missing/stale -------------------------
-- newsletter_get_stats_snapshot already exists from migration 061.

-- newsletter_geo_engagement ---------------------------------------------------

CREATE OR REPLACE FUNCTION public.newsletter_geo_engagement(
  p_edition_id uuid,
  p_metric text,
  p_level text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET statement_timeout = '120s'
AS $$
DECLARE
  v_key text;
  v_payload jsonb;
  v_data_version timestamptz;
BEGIN
  v_key := 'metric=' || COALESCE(p_metric, '') || ';level=' || COALESCE(p_level, '');

  v_payload := public.newsletter_get_stats_snapshot(p_edition_id, 'geo_engagement', v_key);
  IF v_payload IS NOT NULL THEN RETURN v_payload; END IF;

  v_payload := public.newsletter_geo_engagement_live(p_edition_id, p_metric, p_level);

  -- Lazy snapshot: write only if the edition is stable. The cron worker
  -- still pre-warms common combos, but this catches "first user opens the
  -- page on an old edition that the worker hasn't reached yet" without
  -- making them wait twice.
  IF public.newsletter_edition_is_stable(p_edition_id) THEN
    v_data_version := public.newsletter_edition_data_version(p_edition_id);
    IF v_data_version IS NOT NULL AND v_payload IS NOT NULL THEN
      INSERT INTO public.newsletter_edition_stats_snapshots
        (edition_id, rpc_name, params_key, payload, data_version_ts, snapshot_at)
      VALUES (p_edition_id, 'geo_engagement', v_key, v_payload, v_data_version, now())
      ON CONFLICT (edition_id, rpc_name, params_key) DO UPDATE
        SET payload = EXCLUDED.payload,
            data_version_ts = EXCLUDED.data_version_ts,
            snapshot_at = EXCLUDED.snapshot_at;
    END IF;
  END IF;

  RETURN v_payload;
END $$;

-- newsletter_local_time_engagement -------------------------------------------

CREATE OR REPLACE FUNCTION public.newsletter_local_time_engagement(
  p_edition_id uuid,
  p_metric text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET statement_timeout = '120s'
AS $$
DECLARE
  v_key text;
  v_payload jsonb;
  v_data_version timestamptz;
BEGIN
  v_key := 'metric=' || COALESCE(p_metric, '');

  v_payload := public.newsletter_get_stats_snapshot(p_edition_id, 'local_time_engagement', v_key);
  IF v_payload IS NOT NULL THEN RETURN v_payload; END IF;

  v_payload := public.newsletter_local_time_engagement_live(p_edition_id, p_metric);

  IF public.newsletter_edition_is_stable(p_edition_id) THEN
    v_data_version := public.newsletter_edition_data_version(p_edition_id);
    IF v_data_version IS NOT NULL AND v_payload IS NOT NULL THEN
      INSERT INTO public.newsletter_edition_stats_snapshots
        (edition_id, rpc_name, params_key, payload, data_version_ts, snapshot_at)
      VALUES (p_edition_id, 'local_time_engagement', v_key, v_payload, v_data_version, now())
      ON CONFLICT (edition_id, rpc_name, params_key) DO UPDATE
        SET payload = EXCLUDED.payload,
            data_version_ts = EXCLUDED.data_version_ts,
            snapshot_at = EXCLUDED.snapshot_at;
    END IF;
  END IF;

  RETURN v_payload;
END $$;

-- newsletter_block_geo -------------------------------------------------------

CREATE OR REPLACE FUNCTION public.newsletter_block_geo(
  p_edition_id uuid,
  p_level text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET statement_timeout = '120s'
AS $$
DECLARE
  v_key text;
  v_payload jsonb;
  v_data_version timestamptz;
BEGIN
  v_key := 'level=' || COALESCE(p_level, '');

  v_payload := public.newsletter_get_stats_snapshot(p_edition_id, 'block_geo', v_key);
  IF v_payload IS NOT NULL THEN RETURN v_payload; END IF;

  v_payload := public.newsletter_block_geo_live(p_edition_id, p_level);

  IF public.newsletter_edition_is_stable(p_edition_id) THEN
    v_data_version := public.newsletter_edition_data_version(p_edition_id);
    IF v_data_version IS NOT NULL AND v_payload IS NOT NULL THEN
      INSERT INTO public.newsletter_edition_stats_snapshots
        (edition_id, rpc_name, params_key, payload, data_version_ts, snapshot_at)
      VALUES (p_edition_id, 'block_geo', v_key, v_payload, v_data_version, now())
      ON CONFLICT (edition_id, rpc_name, params_key) DO UPDATE
        SET payload = EXCLUDED.payload,
            data_version_ts = EXCLUDED.data_version_ts,
            snapshot_at = EXCLUDED.snapshot_at;
    END IF;
  END IF;

  RETURN v_payload;
END $$;

-- newsletter_engagement_timeline ---------------------------------------------

CREATE OR REPLACE FUNCTION public.newsletter_engagement_timeline(
  p_edition_id uuid,
  p_bucket_minutes integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET statement_timeout = '120s'
AS $$
DECLARE
  v_key text;
  v_payload jsonb;
  v_data_version timestamptz;
BEGIN
  v_key := 'bucket_minutes=' || COALESCE(p_bucket_minutes, 0)::text;

  v_payload := public.newsletter_get_stats_snapshot(p_edition_id, 'engagement_timeline', v_key);
  IF v_payload IS NOT NULL THEN RETURN v_payload; END IF;

  v_payload := public.newsletter_engagement_timeline_live(p_edition_id, p_bucket_minutes);

  IF public.newsletter_edition_is_stable(p_edition_id) THEN
    v_data_version := public.newsletter_edition_data_version(p_edition_id);
    IF v_data_version IS NOT NULL AND v_payload IS NOT NULL THEN
      INSERT INTO public.newsletter_edition_stats_snapshots
        (edition_id, rpc_name, params_key, payload, data_version_ts, snapshot_at)
      VALUES (p_edition_id, 'engagement_timeline', v_key, v_payload, v_data_version, now())
      ON CONFLICT (edition_id, rpc_name, params_key) DO UPDATE
        SET payload = EXCLUDED.payload,
            data_version_ts = EXCLUDED.data_version_ts,
            snapshot_at = EXCLUDED.snapshot_at;
    END IF;
  END IF;

  RETURN v_payload;
END $$;

-- 3. Snapshot-aware wrapper: poll_results (multi-edition; same shape as
--    block_effectiveness in migration 061) ----------------------------------

CREATE OR REPLACE FUNCTION public.newsletter_poll_results(p_edition_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET statement_timeout = '300000'
AS $$
DECLARE
  v_cached_ids  uuid[];
  v_live_ids    uuid[];
  v_cached_data jsonb;
  v_live_env    jsonb;
  v_meta        jsonb;
BEGIN
  SELECT COALESCE(array_agg(s.edition_id), ARRAY[]::uuid[])
    INTO v_cached_ids
  FROM public.newsletter_edition_stats_snapshots s
  WHERE s.edition_id = ANY (p_edition_ids)
    AND s.rpc_name = 'poll_results'
    AND s.params_key = ''
    AND s.data_version_ts = public.newsletter_edition_data_version(s.edition_id);

  SELECT COALESCE(array_agg(ed), ARRAY[]::uuid[])
    INTO v_live_ids
  FROM unnest(p_edition_ids) AS ed
  WHERE NOT (ed = ANY (v_cached_ids));

  SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
    INTO v_cached_data
  FROM public.newsletter_edition_stats_snapshots s,
       LATERAL jsonb_array_elements(s.payload->'data') AS elem
  WHERE s.edition_id = ANY (v_cached_ids)
    AND s.rpc_name = 'poll_results'
    AND s.params_key = '';

  IF cardinality(v_live_ids) > 0 THEN
    v_live_env := public.newsletter_poll_results_live(v_live_ids);
  ELSE
    v_live_env := jsonb_build_object('data', '[]'::jsonb, 'meta',
      jsonb_build_object('schema_version', 1, 'total_events', 0, 'coverage_pct', 1.0,
                         'suppressed_buckets', 0, 'tz_fallback', 0));
  END IF;

  v_meta := COALESCE(v_live_env->'meta', '{}'::jsonb)
    || jsonb_build_object(
         'cached_editions', cardinality(v_cached_ids),
         'live_editions',   cardinality(v_live_ids)
       );

  RETURN jsonb_build_object(
    'data', v_cached_data || COALESCE(v_live_env->'data', '[]'::jsonb),
    'meta', v_meta
  );
END $$;

-- 4. Update the per-edition refresh fn to also cache geo + poll combos ------

CREATE OR REPLACE FUNCTION public.newsletter_refresh_edition_snapshots(p_edition_id uuid)
RETURNS integer
LANGUAGE plpgsql
SET statement_timeout = '600000'
AS $$
DECLARE
  v_data_version timestamptz;
  v_payload      jsonb;
  v_count        integer := 0;
BEGIN
  v_data_version := public.newsletter_edition_data_version(p_edition_id);
  IF v_data_version IS NULL THEN RETURN 0; END IF;

  -- engagement
  SELECT to_jsonb(t) INTO v_payload
  FROM public.newsletter_edition_engagement_live(ARRAY[p_edition_id]) t;
  IF v_payload IS NOT NULL THEN
    INSERT INTO public.newsletter_edition_stats_snapshots
      (edition_id, rpc_name, params_key, payload, data_version_ts, snapshot_at)
    VALUES (p_edition_id, 'engagement', '', v_payload, v_data_version, now())
    ON CONFLICT (edition_id, rpc_name, params_key) DO UPDATE
      SET payload = EXCLUDED.payload, data_version_ts = EXCLUDED.data_version_ts, snapshot_at = EXCLUDED.snapshot_at;
    v_count := v_count + 1;
  END IF;

  -- block_effectiveness
  v_payload := public.newsletter_block_effectiveness_live(ARRAY[p_edition_id]);
  IF v_payload IS NOT NULL THEN
    INSERT INTO public.newsletter_edition_stats_snapshots
      (edition_id, rpc_name, params_key, payload, data_version_ts, snapshot_at)
    VALUES (p_edition_id, 'block_effectiveness', '', v_payload, v_data_version, now())
    ON CONFLICT (edition_id, rpc_name, params_key) DO UPDATE
      SET payload = EXCLUDED.payload, data_version_ts = EXCLUDED.data_version_ts, snapshot_at = EXCLUDED.snapshot_at;
    v_count := v_count + 1;
  END IF;

  -- poll_results
  v_payload := public.newsletter_poll_results_live(ARRAY[p_edition_id]);
  IF v_payload IS NOT NULL THEN
    INSERT INTO public.newsletter_edition_stats_snapshots
      (edition_id, rpc_name, params_key, payload, data_version_ts, snapshot_at)
    VALUES (p_edition_id, 'poll_results', '', v_payload, v_data_version, now())
    ON CONFLICT (edition_id, rpc_name, params_key) DO UPDATE
      SET payload = EXCLUDED.payload, data_version_ts = EXCLUDED.data_version_ts, snapshot_at = EXCLUDED.snapshot_at;
    v_count := v_count + 1;
  END IF;

  -- geo combos (country-level, both metrics). City-level is on-demand only.
  FOR v_payload IN
    SELECT public.newsletter_geo_engagement_live(p_edition_id, m, 'country')
    FROM unnest(ARRAY['open','click']::text[]) AS m
  LOOP
    NULL; -- silence "result discarded" — handled inline below
  END LOOP;

  -- Explicit per-combo upserts (simpler + no loop-state to track)
  v_payload := public.newsletter_geo_engagement_live(p_edition_id, 'open', 'country');
  IF v_payload IS NOT NULL THEN
    INSERT INTO public.newsletter_edition_stats_snapshots
      (edition_id, rpc_name, params_key, payload, data_version_ts, snapshot_at)
    VALUES (p_edition_id, 'geo_engagement', 'metric=open;level=country', v_payload, v_data_version, now())
    ON CONFLICT (edition_id, rpc_name, params_key) DO UPDATE
      SET payload = EXCLUDED.payload, data_version_ts = EXCLUDED.data_version_ts, snapshot_at = EXCLUDED.snapshot_at;
    v_count := v_count + 1;
  END IF;

  v_payload := public.newsletter_geo_engagement_live(p_edition_id, 'click', 'country');
  IF v_payload IS NOT NULL THEN
    INSERT INTO public.newsletter_edition_stats_snapshots
      (edition_id, rpc_name, params_key, payload, data_version_ts, snapshot_at)
    VALUES (p_edition_id, 'geo_engagement', 'metric=click;level=country', v_payload, v_data_version, now())
    ON CONFLICT (edition_id, rpc_name, params_key) DO UPDATE
      SET payload = EXCLUDED.payload, data_version_ts = EXCLUDED.data_version_ts, snapshot_at = EXCLUDED.snapshot_at;
    v_count := v_count + 1;
  END IF;

  v_payload := public.newsletter_local_time_engagement_live(p_edition_id, 'open');
  IF v_payload IS NOT NULL THEN
    INSERT INTO public.newsletter_edition_stats_snapshots
      (edition_id, rpc_name, params_key, payload, data_version_ts, snapshot_at)
    VALUES (p_edition_id, 'local_time_engagement', 'metric=open', v_payload, v_data_version, now())
    ON CONFLICT (edition_id, rpc_name, params_key) DO UPDATE
      SET payload = EXCLUDED.payload, data_version_ts = EXCLUDED.data_version_ts, snapshot_at = EXCLUDED.snapshot_at;
    v_count := v_count + 1;
  END IF;

  v_payload := public.newsletter_local_time_engagement_live(p_edition_id, 'click');
  IF v_payload IS NOT NULL THEN
    INSERT INTO public.newsletter_edition_stats_snapshots
      (edition_id, rpc_name, params_key, payload, data_version_ts, snapshot_at)
    VALUES (p_edition_id, 'local_time_engagement', 'metric=click', v_payload, v_data_version, now())
    ON CONFLICT (edition_id, rpc_name, params_key) DO UPDATE
      SET payload = EXCLUDED.payload, data_version_ts = EXCLUDED.data_version_ts, snapshot_at = EXCLUDED.snapshot_at;
    v_count := v_count + 1;
  END IF;

  v_payload := public.newsletter_block_geo_live(p_edition_id, 'country');
  IF v_payload IS NOT NULL THEN
    INSERT INTO public.newsletter_edition_stats_snapshots
      (edition_id, rpc_name, params_key, payload, data_version_ts, snapshot_at)
    VALUES (p_edition_id, 'block_geo', 'level=country', v_payload, v_data_version, now())
    ON CONFLICT (edition_id, rpc_name, params_key) DO UPDATE
      SET payload = EXCLUDED.payload, data_version_ts = EXCLUDED.data_version_ts, snapshot_at = EXCLUDED.snapshot_at;
    v_count := v_count + 1;
  END IF;

  v_payload := public.newsletter_engagement_timeline_live(p_edition_id, 5);
  IF v_payload IS NOT NULL THEN
    INSERT INTO public.newsletter_edition_stats_snapshots
      (edition_id, rpc_name, params_key, payload, data_version_ts, snapshot_at)
    VALUES (p_edition_id, 'engagement_timeline', 'bucket_minutes=5', v_payload, v_data_version, now())
    ON CONFLICT (edition_id, rpc_name, params_key) DO UPDATE
      SET payload = EXCLUDED.payload, data_version_ts = EXCLUDED.data_version_ts, snapshot_at = EXCLUDED.snapshot_at;
    v_count := v_count + 1;
  END IF;

  RETURN v_count;
END $$;

COMMENT ON FUNCTION public.newsletter_refresh_edition_snapshots(uuid) IS
  'Computes and persists ALL cached stats RPCs for one edition (engagement, '
  'block_effectiveness, poll_results, geo_engagement [open/click x country], '
  'local_time_engagement [open/click], block_geo [country], '
  'engagement_timeline [5min]). Idempotent.';

-- 5. Bulk-find: any edition whose engagement snapshot is missing/stale ------
--    (geo combos follow engagement freshness — refreshing all together keeps
--    the snapshot set consistent.) The find fn is unchanged; the refresh fn
--    above handles the wider combo set.
