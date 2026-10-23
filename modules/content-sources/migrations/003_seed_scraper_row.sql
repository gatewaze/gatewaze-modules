-- ============================================================================
-- Module: content-sources
-- Migration: 003_seed_scraper_row
-- Description: one Scrapers-dashboard row runs every active discovery
--              source. Daily 05:30 UTC, after the AAIF blog scraper's 05:00
--              so the two never work the same rows at once. Idempotent by
--              scraper_type.
-- ============================================================================
INSERT INTO public.scrapers
  (name, description, scraper_type, event_type, base_url, enabled,
   schedule_enabled, schedule_frequency, schedule_time, timezone, object_type,
   content_category, default_publish_state, config)
SELECT
  'Discovery feeds',
  'Sweeps every active discovery source (Content → Sources) and lands new posts in the blog module as pending_review. Managed in Content → Sources; run here.',
  'FeedScraper',
  'blog',
  NULL,
  true,
  true,
  'daily',
  '05:30'::time,
  'UTC',
  'blog',
  'ecosystem',
  'pending_review',
  jsonb_build_object(
    'concurrency', 16,
    'per_host', 2,
    'lookback_days', 21,
    'body_fetch_cap', 200,
    'sitemap_page_cap', 60,
    'run_budget_minutes', 20
  )
WHERE NOT EXISTS (SELECT 1 FROM public.scrapers WHERE scraper_type = 'FeedScraper');
