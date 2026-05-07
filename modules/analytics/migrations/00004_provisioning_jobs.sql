-- ============================================================================
-- Migration: analytics_00004_provisioning_jobs
-- Description: Property → Umami website creation queue + the short-lived
--              dashboard query cache + share-token storage.
--              Per spec-analytics-module §5.2.
--
-- All three tables are service_role only — they're worker / cache /
-- share-link infrastructure, never touched by the admin UI directly.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. analytics_provisioning_jobs — property → Umami website creation
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.analytics_provisioning_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id       uuid NOT NULL REFERENCES public.analytics_properties(property_id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'creating', 'succeeded', 'failed')),
  status_detail     text,
  attempts          integer NOT NULL DEFAULT 0,
  last_attempted_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.analytics_provisioning_jobs IS
  'Tracks property → Umami website creation. Worker picks up status=queued rows, calls Umami''s API, writes the resulting website_uuid back to analytics_properties.';

CREATE INDEX IF NOT EXISTS analytics_provisioning_jobs_status
  ON public.analytics_provisioning_jobs (status);
CREATE INDEX IF NOT EXISTS analytics_provisioning_jobs_property
  ON public.analytics_provisioning_jobs (property_id);

ALTER TABLE public.analytics_provisioning_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS analytics_provisioning_jobs_service ON public.analytics_provisioning_jobs;
CREATE POLICY analytics_provisioning_jobs_service ON public.analytics_provisioning_jobs
  FOR ALL
  USING (current_setting('role', true) IN ('service_role', 'postgres'))
  WITH CHECK (current_setting('role', true) IN ('service_role', 'postgres'));

GRANT ALL ON public.analytics_provisioning_jobs TO service_role;

-- ----------------------------------------------------------------------------
-- 2. analytics_query_cache — short-lived cache for hot dashboard queries
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.analytics_query_cache (
  cache_key   text PRIMARY KEY,
  result      jsonb NOT NULL,
  cached_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

COMMENT ON TABLE public.analytics_query_cache IS
  'Short-lived (default 60s) cache for hot dashboard queries. Keyed on hash(method, args, caller_role) so cross-user cache reads are impossible.';

CREATE INDEX IF NOT EXISTS analytics_query_cache_expires
  ON public.analytics_query_cache (expires_at);

ALTER TABLE public.analytics_query_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS analytics_query_cache_service ON public.analytics_query_cache;
CREATE POLICY analytics_query_cache_service ON public.analytics_query_cache
  FOR ALL
  USING (current_setting('role', true) IN ('service_role', 'postgres'))
  WITH CHECK (current_setting('role', true) IN ('service_role', 'postgres'));

GRANT ALL ON public.analytics_query_cache TO service_role;

-- Cleanup helper: callable from a cron or inline before each cache write
CREATE OR REPLACE FUNCTION public.analytics_query_cache_purge_expired()
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH d AS (
    DELETE FROM public.analytics_query_cache
    WHERE expires_at < now()
    RETURNING 1
  )
  SELECT count(*)::integer FROM d
$$;

COMMENT ON FUNCTION public.analytics_query_cache_purge_expired() IS
  'Deletes cache rows past expires_at. Returns count of deleted rows. Called inline before each cache write + by the share-token-rotation cron.';

-- ----------------------------------------------------------------------------
-- 3. analytics_share_tokens — Umami share-token for iframe-fallback embed
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.analytics_share_tokens (
  property_id  uuid PRIMARY KEY REFERENCES public.analytics_properties(property_id) ON DELETE CASCADE,
  token        text NOT NULL,
  expires_at   timestamptz NOT NULL,
  rotated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.analytics_share_tokens IS
  'Optional Umami share-token cache for iframe-fallback dashboards. v1 has no admin UI for this; rotated daily by the analytics-share-token-rotation cron.';

CREATE INDEX IF NOT EXISTS analytics_share_tokens_expires
  ON public.analytics_share_tokens (expires_at);

ALTER TABLE public.analytics_share_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS analytics_share_tokens_service ON public.analytics_share_tokens;
CREATE POLICY analytics_share_tokens_service ON public.analytics_share_tokens
  FOR ALL
  USING (current_setting('role', true) IN ('service_role', 'postgres'))
  WITH CHECK (current_setting('role', true) IN ('service_role', 'postgres'));

GRANT ALL ON public.analytics_share_tokens TO service_role;
