-- Stripe Payments Module: Initial Tables
-- Migration: 001_stripe_tables.sql

-- Stripe customers linked to platform users
CREATE TABLE IF NOT EXISTS stripe_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  email TEXT,
  name TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

-- Stripe products (e.g., event tickets, memberships)
CREATE TABLE IF NOT EXISTS stripe_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_product_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB DEFAULT '{}',
  event_id TEXT REFERENCES events(event_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stripe prices linked to products
CREATE TABLE IF NOT EXISTS stripe_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_price_id TEXT NOT NULL UNIQUE,
  stripe_product_id TEXT NOT NULL REFERENCES stripe_products(stripe_product_id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'usd',
  unit_amount INTEGER NOT NULL,
  recurring_interval TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stripe invoices and payment records
CREATE TABLE IF NOT EXISTS stripe_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_invoice_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT NOT NULL REFERENCES stripe_customers(stripe_customer_id) ON DELETE CASCADE,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  currency TEXT NOT NULL DEFAULT 'usd',
  amount_due INTEGER NOT NULL DEFAULT 0,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  hosted_invoice_url TEXT,
  invoice_pdf TEXT,
  metadata JSONB DEFAULT '{}',
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_stripe_customers_user_id ON stripe_customers(user_id);
CREATE INDEX IF NOT EXISTS idx_stripe_customers_stripe_id ON stripe_customers(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_stripe_products_event_id ON stripe_products(event_id);
CREATE INDEX IF NOT EXISTS idx_stripe_prices_product_id ON stripe_prices(stripe_product_id);
CREATE INDEX IF NOT EXISTS idx_stripe_invoices_customer_id ON stripe_invoices(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_stripe_invoices_status ON stripe_invoices(status);

-- RLS policies
ALTER TABLE stripe_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_invoices ENABLE ROW LEVEL SECURITY;

-- Users can read their own customer record
CREATE POLICY "Users can view own stripe customer"
  ON stripe_customers FOR SELECT
  USING (auth.uid() = user_id);

-- Public can view active products and prices
CREATE POLICY "Public can view active products"
  ON stripe_products FOR SELECT
  USING (active = true);

CREATE POLICY "Public can view active prices"
  ON stripe_prices FOR SELECT
  USING (active = true);

-- Users can view their own invoices
CREATE POLICY "Users can view own invoices"
  ON stripe_invoices FOR SELECT
  USING (
    stripe_customer_id IN (
      SELECT stripe_customer_id FROM stripe_customers WHERE user_id = auth.uid()
    )
  );

-- Service role has full access (handled by Supabase default)

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION update_stripe_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stripe_customers_updated_at
  BEFORE UPDATE ON stripe_customers
  FOR EACH ROW EXECUTE FUNCTION update_stripe_updated_at();

CREATE TRIGGER stripe_products_updated_at
  BEFORE UPDATE ON stripe_products
  FOR EACH ROW EXECUTE FUNCTION update_stripe_updated_at();

CREATE TRIGGER stripe_prices_updated_at
  BEFORE UPDATE ON stripe_prices
  FOR EACH ROW EXECUTE FUNCTION update_stripe_updated_at();

CREATE TRIGGER stripe_invoices_updated_at
  BEFORE UPDATE ON stripe_invoices
  FOR EACH ROW EXECUTE FUNCTION update_stripe_updated_at();
