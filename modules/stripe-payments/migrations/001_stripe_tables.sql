-- ============================================================================
-- Module: stripe-payments
-- Migration: 001_stripe_tables
-- Description: Create Stripe payment data cache tables
-- ============================================================================

-- Stripe customers
CREATE TABLE IF NOT EXISTS public.payments_stripe_customers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid REFERENCES public.accounts (id) ON DELETE SET NULL,
  stripe_customer_id    text NOT NULL UNIQUE,
  email                 varchar(255) NOT NULL,
  name                  varchar(500),
  description           text,
  phone                 varchar(50),
  currency              varchar(10) NOT NULL DEFAULT 'usd',
  balance               integer NOT NULL DEFAULT 0,
  metadata              jsonb DEFAULT '{}'::jsonb,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payments_stripe_customers IS 'Cached Stripe customer records synced via webhooks';

CREATE INDEX IF NOT EXISTS idx_payments_stripe_customers_stripe_id
  ON public.payments_stripe_customers (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_customers_account
  ON public.payments_stripe_customers (account_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_customers_email
  ON public.payments_stripe_customers (email);

CREATE TRIGGER payments_stripe_customers_updated_at
  BEFORE UPDATE ON public.payments_stripe_customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Stripe products
CREATE TABLE IF NOT EXISTS public.payments_stripe_products (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid REFERENCES public.accounts (id) ON DELETE SET NULL,
  stripe_product_id     text NOT NULL UNIQUE,
  name                  varchar(500) NOT NULL,
  description           text,
  active                boolean NOT NULL DEFAULT true,
  default_price_id      text,
  images                text[],
  metadata              jsonb DEFAULT '{}'::jsonb,
  unit_label            varchar(100),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payments_stripe_products IS 'Cached Stripe product records synced via webhooks';

CREATE INDEX IF NOT EXISTS idx_payments_stripe_products_stripe_id
  ON public.payments_stripe_products (stripe_product_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_products_account
  ON public.payments_stripe_products (account_id);

CREATE TRIGGER payments_stripe_products_updated_at
  BEFORE UPDATE ON public.payments_stripe_products
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Stripe prices
CREATE TABLE IF NOT EXISTS public.payments_stripe_prices (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                  uuid REFERENCES public.accounts (id) ON DELETE SET NULL,
  product_id                  uuid REFERENCES public.payments_stripe_products (id) ON DELETE CASCADE,
  stripe_price_id             text NOT NULL UNIQUE,
  stripe_product_id           text NOT NULL,
  active                      boolean NOT NULL DEFAULT true,
  currency                    varchar(10) NOT NULL DEFAULT 'usd',
  unit_amount                 integer,
  recurring_interval          varchar(20),
  recurring_interval_count    integer,
  type                        varchar(20) NOT NULL DEFAULT 'one_time'
                              CHECK (type IN ('one_time', 'recurring')),
  billing_scheme              varchar(50) NOT NULL DEFAULT 'per_unit',
  metadata                    jsonb DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payments_stripe_prices IS 'Cached Stripe price records synced via webhooks';

CREATE INDEX IF NOT EXISTS idx_payments_stripe_prices_stripe_id
  ON public.payments_stripe_prices (stripe_price_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_prices_product
  ON public.payments_stripe_prices (product_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_prices_account
  ON public.payments_stripe_prices (account_id);

CREATE TRIGGER payments_stripe_prices_updated_at
  BEFORE UPDATE ON public.payments_stripe_prices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Stripe invoices
CREATE TABLE IF NOT EXISTS public.payments_stripe_invoices (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid REFERENCES public.accounts (id) ON DELETE SET NULL,
  person_id               uuid REFERENCES public.payments_stripe_customers (id) ON DELETE SET NULL,
  stripe_invoice_id       text NOT NULL UNIQUE,
  stripe_customer_id      text NOT NULL,
  invoice_number          varchar(100),
  status                  varchar(20) NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'open', 'paid', 'uncollectible', 'void')),
  currency                varchar(10) NOT NULL DEFAULT 'usd',
  amount_due              integer NOT NULL DEFAULT 0,
  amount_paid             integer NOT NULL DEFAULT 0,
  amount_remaining        integer NOT NULL DEFAULT 0,
  subtotal                integer NOT NULL DEFAULT 0,
  total                   integer NOT NULL DEFAULT 0,
  tax                     integer NOT NULL DEFAULT 0,
  discount_amount         integer NOT NULL DEFAULT 0,
  description             text,
  hosted_invoice_url      text,
  invoice_pdf             text,
  billing_reason          varchar(100),
  due_date                timestamptz,
  paid_at                 timestamptz,
  period_start            timestamptz,
  period_end              timestamptz,
  metadata                jsonb DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payments_stripe_invoices IS 'Cached Stripe invoice records synced via webhooks';

CREATE INDEX IF NOT EXISTS idx_payments_stripe_invoices_stripe_id
  ON public.payments_stripe_invoices (stripe_invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_invoices_person
  ON public.payments_stripe_invoices (person_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_invoices_account
  ON public.payments_stripe_invoices (account_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_invoices_status
  ON public.payments_stripe_invoices (status);

CREATE TRIGGER payments_stripe_invoices_updated_at
  BEFORE UPDATE ON public.payments_stripe_invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Stripe transactions (payment intents)
CREATE TABLE IF NOT EXISTS public.payments_stripe_transactions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                  uuid REFERENCES public.accounts (id) ON DELETE SET NULL,
  person_id                   uuid REFERENCES public.payments_stripe_customers (id) ON DELETE SET NULL,
  invoice_id                  uuid REFERENCES public.payments_stripe_invoices (id) ON DELETE SET NULL,
  stripe_payment_intent_id    text NOT NULL UNIQUE,
  stripe_customer_id          text,
  stripe_invoice_id           text,
  amount                      integer NOT NULL DEFAULT 0,
  currency                    varchar(10) NOT NULL DEFAULT 'usd',
  status                      varchar(30) NOT NULL DEFAULT 'requires_payment_method'
                              CHECK (status IN (
                                'requires_payment_method', 'requires_confirmation',
                                'requires_action', 'processing', 'succeeded',
                                'canceled', 'requires_capture'
                              )),
  payment_method_type         varchar(50),
  description                 text,
  receipt_email               varchar(255),
  metadata                    jsonb DEFAULT '{}'::jsonb,
  error_message               text,
  succeeded_at                timestamptz,
  canceled_at                 timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payments_stripe_transactions IS 'Cached Stripe payment intent records synced via webhooks';

CREATE INDEX IF NOT EXISTS idx_payments_stripe_transactions_stripe_id
  ON public.payments_stripe_transactions (stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_transactions_person
  ON public.payments_stripe_transactions (person_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_transactions_invoice
  ON public.payments_stripe_transactions (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_transactions_account
  ON public.payments_stripe_transactions (account_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_transactions_status
  ON public.payments_stripe_transactions (status);

CREATE TRIGGER payments_stripe_transactions_updated_at
  BEFORE UPDATE ON public.payments_stripe_transactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE public.payments_stripe_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments_stripe_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments_stripe_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments_stripe_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments_stripe_transactions ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated users
CREATE POLICY "payments_stripe_customers_select" ON public.payments_stripe_customers FOR SELECT TO authenticated USING (true);
CREATE POLICY "payments_stripe_products_select" ON public.payments_stripe_products FOR SELECT TO authenticated USING (true);
CREATE POLICY "payments_stripe_prices_select" ON public.payments_stripe_prices FOR SELECT TO authenticated USING (true);
CREATE POLICY "payments_stripe_invoices_select" ON public.payments_stripe_invoices FOR SELECT TO authenticated USING (true);
CREATE POLICY "payments_stripe_transactions_select" ON public.payments_stripe_transactions FOR SELECT TO authenticated USING (true);

-- INSERT/UPDATE/DELETE: admin only
CREATE POLICY "payments_stripe_customers_insert" ON public.payments_stripe_customers FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "payments_stripe_customers_update" ON public.payments_stripe_customers FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "payments_stripe_customers_delete" ON public.payments_stripe_customers FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "payments_stripe_products_insert" ON public.payments_stripe_products FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "payments_stripe_products_update" ON public.payments_stripe_products FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "payments_stripe_products_delete" ON public.payments_stripe_products FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "payments_stripe_prices_insert" ON public.payments_stripe_prices FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "payments_stripe_prices_update" ON public.payments_stripe_prices FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "payments_stripe_prices_delete" ON public.payments_stripe_prices FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "payments_stripe_invoices_insert" ON public.payments_stripe_invoices FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "payments_stripe_invoices_update" ON public.payments_stripe_invoices FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "payments_stripe_invoices_delete" ON public.payments_stripe_invoices FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "payments_stripe_transactions_insert" ON public.payments_stripe_transactions FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "payments_stripe_transactions_update" ON public.payments_stripe_transactions FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "payments_stripe_transactions_delete" ON public.payments_stripe_transactions FOR DELETE TO authenticated USING (public.is_admin());
