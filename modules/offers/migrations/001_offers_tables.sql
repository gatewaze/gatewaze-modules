-- Offers Module: Core Tables
-- Migration: 001_offers_tables.sql

-- 1. Offers
CREATE TABLE IF NOT EXISTS public.module_offers (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  description text,
  offer_type text NOT NULL DEFAULT 'general',
  status text NOT NULL DEFAULT 'draft', -- draft, active, expired
  valid_from timestamptz,
  valid_until timestamptz,
  max_acceptances integer,
  current_acceptances integer DEFAULT 0,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_offers_status ON public.module_offers(status);

-- 2. Offer acceptances
CREATE TABLE IF NOT EXISTS public.module_offer_acceptances (
  id bigserial PRIMARY KEY,
  offer_id bigint NOT NULL REFERENCES public.module_offers(id) ON DELETE CASCADE,
  acceptee_email text NOT NULL,
  acceptee_name text,
  accepted_at timestamptz DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_module_offer_acceptances_offer ON public.module_offer_acceptances(offer_id);
CREATE INDEX IF NOT EXISTS idx_module_offer_acceptances_email ON public.module_offer_acceptances(acceptee_email);

-- 3. RLS
ALTER TABLE public.module_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_offer_acceptances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_module_offers" ON public.module_offers FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_offer_acceptances" ON public.module_offer_acceptances FOR ALL TO authenticated USING (true) WITH CHECK (true);
