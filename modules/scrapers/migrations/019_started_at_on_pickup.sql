-- =====================================================================
-- Module: scrapers
-- Migration: 019_started_at_on_pickup
-- =====================================================================
-- The Recent Jobs UI displays Duration as completed_at - started_at, but
-- scrapers_jobs.started_at was declared `timestamp DEFAULT now()` in 001
-- and nothing ever updates it when the worker actually picks the job up
-- — so started_at == created_at for every row, and the displayed
-- "Duration" is actually queue-wait + run time. With WORKER_CONCURRENCY=2
-- and a 50+-job burst from the scheduler, the *last* job's "Duration"
-- shows as ~7 hours even when the scrape itself ran in ~2 minutes
-- (real symptom seen on community calendar scrapers).
--
-- Fix:
--   * Drop the DEFAULT now() so newly-inserted jobs have NULL started_at
--     until the worker dequeues them.
--   * Have scrapers_update_job set started_at = now() on the
--     created → running transition (and only that transition — guard
--     with a NULL check so manual reruns don't reset it).
--
-- Backfill is intentionally omitted: existing rows keep their misleading
-- started_at since they're done; only future runs are corrected.
-- =====================================================================

ALTER TABLE public.scrapers_jobs ALTER COLUMN started_at DROP DEFAULT;

CREATE OR REPLACE FUNCTION public.scrapers_update_job(
    job_id integer,
    new_status text,
    items_found_count integer DEFAULT NULL,
    items_processed_count integer DEFAULT NULL,
    items_skipped_count integer DEFAULT NULL,
    items_failed_count integer DEFAULT NULL,
    error_msg text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.scrapers_jobs
  SET
    status = new_status,
    -- Stamp started_at the first time a job transitions into a running
    -- state. Guard with COALESCE-IS-NULL so re-tries via stalled-job
    -- recovery don't shift the run-start under us.
    started_at = CASE
      WHEN new_status = 'running' AND started_at IS NULL THEN NOW()
      ELSE started_at
    END,
    completed_at = CASE
      WHEN new_status IN ('completed', 'failed', 'cancelled') THEN NOW()
      ELSE completed_at
    END,
    items_found = COALESCE(items_found_count, items_found),
    items_processed = COALESCE(items_processed_count, items_processed),
    items_skipped = COALESCE(items_skipped_count, items_skipped),
    items_failed = COALESCE(items_failed_count, items_failed),
    error_message = COALESCE(error_msg, error_message)
  WHERE id = scrapers_update_job.job_id;

  IF new_status IN ('completed', 'failed') THEN
    UPDATE public.scrapers s
    SET
      last_run = NOW(),
      last_success = CASE WHEN new_status = 'completed' THEN NOW() ELSE s.last_success END,
      last_error = CASE WHEN new_status = 'failed' THEN error_msg ELSE s.last_error END,
      total_items_scraped = s.total_items_scraped + COALESCE(items_processed_count, 0)
    FROM public.scrapers_jobs j
    WHERE s.id = j.scraper_id AND j.id = scrapers_update_job.job_id;
  END IF;
END;
$$;
