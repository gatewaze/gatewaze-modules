-- ============================================================================
-- Module: scrapers
-- Migration: 013_scrapers_base_url_nullable
-- Description: Make scrapers.base_url nullable so URL-less scraper types
--              (Luma Search, Host Enricher) can save with NULL. The table
--              was originally created with `base_url text` (nullable) in
--              migration 001, but some instances had the table already
--              in place with a stricter NOT NULL constraint — and since
--              001 uses CREATE TABLE IF NOT EXISTS, the earlier
--              definition stuck. Editing a Luma Search scraper in admin
--              then hits 23502.
--              Intent matches the partial unique index created in 001:
--                `CREATE UNIQUE INDEX … ON scrapers (base_url)
--                   WHERE base_url IS NOT NULL;`
--              which explicitly contemplates nullable entries.
-- ============================================================================

ALTER TABLE public.scrapers
  ALTER COLUMN base_url DROP NOT NULL;
