-- Update scrapers_get_with_status RPC to include content_category field.

DROP FUNCTION IF EXISTS public.scrapers_get_with_status();

CREATE OR REPLACE FUNCTION public.scrapers_get_with_status()
RETURNS TABLE(
  id integer,
  name text,
  description text,
  scraper_type text,
  event_type text,
  content_category varchar,
  base_url text,
  enabled boolean,
  last_run timestamp without time zone,
  last_success timestamp without time zone,
  last_error text,
  total_items_scraped integer,
  config jsonb,
  schedule_enabled boolean,
  schedule_frequency varchar,
  next_scheduled_run timestamptz,
  object_type text,
  account text,
  latest_job_id integer,
  latest_job_status text,
  latest_job_started_at timestamp without time zone
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    s.id,
    s.name,
    s.description,
    s.scraper_type,
    s.event_type,
    s.content_category,
    s.base_url,
    s.enabled,
    s.last_run,
    s.last_success,
    s.last_error,
    s.total_items_scraped,
    s.config,
    s.schedule_enabled,
    s.schedule_frequency::varchar,
    s.next_scheduled_run,
    s.object_type,
    s.account,
    lj.id as latest_job_id,
    lj.status as latest_job_status,
    lj.started_at as latest_job_started_at
  FROM scrapers s
  LEFT JOIN LATERAL (
    SELECT sj.id, sj.status, sj.started_at
    FROM scrapers_jobs sj
    WHERE sj.scraper_id = s.id
    ORDER BY sj.started_at DESC
    LIMIT 1
  ) lj ON true
  ORDER BY s.name;
$$;
