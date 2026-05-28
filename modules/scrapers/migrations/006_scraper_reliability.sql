-- Migration: 006_scraper_reliability.sql
-- Adds reliability and observability features to the scraper module

-- Add reliability fields to scrapers_jobs
ALTER TABLE scrapers_jobs
  ADD COLUMN IF NOT EXISTS last_heartbeat timestamptz,
  ADD COLUMN IF NOT EXISTS timeout_at timestamptz,
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS retry_of integer REFERENCES scrapers_jobs(id);

-- Add per-scraper timeout config
ALTER TABLE scrapers
  ADD COLUMN IF NOT EXISTS timeout_minutes integer DEFAULT 30,
  ADD COLUMN IF NOT EXISTS alert_on_failure boolean DEFAULT true;

-- Index for finding stuck jobs (running but no heartbeat)
CREATE INDEX IF NOT EXISTS idx_scrapers_jobs_stuck
  ON scrapers_jobs(status, last_heartbeat)
  WHERE status = 'running';

-- Index for retry chains
CREATE INDEX IF NOT EXISTS idx_scrapers_jobs_retry_of
  ON scrapers_jobs(retry_of)
  WHERE retry_of IS NOT NULL;

-- RPC: Update heartbeat (called every 60s by running scrapers)
CREATE OR REPLACE FUNCTION scrapers_heartbeat(p_job_id integer, p_metadata jsonb DEFAULT NULL)
RETURNS void AS $$
BEGIN
  UPDATE scrapers_jobs
  SET last_heartbeat = now(),
      metadata = CASE
        WHEN p_metadata IS NOT NULL THEN p_metadata
        ELSE metadata
      END
  WHERE id = p_job_id;
END;
$$ LANGUAGE plpgsql;

-- RPC: Get stuck jobs (running but heartbeat stale)
CREATE OR REPLACE FUNCTION scrapers_get_stuck_jobs(stale_minutes integer DEFAULT 10)
RETURNS SETOF scrapers_jobs AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM scrapers_jobs
  WHERE status = 'running'
    AND (
      (last_heartbeat IS NULL AND started_at < now() - make_interval(mins => stale_minutes))
      OR
      (last_heartbeat IS NOT NULL AND last_heartbeat < now() - make_interval(mins => stale_minutes))
    );
END;
$$ LANGUAGE plpgsql;

-- RPC: Health summary for admin dashboard
CREATE OR REPLACE FUNCTION scrapers_health_summary()
RETURNS TABLE (
  total_scrapers integer,
  enabled_scrapers integer,
  running_jobs integer,
  stuck_jobs integer,
  failed_24h integer,
  completed_24h integer,
  avg_duration_minutes numeric
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT count(*)::integer FROM scrapers),
    (SELECT count(*)::integer FROM scrapers WHERE enabled = true),
    (SELECT count(*)::integer FROM scrapers_jobs WHERE status = 'running'),
    (SELECT count(*)::integer FROM scrapers_jobs
     WHERE status = 'running'
       AND (
         (last_heartbeat IS NULL AND started_at < now() - interval '10 minutes')
         OR (last_heartbeat IS NOT NULL AND last_heartbeat < now() - interval '10 minutes')
       )),
    (SELECT count(*)::integer FROM scrapers_jobs
     WHERE status = 'failed' AND created_at > now() - interval '24 hours'),
    (SELECT count(*)::integer FROM scrapers_jobs
     WHERE status = 'completed' AND created_at > now() - interval '24 hours'),
    (SELECT round(avg(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60)::numeric, 1)
     FROM scrapers_jobs
     WHERE status = 'completed' AND completed_at > now() - interval '24 hours');
END;
$$ LANGUAGE plpgsql;
