-- Scrapers Module: Core Tables
-- Migration: 001_scrapers_tables.sql

-- 1. Scraper configurations
CREATE TABLE IF NOT EXISTS public.module_scrapers (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  source_url text NOT NULL,
  scraper_type text NOT NULL DEFAULT 'event', -- event, content, general
  config jsonb DEFAULT '{}'::jsonb,
  is_active boolean DEFAULT true,
  last_run_at timestamptz,
  last_run_status text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. Scraper job history
CREATE TABLE IF NOT EXISTS public.module_scraper_runs (
  id bigserial PRIMARY KEY,
  scraper_id bigint NOT NULL REFERENCES public.module_scrapers(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running', -- running, completed, failed
  records_found integer DEFAULT 0,
  records_new integer DEFAULT 0,
  error text,
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_module_scraper_runs_scraper ON public.module_scraper_runs(scraper_id);
CREATE INDEX IF NOT EXISTS idx_module_scraper_runs_started ON public.module_scraper_runs(started_at DESC);

-- 3. RLS
ALTER TABLE public.module_scrapers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_scraper_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_module_scrapers" ON public.module_scrapers FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_scraper_runs" ON public.module_scraper_runs FOR ALL TO authenticated USING (true) WITH CHECK (true);
