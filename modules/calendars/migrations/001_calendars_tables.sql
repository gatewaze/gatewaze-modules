-- Calendars Module: Core Tables
-- Migration: 001_calendars_tables.sql

-- 1. Calendars
CREATE TABLE IF NOT EXISTS public.module_calendars (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  description text,
  source_url text,
  is_active boolean DEFAULT true,
  last_synced_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. Calendar events (discovered/imported)
CREATE TABLE IF NOT EXISTS public.module_calendar_events (
  id bigserial PRIMARY KEY,
  calendar_id bigint NOT NULL REFERENCES public.module_calendars(id) ON DELETE CASCADE,
  external_id text,
  title text NOT NULL,
  description text,
  start_time timestamptz NOT NULL,
  end_time timestamptz,
  location text,
  url text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE(calendar_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_module_calendar_events_calendar ON public.module_calendar_events(calendar_id);
CREATE INDEX IF NOT EXISTS idx_module_calendar_events_start ON public.module_calendar_events(start_time);

-- 3. RLS
ALTER TABLE public.module_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_calendar_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_module_calendars" ON public.module_calendars FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_calendar_events" ON public.module_calendar_events FOR ALL TO authenticated USING (true) WITH CHECK (true);
