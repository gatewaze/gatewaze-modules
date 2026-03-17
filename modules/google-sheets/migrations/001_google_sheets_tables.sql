-- Google Sheets Integration Module: Core Tables
-- Migration: 001_google_sheets_tables.sql

-- 1. Google Sheets OAuth tokens
CREATE TABLE IF NOT EXISTS public.module_google_sheets_tokens (
  id bigserial PRIMARY KEY,
  admin_id text NOT NULL,
  access_token text NOT NULL,
  refresh_token text,
  token_expiry timestamptz,
  scopes text[],
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_google_sheets_tokens_admin ON public.module_google_sheets_tokens(admin_id);

-- 2. Connected spreadsheets
CREATE TABLE IF NOT EXISTS public.module_google_sheets_connections (
  id bigserial PRIMARY KEY,
  spreadsheet_id text NOT NULL,
  spreadsheet_name text,
  sheet_name text,
  sync_type text NOT NULL DEFAULT 'manual', -- manual, auto, webhook
  sync_direction text NOT NULL DEFAULT 'export', -- export, import, bidirectional
  last_synced_at timestamptz,
  config jsonb DEFAULT '{}'::jsonb,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_google_sheets_connections_sheet ON public.module_google_sheets_connections(spreadsheet_id);

-- 3. RLS
ALTER TABLE public.module_google_sheets_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_google_sheets_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_module_google_sheets_tokens" ON public.module_google_sheets_tokens FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_google_sheets_connections" ON public.module_google_sheets_connections FOR ALL TO authenticated USING (true) WITH CHECK (true);
