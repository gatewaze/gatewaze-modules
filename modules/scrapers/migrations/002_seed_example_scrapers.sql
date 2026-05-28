-- ============================================================
-- Module: scrapers
-- Migration: 002_seed_example_scrapers
-- Description: Seed a few example Luma iCal scrapers to demonstrate
--              the scraper configuration shape. Replace or extend these
--              with your own communities/calendars. Idempotent on base_url.
-- ============================================================

-- Ensure content_category column exists (added formally in 003, but needed here for seed data)
ALTER TABLE public.scrapers ADD COLUMN IF NOT EXISTS content_category varchar(100);

INSERT INTO public.scrapers (name, description, scraper_type, object_type, event_type, base_url, enabled, account, content_category, config, schedule_enabled, schedule_frequency)
VALUES
  ('Example Community // London', '', 'LumaICalScraper', 'events', 'mixed', 'https://lu.ma/example-london', true, 'example', 'community', '{"past": true, "timezone": "UTC", "scrollTimeout": 5000, "maxScrollAttempts": 50, "titleFilters": ["Agent", "MCP"]}'::jsonb, true, 'daily'),
  ('Example Community // New York City', '', 'LumaICalScraper', 'events', 'mixed', 'https://lu.ma/example-nyc', true, 'example', 'community', '{"past": true, "timezone": "UTC", "scrollTimeout": 5000, "maxScrollAttempts": 50, "titleFilters": ["Agent", "MCP"]}'::jsonb, true, 'daily'),
  ('Example Community // San Francisco', '', 'LumaICalScraper', 'events', 'mixed', 'https://lu.ma/example-sf', true, 'example', 'community', '{"past": true, "timezone": "UTC", "scrollTimeout": 5000, "maxScrollAttempts": 50, "titleFilters": ["Agent", "MCP"]}'::jsonb, true, 'daily')
-- Must match the partial unique index on base_url (WHERE base_url IS NOT NULL).
-- All seed rows have non-null base_urls, so the predicate is satisfied.
ON CONFLICT (base_url) WHERE base_url IS NOT NULL DO NOTHING;
