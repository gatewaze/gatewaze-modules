-- ============================================================================
-- Module: scrapers
-- Migration: 018_fast_vs_slow_comparison
-- Description: Pair LumaICal/Search/Category scrapers with their *Fast
--              variants targeting the same calendar, and aggregate recent
--              job stats per pair so operators can decide promotion.
--              See spec-scrapling-fetcher-service.md §6.2.
-- ============================================================================

-- Normalize a base_url into a canonical pair key:
--   - prefer the explicit ical_id when present (globally unique on Luma)
--   - otherwise lowercase + strip http(s):// + collapse luma.com↔lu.ma
--     + trim trailing slashes
-- IMMUTABLE so the join-on-function-result is index-friendly.
CREATE OR REPLACE FUNCTION public.scrapers_normalize_pair_key(
  p_base_url text,
  p_ical_id  text
) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT COALESCE(
    NULLIF(LOWER(BTRIM(p_ical_id)), ''),
    REGEXP_REPLACE(
      REGEXP_REPLACE(
        REGEXP_REPLACE(LOWER(BTRIM(p_base_url)), '^https?://', ''),
        '^luma\.com/', 'lu.ma/'
      ),
      '/+$', ''
    )
  );
$$;

CREATE OR REPLACE VIEW public.scrapers_variant_pairs AS
SELECT
  slow.id           AS slow_id,
  slow.name         AS slow_name,
  slow.scraper_type AS slow_type,
  slow.enabled      AS slow_enabled,
  fast.id           AS fast_id,
  fast.name         AS fast_name,
  fast.scraper_type AS fast_type,
  fast.enabled      AS fast_enabled,
  scrapers_normalize_pair_key(slow.base_url, slow.config->>'ical_id') AS pairing_key
FROM public.scrapers slow
JOIN public.scrapers fast
  ON scrapers_normalize_pair_key(slow.base_url, slow.config->>'ical_id')
   = scrapers_normalize_pair_key(fast.base_url, fast.config->>'ical_id')
WHERE slow.scraper_type IN ('LumaICalScraper','LumaSearchScraper','LumaCategoryScraper')
  AND fast.scraper_type IN ('LumaICalScraperFast','LumaSearchScraperFast','LumaCategoryScraperFast')
  AND slow.scraper_type || 'Fast' = fast.scraper_type;

COMMENT ON VIEW public.scrapers_variant_pairs IS
  'Pairs of (slow, fast) Luma scrapers that target the same calendar; used by the comparison admin page.';

-- Aggregate recent jobs per pair. SECURITY INVOKER so RLS on scrapers /
-- scraper_jobs applies as normal — the existing admin role can already
-- read both, no new grants needed.
CREATE OR REPLACE FUNCTION public.scrapers_compare_variants(
  p_window_days int DEFAULT 7
)
RETURNS TABLE (
  slow_id              integer,
  slow_name            text,
  slow_type            text,
  slow_enabled         boolean,
  fast_id              integer,
  fast_name            text,
  fast_type            text,
  fast_enabled         boolean,
  pairing_key          text,
  slow_runs            bigint,
  fast_runs            bigint,
  slow_avg_duration_s  numeric,
  fast_avg_duration_s  numeric,
  slow_avg_items       numeric,
  fast_avg_items       numeric,
  slow_success_rate    numeric,
  fast_success_rate    numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH slow_stats AS (
    SELECT
      sj.scraper_id,
      COUNT(*)                                                      AS runs,
      AVG(EXTRACT(EPOCH FROM (sj.completed_at - sj.started_at)))    AS avg_duration_s,
      AVG(COALESCE(sj.items_processed, 0))                          AS avg_items,
      AVG(CASE WHEN sj.status = 'completed' THEN 1.0 ELSE 0.0 END)  AS success_rate
    FROM public.scrapers_jobs sj
    WHERE sj.completed_at IS NOT NULL
      AND sj.completed_at > now() - (p_window_days || ' days')::interval
    GROUP BY sj.scraper_id
  )
  SELECT
    p.slow_id, p.slow_name, p.slow_type, p.slow_enabled,
    p.fast_id, p.fast_name, p.fast_type, p.fast_enabled,
    p.pairing_key,
    COALESCE(s.runs, 0)              AS slow_runs,
    COALESCE(f.runs, 0)              AS fast_runs,
    s.avg_duration_s                 AS slow_avg_duration_s,
    f.avg_duration_s                 AS fast_avg_duration_s,
    s.avg_items                      AS slow_avg_items,
    f.avg_items                      AS fast_avg_items,
    s.success_rate                   AS slow_success_rate,
    f.success_rate                   AS fast_success_rate
  FROM public.scrapers_variant_pairs p
  LEFT JOIN slow_stats s ON s.scraper_id = p.slow_id
  LEFT JOIN slow_stats f ON f.scraper_id = p.fast_id
  ORDER BY p.slow_name;
$$;

GRANT EXECUTE ON FUNCTION public.scrapers_compare_variants(int) TO authenticated;
