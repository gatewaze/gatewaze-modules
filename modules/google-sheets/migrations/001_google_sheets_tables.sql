-- ============================================================================
-- Module: google-sheets
-- Migration: 001_google_sheets_tables
-- Description: Google Sheets integration - per-event notification configs
--              (registration / speaker_submission sync) with OAuth tokens,
--              and a log table for tracking sync operations.
-- ============================================================================

-- ==========================================================================
-- 1. Event Google Sheets notifications (per-event config)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.event_google_sheets_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id varchar(10) NOT NULL REFERENCES public.events(event_id) ON DELETE CASCADE,
  notification_type text NOT NULL CHECK (notification_type IN ('registration', 'speaker_submission')),
  enabled boolean DEFAULT false,
  spreadsheet_id text,
  spreadsheet_name text,
  sheet_name text DEFAULT 'Sheet1',
  column_mapping jsonb,
  google_access_token text,
  google_refresh_token text,
  google_token_expires_at timestamptz,
  google_user_email text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(event_id, notification_type)
);

CREATE TRIGGER google_sheets_notifications_updated_at
  BEFORE UPDATE ON public.event_google_sheets_notifications
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.event_google_sheets_notifications IS 'Per-event Google Sheets sync configuration with embedded OAuth tokens';

-- ==========================================================================
-- 2. Google Sheets notification logs
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.google_sheets_notification_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id varchar(10) NOT NULL,
  notification_type text NOT NULL,
  spreadsheet_id text,
  sheet_name text,
  trigger_entity_type text,
  trigger_entity_id uuid,
  status text CHECK (status IN ('sent', 'failed', 'updated')),
  error_message text,
  row_data jsonb,
  row_number integer,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_google_sheets_logs_event_created
  ON public.google_sheets_notification_logs(event_id, created_at DESC);

COMMENT ON TABLE public.google_sheets_notification_logs IS 'Audit log for Google Sheets sync operations';

-- ==========================================================================
-- 3. RLS
-- ==========================================================================
ALTER TABLE public.event_google_sheets_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_sheets_notification_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_event_google_sheets" ON public.event_google_sheets_notifications FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_google_sheets_logs" ON public.google_sheets_notification_logs FOR ALL TO authenticated USING (true) WITH CHECK (true);
