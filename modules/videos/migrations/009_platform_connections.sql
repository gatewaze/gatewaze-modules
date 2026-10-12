-- ============================================================================
-- Module: videos
-- Migration: 009_platform_connections
-- Description: The publishing accounts themselves — credentials, state, and
--              the metrics they produce. Closes the FK that
--              video_publications.connection_id has pointed at nothing since
--              007.
-- ============================================================================
--
-- The split between this and video_channel_profiles (008) is deliberate.
--
-- 008 answers "which house style does this account write in", which the copy
-- recipes need and which is safe to read widely. This answers "how do we
-- authenticate as this account", which is a credential and is read by the
-- worker alone.
--
-- Two YouTube channels is the requirement that shapes the whole table. AAIF
-- publishes to @AgenticAI-Foundation (UCG6qpjVnBTTT8wLGBygANOQ, 40.8k subs)
-- and @AAIFLive (UCLAh-x7caEkg2jsbhNmg-3Q, 467 subs). A per-platform
-- credential cannot express that, and a per-platform DEFAULT would quietly
-- attribute half the conference talks to the wrong channel — which is why the
-- recap pipeline resolves its connection from the playlist's own channel
-- rather than from a default.

SET statement_timeout = '300s';

-- ==========================================================================
-- 1. The connections
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.video_platform_connections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform            text NOT NULL,
  -- The platform's own id for the account. A YouTube channel id, a TikTok
  -- handle. UNIQUE per platform so one account cannot be connected twice and
  -- double its numbers once metrics land.
  external_account_id text NOT NULL,
  label               text NOT NULL,

  -- Which editorial profile this account writes in. Nullable because an
  -- account can be connected before anyone decides its voice.
  channel_profile_id  uuid REFERENCES public.video_channel_profiles(id) ON DELETE SET NULL,

  -- Sealed with the platform envelope (AES-256-GCM, 'v1:<base64>', key from
  -- GATEWAZE_SECRETS_KEY) exactly as installed_modules.config is. Holds the
  -- per-account refresh token; the OAuth CLIENT credentials are app-level and
  -- live in the publisher module's own sealed config instead.
  --
  -- NEVER selected by any read endpoint. The API surface returns state and
  -- label only.
  encrypted_credentials text,
  scopes                text[] NOT NULL DEFAULT '{}',

  state       text NOT NULL DEFAULT 'disconnected'
    CHECK (state IN ('disconnected', 'connected', 'needs_reauth', 'revoked')),
  -- Why it is in that state, for the operator. Never a credential.
  state_detail text,

  -- Metrics collection, per connection rather than per platform: one channel
  -- can be rate-limited or de-authorised while its sibling is fine.
  collection_enabled  boolean NOT NULL DEFAULT false,
  last_collected_at   timestamptz,
  last_collect_status text
    CHECK (last_collect_status IS NULL OR last_collect_status IN ('ok', 'no_data', 'auth', 'error')),
  last_collect_detail text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (platform, external_account_id)
);

COMMENT ON TABLE public.video_platform_connections IS
  'One row per publishing ACCOUNT. AAIF runs two YouTube channels with different audiences and different house styles, so credentials, collection state and rate-limit state are all per account, never per platform.';

COMMENT ON COLUMN public.video_platform_connections.encrypted_credentials IS
  'Sealed refresh token, same envelope as installed_modules.config. Never returned by any read endpoint and never logged. The OAuth client id/secret are app-level and live in the publisher module''s sealed config.';

COMMENT ON COLUMN public.video_platform_connections.last_collect_status IS
  '"no_data" is NOT an error and is NOT zero. A browser-scraped platform whose markup changed records no_data so a layout change cannot be read as a collapse in viewers.';

CREATE INDEX IF NOT EXISTS video_platform_connections_due
  ON public.video_platform_connections (last_collected_at NULLS FIRST)
  WHERE collection_enabled AND state = 'connected';

ALTER TABLE public.video_platform_connections ENABLE ROW LEVEL SECURITY;

-- Read-only, and only the non-credential columns are ever selected by the
-- API. The worker uses the service role.
DROP POLICY IF EXISTS video_platform_connections_read ON public.video_platform_connections;
CREATE POLICY video_platform_connections_read
  ON public.video_platform_connections FOR SELECT
  USING (public.can_edit_any_videos());

REVOKE ALL ON public.video_platform_connections FROM anon;
-- Belt and braces: even a caller who passes the RLS policy must not be able
-- to read the sealed column through PostgREST.
REVOKE SELECT (encrypted_credentials) ON public.video_platform_connections FROM authenticated;

-- Close the dangling reference from 007.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name
    WHERE tc.table_name = 'video_publications' AND tc.constraint_type = 'FOREIGN KEY'
      AND k.column_name = 'connection_id'
  ) THEN
    -- Orphans first: 007 allowed any uuid here and nothing validated it.
    UPDATE public.video_publications SET connection_id = NULL
    WHERE connection_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.video_platform_connections c WHERE c.id = connection_id);

    ALTER TABLE public.video_publications
      ADD CONSTRAINT video_publications_connection_fk
      FOREIGN KEY (connection_id) REFERENCES public.video_platform_connections(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ==========================================================================
-- 2. The metrics
-- ==========================================================================
--
-- One row per publication per day per metric set. Daily rather than
-- continuous because every platform's own numbers settle on a day boundary,
-- and because a browser-scraped source cannot be polled often without
-- looking like abuse.
CREATE TABLE IF NOT EXISTS public.video_metrics (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id uuid NOT NULL REFERENCES public.video_publications(id) ON DELETE CASCADE,
  connection_id  uuid REFERENCES public.video_platform_connections(id) ON DELETE SET NULL,
  collected_for  date NOT NULL,

  -- The honesty convention, borrowed from hot-campaign-monitor's
  -- campaign_snapshots: a row always records WHY it has the numbers it has.
  -- 'no_data' means we looked and the platform did not tell us, which must
  -- never be stored as zero.
  status text NOT NULL DEFAULT 'ok'
    CHECK (status IN ('ok', 'no_data', 'auth', 'error')),
  status_detail text,

  views       bigint,
  likes       bigint,
  comments    bigint,
  shares      bigint,
  -- Seconds, where the platform reports it. YouTube does; TikTok does not.
  watch_time  bigint,
  -- Everything else the platform gave us, unflattened, so a new metric does
  -- not need a migration before it can be captured.
  raw         jsonb NOT NULL DEFAULT '{}'::jsonb,

  collected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (publication_id, collected_for)
);

COMMENT ON TABLE public.video_metrics IS
  'Daily metric snapshot per publication. status is load-bearing: "no_data" records that we asked and were not told, and is never written as zero. A selector change on a scraped platform must read as no_data, not as viewers collapsing.';

CREATE INDEX IF NOT EXISTS video_metrics_publication_day
  ON public.video_metrics (publication_id, collected_for DESC);

ALTER TABLE public.video_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS video_metrics_read ON public.video_metrics;
CREATE POLICY video_metrics_read
  ON public.video_metrics FOR SELECT
  USING (public.can_edit_any_videos());

REVOKE ALL ON public.video_metrics FROM anon;

-- ==========================================================================
-- 3. The latest number per publication, for a dashboard
-- ==========================================================================
--
-- DISTINCT ON rather than a window function: one row per publication, newest
-- first, is exactly what this does and it uses the index above.
CREATE OR REPLACE VIEW public.video_metrics_latest AS
SELECT DISTINCT ON (m.publication_id)
  m.publication_id,
  m.connection_id,
  m.collected_for,
  m.status,
  m.views, m.likes, m.comments, m.shares, m.watch_time,
  m.collected_at
FROM public.video_metrics m
-- Only rows that actually carry numbers lead. A publication whose most recent
-- collection was no_data should show its last REAL figure, not a blank.
WHERE m.status = 'ok'
ORDER BY m.publication_id, m.collected_for DESC;

ALTER VIEW public.video_metrics_latest SET (security_invoker = true);

COMMENT ON VIEW public.video_metrics_latest IS
  'Most recent successful collection per publication. Filters to status = ok on purpose: a publication whose latest attempt returned no_data keeps showing its last real figure rather than going blank, which is what stops a scraping failure looking like an audience disappearing.';

REVOKE ALL ON public.video_metrics_latest FROM anon;

-- ==========================================================================
-- 4. Link the seeded channel profiles to connections as they are made
-- ==========================================================================
--
-- The four profiles seeded by 008 carry the same (platform, external_id) key
-- this table uses, so a connection made later can find its profile without
-- the operator restating it.
COMMENT ON COLUMN public.video_platform_connections.channel_profile_id IS
  'Resolved from video_channel_profiles on the same (platform, external_account_id). Set when the connection is created, so the copy recipes know which voice this account writes in.';
