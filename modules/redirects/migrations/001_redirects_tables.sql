-- Redirects Module: Core Tables
-- Migration: 001_redirects_tables.sql

-- 1. Redirects
CREATE TABLE IF NOT EXISTS public.module_redirects (
  id bigserial PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  destination_url text NOT NULL,
  title text,
  is_active boolean DEFAULT true,
  click_count integer DEFAULT 0,
  external_id text, -- Short.io link ID
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_redirects_slug ON public.module_redirects(slug);
CREATE INDEX IF NOT EXISTS idx_module_redirects_active ON public.module_redirects(is_active);

-- 2. Redirect click log
CREATE TABLE IF NOT EXISTS public.module_redirect_clicks (
  id bigserial PRIMARY KEY,
  redirect_id bigint NOT NULL REFERENCES public.module_redirects(id) ON DELETE CASCADE,
  referrer text,
  user_agent text,
  ip_hash text,
  clicked_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_redirect_clicks_redirect ON public.module_redirect_clicks(redirect_id);
CREATE INDEX IF NOT EXISTS idx_module_redirect_clicks_time ON public.module_redirect_clicks(clicked_at DESC);

-- 3. RLS
ALTER TABLE public.module_redirects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_redirect_clicks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_module_redirects" ON public.module_redirects FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_redirect_clicks" ON public.module_redirect_clicks FOR ALL TO authenticated USING (true) WITH CHECK (true);
