-- ==========================================================================
-- 023: scrapers_job_logs retention
-- ==========================================================================
-- scrapers_job_logs is the per-line log of every scrape run. Nothing reads
-- it except the admin "view logs" modal for a single job, yet on AAIF prod
-- it reached 35 GB / 161M rows, half the database. This function deletes
-- the log lines of jobs older than a retention window, a bounded number of
-- ROWS per call, so a worker can loop over it without holding a long lock
-- or a long transaction. The scrapers_jobs summary rows are kept.
--
-- Why rows and not jobs: log volume per job is very skewed (AAIF prod,
-- Oct 2026: median 149 lines, p99 282k, max 462k), and the worker reaches
-- this function through PostgREST, whose authenticator session carries an
-- 8 s statement_timeout that service_role inherits. A batch counted in
-- jobs could not promise to finish inside that; a batch of 20k rows can.
--
-- Candidate jobs come from scrapers_jobs (12k rows) rather than from the
-- log lines, so every call is driven by scrapers_jobs_pkey plus
-- idx_scrapers_job_logs_job and never needs an index on
-- scrapers_job_logs.created_at. The EXISTS filter makes a call on a table
-- with nothing left to prune return immediately. A job whose lines were
-- only partly deleted last call still has lines, so it is simply picked
-- again.
--
-- scrapers_jobs.created_at is timestamp WITHOUT time zone, written by
-- now() on a UTC server, so the cutoff is computed in UTC to match.

-- New in this migration; the DROP only matters for a re-run during review.
DROP FUNCTION IF EXISTS public.scrapers_prune_job_logs(integer, integer);

CREATE FUNCTION public.scrapers_prune_job_logs(
  p_retention_days integer DEFAULT 7,
  p_max_rows integer DEFAULT 20000
)
RETURNS TABLE(jobs_touched integer, rows_deleted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cutoff  timestamp;
  v_job_ids integer[];
  v_rows    bigint;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 1 THEN
    RAISE EXCEPTION 'p_retention_days must be an integer >= 1 (got %)', p_retention_days;
  END IF;
  IF p_max_rows IS NULL OR p_max_rows < 1 OR p_max_rows > 1000000 THEN
    RAISE EXCEPTION 'p_max_rows must be between 1 and 1000000 (got %)', p_max_rows;
  END IF;

  v_cutoff := (now() AT TIME ZONE 'utc') - make_interval(days => p_retention_days);

  -- Up to ten of the oldest eligible jobs that still have log lines.
  SELECT array_agg(s.id) INTO v_job_ids
  FROM (
    SELECT j.id
    FROM public.scrapers_jobs j
    WHERE j.created_at < v_cutoff
      AND EXISTS (SELECT 1 FROM public.scrapers_job_logs l WHERE l.job_id = j.id)
    ORDER BY j.id
    LIMIT 10
  ) s;

  IF v_job_ids IS NULL THEN
    jobs_touched := 0;
    rows_deleted := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  WITH victims AS (
    SELECT l.id
    FROM public.scrapers_job_logs l
    WHERE l.job_id = ANY (v_job_ids)
    LIMIT p_max_rows
  )
  DELETE FROM public.scrapers_job_logs d
  USING victims v
  WHERE d.id = v.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  jobs_touched := cardinality(v_job_ids);
  rows_deleted := v_rows;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.scrapers_prune_job_logs(integer, integer) IS
  'Deletes up to p_max_rows scrapers_job_logs rows belonging to jobs created more than p_retention_days ago. Call repeatedly until rows_deleted = 0. Worker-only.';

-- Deleting data is a worker job, never something a browser session may call.
REVOKE ALL ON FUNCTION public.scrapers_prune_job_logs(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.scrapers_prune_job_logs(integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scrapers_prune_job_logs(integer, integer) TO service_role;
