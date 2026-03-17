-- Newsletters Module: Core Tables
-- Migration: 001_newsletters_tables.sql

-- 1. Newsletters
CREATE TABLE IF NOT EXISTS public.module_newsletters (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft', -- draft, active, archived
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. Newsletter editions
CREATE TABLE IF NOT EXISTS public.module_newsletter_editions (
  id bigserial PRIMARY KEY,
  newsletter_id bigint NOT NULL REFERENCES public.module_newsletters(id) ON DELETE CASCADE,
  title text NOT NULL,
  subject text,
  html_content text,
  status text NOT NULL DEFAULT 'draft', -- draft, scheduled, sent
  scheduled_at timestamptz,
  sent_at timestamptz,
  recipient_count integer DEFAULT 0,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_newsletter_editions_newsletter ON public.module_newsletter_editions(newsletter_id);
CREATE INDEX IF NOT EXISTS idx_module_newsletter_editions_status ON public.module_newsletter_editions(status);

-- 3. Newsletter subscribers
CREATE TABLE IF NOT EXISTS public.module_newsletter_subscribers (
  id bigserial PRIMARY KEY,
  newsletter_id bigint NOT NULL REFERENCES public.module_newsletters(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text,
  status text NOT NULL DEFAULT 'active', -- active, unsubscribed, bounced
  subscribed_at timestamptz DEFAULT now(),
  unsubscribed_at timestamptz,
  UNIQUE(newsletter_id, email)
);

CREATE INDEX IF NOT EXISTS idx_module_newsletter_subscribers_newsletter ON public.module_newsletter_subscribers(newsletter_id);
CREATE INDEX IF NOT EXISTS idx_module_newsletter_subscribers_email ON public.module_newsletter_subscribers(email);

-- 4. RLS
ALTER TABLE public.module_newsletters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_newsletter_editions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_newsletter_subscribers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_module_newsletters" ON public.module_newsletters FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_newsletter_editions" ON public.module_newsletter_editions FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_newsletter_subscribers" ON public.module_newsletter_subscribers FOR ALL TO authenticated USING (true) WITH CHECK (true);
