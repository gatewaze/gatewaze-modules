-- Bulk Emailing Module: Core Tables
-- Migration: 001_bulk_emailing_tables.sql

-- 1. Bulk email campaigns
CREATE TABLE IF NOT EXISTS public.module_bulk_email_campaigns (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  subject text NOT NULL,
  from_email text NOT NULL,
  from_name text,
  template_id text,
  html_content text,
  status text NOT NULL DEFAULT 'draft', -- draft, sending, sent, failed
  recipient_count integer DEFAULT 0,
  sent_count integer DEFAULT 0,
  failed_count integer DEFAULT 0,
  segment_id bigint, -- optional link to a segment
  metadata jsonb DEFAULT '{}'::jsonb,
  scheduled_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_bulk_email_campaigns_status ON public.module_bulk_email_campaigns(status);

-- 2. Bulk email recipients
CREATE TABLE IF NOT EXISTS public.module_bulk_email_recipients (
  id bigserial PRIMARY KEY,
  campaign_id bigint NOT NULL REFERENCES public.module_bulk_email_campaigns(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text,
  status text NOT NULL DEFAULT 'pending', -- pending, sent, failed, bounced
  variables jsonb DEFAULT '{}'::jsonb,
  sent_at timestamptz,
  error text
);

CREATE INDEX IF NOT EXISTS idx_module_bulk_email_recipients_campaign ON public.module_bulk_email_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_module_bulk_email_recipients_email ON public.module_bulk_email_recipients(email);

-- 3. RLS
ALTER TABLE public.module_bulk_email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_bulk_email_recipients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_module_bulk_email_campaigns" ON public.module_bulk_email_campaigns FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_bulk_email_recipients" ON public.module_bulk_email_recipients FOR ALL TO authenticated USING (true) WITH CHECK (true);
