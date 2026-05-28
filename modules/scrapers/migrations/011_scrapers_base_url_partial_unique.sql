-- Relax scrapers.base_url uniqueness.
--
-- Problem: URL-less scraper types (LumaSearchScraper, LumaHostEnricher) don't
-- target a specific URL — they operate on the whole site or on DB rows. They
-- all end up sharing a root like `https://lu.ma`, which blows up the existing
-- full-column UNIQUE(base_url) constraint.
--
-- Fix: drop the plain unique, recreate as a partial unique index that only
-- applies when base_url is NOT NULL. URL-less scrapers store NULL base_url
-- and can coexist freely; URL-targeted scrapers (LumaICalScraper pointing at
-- a specific calendar) still get proper duplicate protection.

ALTER TABLE public.scrapers
  DROP CONSTRAINT IF EXISTS scrapers_base_url_unique;

CREATE UNIQUE INDEX IF NOT EXISTS scrapers_base_url_unique
  ON public.scrapers (base_url)
  WHERE base_url IS NOT NULL;
