-- ============================================================================
-- Module: scrapers
-- Migration: 022_create_job_metadata
-- Description: let a caller attach per-job options when creating a job.
--              scrapers_jobs.metadata already exists (006) and nothing fills
--              it at creation. It is an AUDIT copy: the handler reads per-job
--              options from the BullMQ payload (server-written), never from
--              this column, because scrapers_jobs is writable by any
--              authenticated user under its RLS. First use: the
--              content-sources FeedScraper running one source from its tab.
--
-- The 2-argument function is REPLACED by one 3-argument function with a
-- default, not overloaded: two functions differing only in a defaulted
-- argument make PostgREST reject every call as ambiguous (PGRST203, the
-- newsletter snapshot cron incident). Existing callers that pass two
-- arguments keep working.
-- ============================================================================
DROP FUNCTION IF EXISTS public.scrapers_create_job(integer[], text);

CREATE OR REPLACE FUNCTION public.scrapers_create_job(
    scraper_ids integer[],
    created_by_user text DEFAULT 'scheduler',
    p_metadata jsonb DEFAULT NULL
) RETURNS TABLE(job_id integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY
    INSERT INTO public.scrapers_jobs (scraper_id, status, created_by, metadata)
    SELECT unnest(scraper_ids), 'pending', created_by_user, p_metadata
    RETURNING id AS job_id;
END;
$$;

-- DROP + CREATE resets the ACL to the default (which includes PUBLIC/anon on
-- Supabase); say exactly who may call it.
REVOKE ALL ON FUNCTION public.scrapers_create_job(integer[], text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.scrapers_create_job(integer[], text, jsonb) TO authenticated, service_role;
