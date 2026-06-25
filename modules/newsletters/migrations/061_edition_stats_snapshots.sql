-- ============================================================================
-- Module: newsletters
-- Migration: 061_edition_stats_snapshots
-- Description: Cache layer for the expensive per-edition stats RPCs.
--
-- AAIF MLOps Community (55,437 subs, 3.96M cumulative send_log) was tripping
-- the 25s statement_timeout on newsletter_edition_engagement the moment a
-- fresh 55k send landed. Migration 060 raised the cap to 5min; this
-- migration kills the underlying cost for historical editions by snapshotting
-- the result the first time after the edition "stabilises" (~30d post-send,
-- when late opens/clicks have died down) and returning the snapshot on
-- subsequent reads.
--
-- Design:
--
--   1. A single generic snapshot table keyed by (edition_id, rpc_name,
--      params_key). Payload is jsonb to keep the table shape stable as new
--      RPCs are added. The engagement RPC's typed return shape is packed to
--      jsonb on write and unpacked back to typed columns on read — verbose
--      but mechanical.
--
--   2. A `data_version_ts` column captures max(send.completed_at) for the
--      edition at snapshot time. A snapshot is "current" iff its
--      data_version_ts equals the edition's CURRENT max(completed_at). A
--      late send (re-send weeks later) invalidates the snapshot
--      automatically; the next read recomputes.
--
--   3. The existing RPCs are renamed to *_live (unchanged bodies) and
--      replaced by snapshot-aware wrappers that:
--        - identify which of the requested editions have a current snapshot,
--        - read those from the table,
--        - delegate the rest to *_live,
--        - UNION ALL the two streams.
--      Admin callers don't change; cache hits are transparent.
--
--   4. A per-edition refresh fn computes + persists snapshots for every
--      covered RPC in one shot. The cron worker (registered for
--      `newsletters:edition-snapshot` but until now lacking a handler)
--      drives this for stale/missing editions.
--
-- Geo RPCs (R1-R5 from migration 050) use the same snapshot table — wrapper
-- RPCs for them land in a follow-up migration once this pattern is validated.
-- ============================================================================

-- 1. Snapshot table -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.newsletter_edition_stats_snapshots (
  edition_id        uuid        NOT NULL,
  rpc_name          text        NOT NULL,
  params_key        text        NOT NULL DEFAULT '',
  payload           jsonb       NOT NULL,
  data_version_ts   timestamptz NOT NULL,
  snapshot_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (edition_id, rpc_name, params_key)
);

CREATE INDEX IF NOT EXISTS idx_neses_rpc_version
  ON public.newsletter_edition_stats_snapshots (rpc_name, data_version_ts);

COMMENT ON TABLE public.newsletter_edition_stats_snapshots IS
  'Per-edition cache for engagement/geo/block stats RPCs. A snapshot is '
  'current iff data_version_ts matches the edition''s current max(send '
  'completed_at). See migration 061.';

-- 2. Helpers ------------------------------------------------------------------

-- max(completed_at | started_at | scheduled_at | created_at) across this
-- edition's sends. Used as the staleness fingerprint.
CREATE OR REPLACE FUNCTION public.newsletter_edition_data_version(p_edition_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT MAX(COALESCE(completed_at, started_at, scheduled_at, created_at))
  FROM public.newsletter_sends
  WHERE edition_id = p_edition_id
$$;

-- "Stable enough to snapshot" = latest send completed more than p_days ago.
CREATE OR REPLACE FUNCTION public.newsletter_edition_is_stable(p_edition_id uuid, p_days int DEFAULT 30)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT public.newsletter_edition_data_version(p_edition_id) < (now() - (p_days || ' days')::interval)
$$;

-- Snapshot getter — returns payload iff the snapshot is current.
CREATE OR REPLACE FUNCTION public.newsletter_get_stats_snapshot(
  p_edition_id uuid,
  p_rpc text,
  p_params_key text DEFAULT ''
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT s.payload
  FROM public.newsletter_edition_stats_snapshots s
  WHERE s.edition_id = p_edition_id
    AND s.rpc_name = p_rpc
    AND s.params_key = p_params_key
    AND s.data_version_ts = public.newsletter_edition_data_version(p_edition_id)
$$;

-- 3. Rename existing RPCs to *_live ------------------------------------------
--
-- The CURRENT body of these functions becomes the live-compute path. Wrappers
-- below take over the public name. RENAME (not DROP + CREATE) keeps proconfig
-- and permissions in place.

ALTER FUNCTION public.newsletter_edition_engagement(uuid[])
  RENAME TO newsletter_edition_engagement_live;

-- newsletter_block_effectiveness returns jsonb so the wrapper is simpler.
ALTER FUNCTION public.newsletter_block_effectiveness(uuid[])
  RENAME TO newsletter_block_effectiveness_live;

-- 4. Snapshot-aware wrapper: engagement ---------------------------------------

CREATE OR REPLACE FUNCTION public.newsletter_edition_engagement(p_edition_ids uuid[])
RETURNS TABLE (
  edition_id        uuid,
  sent              bigint,
  delivered         bigint,
  unique_opens      bigint,
  unique_clicks     bigint,
  human_opens       bigint,
  human_clicks      bigint,
  machine_opens     bigint,
  machine_clicks    bigint,
  human_source      text,
  bounced           bigint,
  unsubscribed      bigint,
  suppressed        bigint,
  cio_human_opens   bigint,
  cio_machine_opens bigint,
  cio_human_clicks  bigint
)
LANGUAGE plpgsql
STABLE
SET statement_timeout TO '300000'
AS $$
DECLARE
  v_cached_ids uuid[];
  v_live_ids   uuid[];
BEGIN
  -- Which requested editions have a current snapshot?
  SELECT COALESCE(array_agg(s.edition_id), ARRAY[]::uuid[])
    INTO v_cached_ids
  FROM public.newsletter_edition_stats_snapshots s
  WHERE s.edition_id = ANY (p_edition_ids)
    AND s.rpc_name = 'engagement'
    AND s.params_key = ''
    AND s.data_version_ts = public.newsletter_edition_data_version(s.edition_id);

  -- Remainder need live compute.
  SELECT COALESCE(array_agg(ed), ARRAY[]::uuid[])
    INTO v_live_ids
  FROM unnest(p_edition_ids) AS ed
  WHERE NOT (ed = ANY (v_cached_ids));

  RETURN QUERY
    -- Snapshot rows: unpack the jsonb payload back to typed columns.
    SELECT
      (s.payload->>'edition_id')::uuid,
      (s.payload->>'sent')::bigint,
      (s.payload->>'delivered')::bigint,
      (s.payload->>'unique_opens')::bigint,
      (s.payload->>'unique_clicks')::bigint,
      (s.payload->>'human_opens')::bigint,
      (s.payload->>'human_clicks')::bigint,
      (s.payload->>'machine_opens')::bigint,
      (s.payload->>'machine_clicks')::bigint,
      (s.payload->>'human_source')::text,
      (s.payload->>'bounced')::bigint,
      (s.payload->>'unsubscribed')::bigint,
      (s.payload->>'suppressed')::bigint,
      (s.payload->>'cio_human_opens')::bigint,
      (s.payload->>'cio_machine_opens')::bigint,
      (s.payload->>'cio_human_clicks')::bigint
    FROM public.newsletter_edition_stats_snapshots s
    WHERE s.edition_id = ANY (v_cached_ids)
      AND s.rpc_name = 'engagement'
      AND s.params_key = ''
    UNION ALL
    SELECT * FROM public.newsletter_edition_engagement_live(v_live_ids);
END $$;

COMMENT ON FUNCTION public.newsletter_edition_engagement(uuid[]) IS
  'Engagement aggregate per edition. Returns snapshot rows where available '
  '(data_version_ts matches current max(send.completed_at)) and live-compute '
  'for the rest. Snapshots populated by the newsletters:edition-snapshot '
  'worker for editions stable >30d. See migration 061.';

-- 5. Snapshot-aware wrapper: block_effectiveness ------------------------------
--
-- block_effectiveness returns a single jsonb envelope {data, meta} aggregating
-- across all requested editions. To respect per-edition caching we need to
-- merge per-edition cached envelopes with a live envelope for the rest.
-- Simpler implementation: live-call for the missing editions, then merge into
-- the snapshot envelope. Both envelopes share the {data: [{edition_id, ...}]}
-- shape so we just concat the data arrays. meta gets re-derived from the
-- merged data on the fly (totals only — schema_version comes from the live
-- envelope or the snapshot's stored value, whichever is non-null).

CREATE OR REPLACE FUNCTION public.newsletter_block_effectiveness(p_edition_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET statement_timeout TO '300000'
AS $$
DECLARE
  v_cached_ids   uuid[];
  v_live_ids     uuid[];
  v_cached_data  jsonb;
  v_live_env     jsonb;
  v_meta         jsonb;
BEGIN
  -- Which editions are cached?
  SELECT COALESCE(array_agg(s.edition_id), ARRAY[]::uuid[])
    INTO v_cached_ids
  FROM public.newsletter_edition_stats_snapshots s
  WHERE s.edition_id = ANY (p_edition_ids)
    AND s.rpc_name = 'block_effectiveness'
    AND s.params_key = ''
    AND s.data_version_ts = public.newsletter_edition_data_version(s.edition_id);

  SELECT COALESCE(array_agg(ed), ARRAY[]::uuid[])
    INTO v_live_ids
  FROM unnest(p_edition_ids) AS ed
  WHERE NOT (ed = ANY (v_cached_ids));

  -- Cached data: flatten each snapshot's data array and concat.
  SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
    INTO v_cached_data
  FROM public.newsletter_edition_stats_snapshots s,
       LATERAL jsonb_array_elements(s.payload->'data') AS elem
  WHERE s.edition_id = ANY (v_cached_ids)
    AND s.rpc_name = 'block_effectiveness'
    AND s.params_key = '';

  -- Live envelope for the rest. live fn handles empty input gracefully.
  IF cardinality(v_live_ids) > 0 THEN
    v_live_env := public.newsletter_block_effectiveness_live(v_live_ids);
  ELSE
    v_live_env := jsonb_build_object('data', '[]'::jsonb, 'meta', '{}'::jsonb);
  END IF;

  v_meta := COALESCE(v_live_env->'meta', '{}'::jsonb)
    || jsonb_build_object(
         'cached_editions',   cardinality(v_cached_ids),
         'live_editions',     cardinality(v_live_ids),
         'total_data_rows',   jsonb_array_length(v_cached_data) + jsonb_array_length(v_live_env->'data')
       );

  RETURN jsonb_build_object(
    'data', v_cached_data || COALESCE(v_live_env->'data', '[]'::jsonb),
    'meta', v_meta
  );
END $$;

COMMENT ON FUNCTION public.newsletter_block_effectiveness(uuid[]) IS
  'Cross-edition block effectiveness. Returns merged envelope: cached rows '
  'for snapshotted editions, live-compute for the rest. See migration 061.';

-- 6. Refresh fn: compute + persist snapshots for one edition ------------------

CREATE OR REPLACE FUNCTION public.newsletter_refresh_edition_snapshots(p_edition_id uuid)
RETURNS integer
LANGUAGE plpgsql
SET statement_timeout TO '600000'
AS $$
DECLARE
  v_data_version timestamptz;
  v_payload      jsonb;
  v_count        integer := 0;
BEGIN
  v_data_version := public.newsletter_edition_data_version(p_edition_id);
  IF v_data_version IS NULL THEN
    -- No sends → nothing to snapshot.
    RETURN 0;
  END IF;

  -- engagement
  SELECT to_jsonb(t) INTO v_payload
  FROM public.newsletter_edition_engagement_live(ARRAY[p_edition_id]) t;
  IF v_payload IS NOT NULL THEN
    INSERT INTO public.newsletter_edition_stats_snapshots
      (edition_id, rpc_name, params_key, payload, data_version_ts, snapshot_at)
    VALUES
      (p_edition_id, 'engagement', '', v_payload, v_data_version, now())
    ON CONFLICT (edition_id, rpc_name, params_key) DO UPDATE
      SET payload = EXCLUDED.payload,
          data_version_ts = EXCLUDED.data_version_ts,
          snapshot_at = EXCLUDED.snapshot_at;
    v_count := v_count + 1;
  END IF;

  -- block_effectiveness (jsonb envelope already)
  v_payload := public.newsletter_block_effectiveness_live(ARRAY[p_edition_id]);
  IF v_payload IS NOT NULL THEN
    INSERT INTO public.newsletter_edition_stats_snapshots
      (edition_id, rpc_name, params_key, payload, data_version_ts, snapshot_at)
    VALUES
      (p_edition_id, 'block_effectiveness', '', v_payload, v_data_version, now())
    ON CONFLICT (edition_id, rpc_name, params_key) DO UPDATE
      SET payload = EXCLUDED.payload,
          data_version_ts = EXCLUDED.data_version_ts,
          snapshot_at = EXCLUDED.snapshot_at;
    v_count := v_count + 1;
  END IF;

  RETURN v_count;
END $$;

COMMENT ON FUNCTION public.newsletter_refresh_edition_snapshots(uuid) IS
  'Computes and persists stats snapshots for one edition (engagement + '
  'block_effectiveness as of migration 061; geo RPCs to follow). Idempotent: '
  'subsequent calls with the same data_version_ts no-op via primary key '
  'conflict update.';

-- 7. Bulk-find: editions that need a refresh ---------------------------------

CREATE OR REPLACE FUNCTION public.newsletter_find_editions_needing_snapshot(
  p_limit       int DEFAULT 50,
  p_min_age_days int DEFAULT 30
)
RETURNS TABLE (edition_id uuid, data_version_ts timestamptz)
LANGUAGE sql
STABLE
AS $$
  SELECT e.id, public.newsletter_edition_data_version(e.id)
  FROM public.newsletters_editions e
  WHERE EXISTS (
    SELECT 1 FROM public.newsletter_sends s
    WHERE s.edition_id = e.id
      AND COALESCE(s.completed_at, s.started_at, s.scheduled_at, s.created_at)
            < (now() - (p_min_age_days || ' days')::interval)
  )
  AND (
    -- Either no snapshot yet for the engagement RPC
    NOT EXISTS (
      SELECT 1 FROM public.newsletter_edition_stats_snapshots s
      WHERE s.edition_id = e.id AND s.rpc_name = 'engagement' AND s.params_key = ''
    )
    -- Or it's stale (a newer send landed since)
    OR (
      SELECT s.data_version_ts FROM public.newsletter_edition_stats_snapshots s
      WHERE s.edition_id = e.id AND s.rpc_name = 'engagement' AND s.params_key = ''
    ) < public.newsletter_edition_data_version(e.id)
  )
  ORDER BY public.newsletter_edition_data_version(e.id) DESC
  LIMIT p_limit
$$;

COMMENT ON FUNCTION public.newsletter_find_editions_needing_snapshot(int, int) IS
  'Returns up-to p_limit editions whose latest send is at least p_min_age_days '
  'old AND whose engagement snapshot is missing or stale. Used by the '
  'newsletters:edition-snapshot cron worker.';
