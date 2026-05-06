-- ============================================================================
-- Module: cost-governance
-- Migration: 001_external_api_usage
-- Description: Universal cost ledger for external paid APIs (residential
--              proxies, Anthropic, OpenAI). Per-brand budgets with soft +
--              hard caps. See spec-scrapling-fetcher-service.md §15.
-- ============================================================================

-- ==========================================================================
-- 1. Ledger table
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.external_api_usage (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  brand_id        text NOT NULL,
  provider        text NOT NULL,
  product         text NOT NULL,
  feature         text NOT NULL,
  units_in        bigint NOT NULL DEFAULT 0,
  units_out       bigint NOT NULL DEFAULT 0,
  cost_usd        numeric(12, 6) NOT NULL,
  request_id      text,
  context         jsonb DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.external_api_usage IS
  'Per-call ledger of paid external API usage. Cost computed at call time.';

CREATE INDEX IF NOT EXISTS idx_eau_brand_provider_time
  ON public.external_api_usage (brand_id, provider, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_eau_feature_time
  ON public.external_api_usage (feature, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_eau_time
  ON public.external_api_usage (occurred_at DESC);

-- RLS: only admins read; writes go through SECURITY DEFINER RPC below.
ALTER TABLE public.external_api_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS eau_admin_read ON public.external_api_usage;
CREATE POLICY eau_admin_read ON public.external_api_usage
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_users WHERE admin_users.id = auth.uid()
    )
  );

-- ==========================================================================
-- 2. Per-brand budgets
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.external_api_budgets (
  brand_id        text NOT NULL,
  provider        text NOT NULL, -- '*' = all providers for this brand
  period          text NOT NULL CHECK (period IN ('daily', 'monthly')),
  soft_cap_usd    numeric(12, 2) NOT NULL,
  hard_cap_usd    numeric(12, 2),
  notes           text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_id, provider, period)
);

COMMENT ON TABLE public.external_api_budgets IS
  'Soft + hard spending caps per brand × provider × period.';

ALTER TABLE public.external_api_budgets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS eab_admin_read ON public.external_api_budgets;
CREATE POLICY eab_admin_read ON public.external_api_budgets
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.admin_users WHERE admin_users.id = auth.uid())
  );
DROP POLICY IF EXISTS eab_admin_write ON public.external_api_budgets;
CREATE POLICY eab_admin_write ON public.external_api_budgets
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.admin_users WHERE admin_users.id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.admin_users WHERE admin_users.id = auth.uid())
  );

-- ==========================================================================
-- 3. record_external_api_usage RPC
--
-- Inserts a ledger row, computes the new period total, and returns the
-- budget status in one roundtrip. SECURITY DEFINER so service-role and
-- Edge functions can write without granting the table directly.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.record_external_api_usage(
  p_brand_id    text,
  p_provider    text,
  p_product     text,
  p_feature     text,
  p_units_in    bigint,
  p_units_out   bigint,
  p_cost_usd    numeric,
  p_request_id  text DEFAULT NULL,
  p_context     jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  inserted_id        bigint,
  budget_status      text,
  current_spend_usd  numeric,
  hard_cap_usd       numeric,
  resets_at          timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted_id   bigint;
  v_budget        public.external_api_budgets%ROWTYPE;
  v_current_total numeric;
  v_period_start  timestamptz;
  v_resets_at     timestamptz;
  v_status        text;
BEGIN
  INSERT INTO public.external_api_usage (
    brand_id, provider, product, feature,
    units_in, units_out, cost_usd, request_id, context
  )
  VALUES (
    p_brand_id, p_provider, p_product, p_feature,
    p_units_in, p_units_out, p_cost_usd, p_request_id,
    COALESCE(p_context, '{}'::jsonb)
  )
  RETURNING id INTO v_inserted_id;

  -- Look up the budget. Per-provider beats wildcard.
  SELECT * INTO v_budget
  FROM public.external_api_budgets
  WHERE brand_id = p_brand_id
    AND provider IN (p_provider, '*')
  ORDER BY (provider = p_provider) DESC, period
  LIMIT 1;

  IF v_budget.brand_id IS NULL THEN
    RETURN QUERY SELECT v_inserted_id, 'no_budget'::text, 0::numeric, NULL::numeric, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_budget.period = 'daily' THEN
    v_period_start := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    v_resets_at    := v_period_start + interval '1 day';
  ELSE
    v_period_start := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    v_resets_at    := v_period_start + interval '1 month';
  END IF;

  SELECT COALESCE(SUM(cost_usd), 0) INTO v_current_total
  FROM public.external_api_usage
  WHERE brand_id = p_brand_id
    AND provider = p_provider
    AND occurred_at >= v_period_start;

  IF v_budget.hard_cap_usd IS NOT NULL AND v_current_total >= v_budget.hard_cap_usd THEN
    v_status := 'over_hard';
  ELSIF v_current_total >= v_budget.soft_cap_usd THEN
    v_status := 'over_soft';
  ELSE
    v_status := 'ok';
  END IF;

  RETURN QUERY SELECT
    v_inserted_id,
    v_status,
    v_current_total,
    v_budget.hard_cap_usd,
    v_resets_at;
END;
$$;

REVOKE ALL ON FUNCTION public.record_external_api_usage(
  text, text, text, text, bigint, bigint, numeric, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_external_api_usage(
  text, text, text, text, bigint, bigint, numeric, text, jsonb
) TO authenticated, service_role;

-- ==========================================================================
-- 4. cost_summary RPC for the admin dashboard
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.cost_summary(
  p_window_days int DEFAULT 30,
  p_group_by    text DEFAULT 'provider'  -- 'provider' | 'feature' | 'product'
)
RETURNS TABLE (
  brand_id     text,
  bucket_key   text,
  total_cost   numeric,
  total_calls  bigint,
  total_units_in  bigint,
  total_units_out bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    eau.brand_id,
    CASE p_group_by
      WHEN 'feature' THEN eau.feature
      WHEN 'product' THEN eau.product
      ELSE eau.provider
    END AS bucket_key,
    SUM(eau.cost_usd)        AS total_cost,
    COUNT(*)                 AS total_calls,
    SUM(eau.units_in)        AS total_units_in,
    SUM(eau.units_out)       AS total_units_out
  FROM public.external_api_usage eau
  WHERE eau.occurred_at >= now() - (p_window_days || ' days')::interval
  GROUP BY eau.brand_id, bucket_key
  ORDER BY total_cost DESC;
$$;

GRANT EXECUTE ON FUNCTION public.cost_summary(int, text) TO authenticated;

-- ==========================================================================
-- 5. Default budgets (idempotent seed)
--
-- Per spec §15.2: $20/day soft, $100/day hard per brand × provider.
-- The seed targets all known brands × known providers. Operator can edit
-- via the /admin/cost UI.
-- ==========================================================================
INSERT INTO public.external_api_budgets (brand_id, provider, period, soft_cap_usd, hard_cap_usd, notes)
VALUES
  ('example',        '*', 'daily', 20.00, 100.00, 'Default seed; tune via /admin/cost'),
  ('demo',       '*', 'daily', 20.00, 100.00, 'Default seed; tune via /admin/cost'),
  ('acme', '*', 'daily', 20.00, 100.00, 'Default seed; tune via /admin/cost')
ON CONFLICT (brand_id, provider, period) DO NOTHING;
