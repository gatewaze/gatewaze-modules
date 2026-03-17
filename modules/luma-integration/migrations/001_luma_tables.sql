-- Luma Integration Module: Core Tables
-- Migration: 001_luma_tables.sql

-- 1. Luma events (synced)
CREATE TABLE IF NOT EXISTS public.module_luma_events (
  id bigserial PRIMARY KEY,
  luma_event_id text UNIQUE NOT NULL,
  name text NOT NULL,
  description text,
  start_time timestamptz,
  end_time timestamptz,
  location text,
  url text,
  last_synced_at timestamptz DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_luma_events_luma_id ON public.module_luma_events(luma_event_id);

-- 2. Luma registrations (synced)
CREATE TABLE IF NOT EXISTS public.module_luma_registrations (
  id bigserial PRIMARY KEY,
  luma_event_id text NOT NULL,
  registrant_email text NOT NULL,
  registrant_name text,
  status text NOT NULL DEFAULT 'registered',
  registered_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE(luma_event_id, registrant_email)
);

CREATE INDEX IF NOT EXISTS idx_module_luma_registrations_event ON public.module_luma_registrations(luma_event_id);
CREATE INDEX IF NOT EXISTS idx_module_luma_registrations_email ON public.module_luma_registrations(registrant_email);

-- 3. Luma webhook log
CREATE TABLE IF NOT EXISTS public.module_luma_webhook_log (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  payload jsonb DEFAULT '{}'::jsonb,
  processed boolean DEFAULT false,
  received_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_luma_webhook_log_type ON public.module_luma_webhook_log(event_type);

-- 4. RLS
ALTER TABLE public.module_luma_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_luma_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_luma_webhook_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_module_luma_events" ON public.module_luma_events FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_luma_registrations" ON public.module_luma_registrations FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_luma_webhook_log" ON public.module_luma_webhook_log FOR ALL TO authenticated USING (true) WITH CHECK (true);
