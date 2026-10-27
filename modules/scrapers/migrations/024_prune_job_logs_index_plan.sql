-- ==========================================================================
-- 024: scrapers_prune_job_logs must pick its victims through the job index
-- ==========================================================================
-- The one-off backlog prune on AAIF prod (27 Oct 2026) stalled after about
-- 52M of 161M rows. Every call, even for 10k rows, hit the 110 s statement
-- timeout. EXPLAIN showed why. The victims subquery of 023 is
--
--   SELECT l.id FROM scrapers_job_logs l WHERE l.job_id = ANY (v_job_ids) LIMIT n
--
-- Once autoanalyze had run mid-prune, the ten candidate job ids were in the
-- most-common-values list of job_id with a few hundred thousand rows each,
-- so the planner estimated millions of matches and chose a sequential scan
-- of the 35 GB heap, expecting to fill the LIMIT within the first pages. The
-- rows of those jobs are not at the front of the heap, and most of the pages
-- it walked held only dead tuples from the earlier batches, so each call
-- read gigabytes before finding its first 10k rows.
--
-- Two changes, both aimed at the same statement:
--
-- 1. ORDER BY l.job_id on the victims subquery. idx_scrapers_job_logs_job
--    already returns rows in that order, so the index scan satisfies the
--    ORDER BY plus LIMIT for free, while a sequential scan would now also
--    need a full sort. On AAIF prod this alone flips the plan to the index.
-- 2. enable_seqscan = off for the duration of the function. The function
--    only touches scrapers_jobs (12k rows, read by primary key) and
--    scrapers_job_logs (read by job_id and primary key), so there is no
--    statement in it where a sequential scan is the right answer, and this
--    keeps the plan stable if statistics drift again.
--
-- Same signature and return type as 023, so CREATE OR REPLACE keeps the
-- grants. The REVOKE/GRANT lines are repeated anyway so this file is
-- complete on its own.

CREATE OR REPLACE FUNCTION public.scrapers_prune_job_logs(
  p_retention_days integer DEFAULT 7,
  p_max_rows integer DEFAULT 20000
)
RETURNS TABLE(jobs_touched integer, rows_deleted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET enable_seqscan = off
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

  -- ORDER BY job_id is what makes the planner walk idx_scrapers_job_logs_job
  -- for the LIMIT instead of scanning the heap. See the header.
  WITH victims AS (
    SELECT l.id
    FROM public.scrapers_job_logs l
    WHERE l.job_id = ANY (v_job_ids)
    ORDER BY l.job_id
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

REVOKE ALL ON FUNCTION public.scrapers_prune_job_logs(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.scrapers_prune_job_logs(integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scrapers_prune_job_logs(integer, integer) TO service_role;
