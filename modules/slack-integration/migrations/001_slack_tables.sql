-- Slack Integration Module: Core Tables
-- Migration: 001_slack_tables.sql

-- 1. Slack webhook configs
CREATE TABLE IF NOT EXISTS public.module_slack_webhooks (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  channel_id text NOT NULL,
  channel_name text,
  webhook_url text,
  event_types text[] DEFAULT '{}',
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. Slack notification log
CREATE TABLE IF NOT EXISTS public.module_slack_notifications (
  id bigserial PRIMARY KEY,
  webhook_id bigint REFERENCES public.module_slack_webhooks(id) ON DELETE SET NULL,
  channel text NOT NULL,
  message_type text,
  payload jsonb DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'sent', -- sent, failed, pending
  error text,
  sent_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_slack_notifications_webhook ON public.module_slack_notifications(webhook_id);
CREATE INDEX IF NOT EXISTS idx_module_slack_notifications_sent ON public.module_slack_notifications(sent_at DESC);

-- 3. RLS
ALTER TABLE public.module_slack_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_slack_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_module_slack_webhooks" ON public.module_slack_webhooks FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_slack_notifications" ON public.module_slack_notifications FOR ALL TO authenticated USING (true) WITH CHECK (true);
