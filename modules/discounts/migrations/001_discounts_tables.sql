-- Discounts Module: Core Tables
-- Migration: 001_discounts_tables.sql

-- 1. Discount codes
CREATE TABLE IF NOT EXISTS public.module_discounts (
  id bigserial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  description text,
  discount_type text NOT NULL DEFAULT 'percentage', -- percentage, fixed
  discount_value numeric NOT NULL,
  max_uses integer,
  current_uses integer DEFAULT 0,
  valid_from timestamptz,
  valid_until timestamptz,
  is_active boolean DEFAULT true,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_discounts_code ON public.module_discounts(code);
CREATE INDEX IF NOT EXISTS idx_module_discounts_active ON public.module_discounts(is_active);

-- 2. Discount claims
CREATE TABLE IF NOT EXISTS public.module_discount_claims (
  id bigserial PRIMARY KEY,
  discount_id bigint NOT NULL REFERENCES public.module_discounts(id) ON DELETE CASCADE,
  claimed_by text NOT NULL,
  claimed_at timestamptz DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_module_discount_claims_discount ON public.module_discount_claims(discount_id);
CREATE INDEX IF NOT EXISTS idx_module_discount_claims_user ON public.module_discount_claims(claimed_by);

-- 3. RLS
ALTER TABLE public.module_discounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_discount_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_module_discounts" ON public.module_discounts FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_discount_claims" ON public.module_discount_claims FOR ALL TO authenticated USING (true) WITH CHECK (true);
