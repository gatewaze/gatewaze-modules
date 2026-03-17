-- Competitions Module: Core Tables
-- Migration: 001_competitions_tables.sql

-- 1. Competitions
CREATE TABLE IF NOT EXISTS public.module_competitions (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft', -- draft, open, judging, closed
  entry_deadline timestamptz,
  max_entries integer,
  rules jsonb DEFAULT '{}'::jsonb,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. Competition entries
CREATE TABLE IF NOT EXISTS public.module_competition_entries (
  id bigserial PRIMARY KEY,
  competition_id bigint NOT NULL REFERENCES public.module_competitions(id) ON DELETE CASCADE,
  entrant_email text NOT NULL,
  entrant_name text,
  submission_data jsonb DEFAULT '{}'::jsonb,
  score numeric,
  status text NOT NULL DEFAULT 'submitted', -- submitted, reviewed, winner, disqualified
  judged_at timestamptz,
  submitted_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_competition_entries_comp ON public.module_competition_entries(competition_id);
CREATE INDEX IF NOT EXISTS idx_module_competition_entries_email ON public.module_competition_entries(entrant_email);

-- 3. RLS
ALTER TABLE public.module_competitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_competition_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_module_competitions" ON public.module_competitions FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_competition_entries" ON public.module_competition_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);
