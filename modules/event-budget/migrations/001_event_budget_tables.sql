-- ============================================================================
-- Module: event-budget
-- Migration: 001_event_budget_tables
-- Description: Full budget management system - budget categories, allocations,
--              line items, suppliers, revenue tracking, and sponsor payments.
--              The core events schema includes events_budget_items (a simpler
--              table); this module provides the extended budget categories system.
-- ============================================================================

-- ==========================================================================
-- 1. Event budget categories
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_budget_categories (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                          varchar(255) NOT NULL,
  slug                          varchar(255) NOT NULL UNIQUE,
  parent_category_id            uuid REFERENCES public.events_budget_categories (id) ON DELETE SET NULL,
  category_type                 varchar(20) NOT NULL DEFAULT 'other'
                                CHECK (category_type IN ('marketing', 'venue', 'catering', 'av', 'supplier', 'other')),
  description                   text,
  icon                          varchar(50),
  color                         varchar(50),
  display_order                 integer NOT NULL DEFAULT 0,
  registration_source_value     text,
  registration_source_pattern   text,
  is_active                     boolean NOT NULL DEFAULT true,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.events_budget_categories IS 'Reusable budget categories across events with marketing source mapping';

CREATE INDEX IF NOT EXISTS idx_events_budget_categories_type
  ON public.events_budget_categories (category_type);
CREATE INDEX IF NOT EXISTS idx_events_budget_categories_slug
  ON public.events_budget_categories (slug);
CREATE INDEX IF NOT EXISTS idx_events_budget_categories_active
  ON public.events_budget_categories (is_active);

CREATE TRIGGER events_budget_categories_updated_at
  BEFORE UPDATE ON public.events_budget_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 2. Event budget allocations (planned amounts per category per event)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_budget_allocations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        text NOT NULL,
  category_id     uuid NOT NULL REFERENCES public.events_budget_categories (id) ON DELETE CASCADE,
  planned_amount  numeric(12,2) NOT NULL DEFAULT 0,
  currency        varchar(10) NOT NULL DEFAULT 'USD',
  notes           text,
  approved_by     uuid,
  approved_at     timestamptz,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, category_id)
);

COMMENT ON TABLE public.events_budget_allocations IS 'Planned budget amounts per category per event';

CREATE INDEX IF NOT EXISTS idx_events_budget_allocations_event
  ON public.events_budget_allocations (event_id);
CREATE INDEX IF NOT EXISTS idx_events_budget_allocations_category
  ON public.events_budget_allocations (category_id);

CREATE TRIGGER events_budget_allocations_updated_at
  BEFORE UPDATE ON public.events_budget_allocations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 3. Event budget line items (actual costs)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_budget_line_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            text NOT NULL,
  category_id         uuid NOT NULL REFERENCES public.events_budget_categories (id) ON DELETE CASCADE,
  description         text NOT NULL,
  vendor_name         varchar(500),
  amount              numeric(12,2) NOT NULL DEFAULT 0,
  currency            varchar(10) NOT NULL DEFAULT 'USD',
  quantity            integer NOT NULL DEFAULT 1,
  unit_cost           numeric(12,2),
  status              varchar(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'paid', 'cancelled')),
  payment_status      varchar(20) NOT NULL DEFAULT 'unpaid'
                      CHECK (payment_status IN ('unpaid', 'partial', 'paid', 'refunded')),
  payment_date        date,
  payment_reference   text,
  expense_date        date,
  due_date            date,
  invoice_url         text,
  receipt_url         text,
  contract_url        text,
  metadata            jsonb DEFAULT '{}'::jsonb,
  notes               text,
  internal_notes      text,
  supplier_id         uuid,
  created_by          uuid,
  updated_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.events_budget_line_items IS 'Actual cost line items with payment tracking';

CREATE INDEX IF NOT EXISTS idx_events_budget_line_items_event
  ON public.events_budget_line_items (event_id);
CREATE INDEX IF NOT EXISTS idx_events_budget_line_items_category
  ON public.events_budget_line_items (category_id);
CREATE INDEX IF NOT EXISTS idx_events_budget_line_items_status
  ON public.events_budget_line_items (status);

CREATE TRIGGER events_budget_line_items_updated_at
  BEFORE UPDATE ON public.events_budget_line_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 4. Event suppliers
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_suppliers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              varchar(500) NOT NULL,
  contact_name      varchar(255),
  email             varchar(255),
  phone             varchar(50),
  website           text,
  address_line1     text,
  address_line2     text,
  city              varchar(255),
  state             varchar(100),
  postal_code       varchar(20),
  country           varchar(100) NOT NULL DEFAULT 'US',
  tax_id            varchar(100),
  payment_terms     text,
  supplier_type     varchar(50),
  services_offered  text[],
  rating            numeric(3,2),
  notes             text,
  is_active         boolean NOT NULL DEFAULT true,
  is_preferred      boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.events_suppliers IS 'Vendor/supplier directory for event procurement';

CREATE INDEX IF NOT EXISTS idx_events_suppliers_active
  ON public.events_suppliers (is_active);
CREATE INDEX IF NOT EXISTS idx_events_suppliers_type
  ON public.events_suppliers (supplier_type);

CREATE TRIGGER events_suppliers_updated_at
  BEFORE UPDATE ON public.events_suppliers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Add foreign key for supplier_id on line items
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'events_budget_line_items_supplier_id_fkey'
      AND table_name = 'events_budget_line_items'
  ) THEN
    ALTER TABLE public.events_budget_line_items
      ADD CONSTRAINT events_budget_line_items_supplier_id_fkey
      FOREIGN KEY (supplier_id) REFERENCES public.events_suppliers (id) ON DELETE SET NULL;
  END IF;
END $$;

-- ==========================================================================
-- 5. Event revenue
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_revenue (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                    text NOT NULL,
  source_type                 varchar(30) NOT NULL DEFAULT 'other'
                              CHECK (source_type IN ('stripe', 'external', 'sponsorship', 'other')),
  source_name                 varchar(255),
  description                 text NOT NULL,
  ticket_type                 varchar(100),
  gross_amount                numeric(12,2) NOT NULL DEFAULT 0,
  fees                        numeric(12,2) NOT NULL DEFAULT 0,
  net_amount                  numeric(12,2) GENERATED ALWAYS AS (gross_amount - fees) STORED,
  currency                    varchar(10) NOT NULL DEFAULT 'USD',
  quantity                    integer NOT NULL DEFAULT 1,
  unit_price                  numeric(12,2),
  external_reference          text,
  stripe_payment_intent_id    text,
  stripe_invoice_id           text,
  revenue_date                date NOT NULL,
  refund_amount               numeric(12,2) NOT NULL DEFAULT 0,
  refund_date                 date,
  status                      varchar(20) NOT NULL DEFAULT 'confirmed'
                              CHECK (status IN ('pending', 'confirmed', 'refunded', 'partial_refund')),
  notes                       text,
  created_by                  uuid,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.events_revenue IS 'Revenue tracking from tickets, sponsorships, and external sources';

CREATE INDEX IF NOT EXISTS idx_events_revenue_event
  ON public.events_revenue (event_id);
CREATE INDEX IF NOT EXISTS idx_events_revenue_source
  ON public.events_revenue (source_type);
CREATE INDEX IF NOT EXISTS idx_events_revenue_date
  ON public.events_revenue (revenue_date DESC);

CREATE TRIGGER events_revenue_updated_at
  BEFORE UPDATE ON public.events_revenue
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 6. Event sponsor payments
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_sponsor_payments (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_sponsor_id            text NOT NULL,
  event_id                    text NOT NULL,
  sponsor_id                  text NOT NULL,
  description                 text NOT NULL,
  sponsorship_package         varchar(255),
  contracted_amount           numeric(12,2) NOT NULL DEFAULT 0,
  paid_amount                 numeric(12,2) NOT NULL DEFAULT 0,
  currency                    varchar(10) NOT NULL DEFAULT 'USD',
  payment_status              varchar(20) NOT NULL DEFAULT 'pending'
                              CHECK (payment_status IN ('pending', 'partial', 'paid', 'overdue', 'cancelled')),
  invoice_number              varchar(100),
  invoice_date                date,
  due_date                    date,
  payment_date                date,
  payment_method              varchar(50),
  external_reference          text,
  stripe_payment_intent_id    text,
  stripe_invoice_id           text,
  contract_url                text,
  invoice_url                 text,
  notes                       text,
  internal_notes              text,
  created_by                  uuid,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.events_sponsor_payments IS 'Sponsor payment tracking with invoice management';

CREATE INDEX IF NOT EXISTS idx_events_sponsor_payments_event
  ON public.events_sponsor_payments (event_id);
CREATE INDEX IF NOT EXISTS idx_events_sponsor_payments_sponsor
  ON public.events_sponsor_payments (sponsor_id);
CREATE INDEX IF NOT EXISTS idx_events_sponsor_payments_status
  ON public.events_sponsor_payments (payment_status);

CREATE TRIGGER events_sponsor_payments_updated_at
  BEFORE UPDATE ON public.events_sponsor_payments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 7. RLS
-- ==========================================================================
ALTER TABLE public.events_budget_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_budget_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_budget_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_revenue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_sponsor_payments ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated users
CREATE POLICY "events_budget_categories_select" ON public.events_budget_categories FOR SELECT TO authenticated USING (true);
CREATE POLICY "events_budget_allocations_select" ON public.events_budget_allocations FOR SELECT TO authenticated USING (true);
CREATE POLICY "events_budget_line_items_select" ON public.events_budget_line_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "events_suppliers_select" ON public.events_suppliers FOR SELECT TO authenticated USING (true);
CREATE POLICY "events_revenue_select" ON public.events_revenue FOR SELECT TO authenticated USING (true);
CREATE POLICY "events_sponsor_payments_select" ON public.events_sponsor_payments FOR SELECT TO authenticated USING (true);

-- INSERT/UPDATE/DELETE: admin only
CREATE POLICY "events_budget_categories_insert" ON public.events_budget_categories FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "events_budget_categories_update" ON public.events_budget_categories FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "events_budget_categories_delete" ON public.events_budget_categories FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "events_budget_allocations_insert" ON public.events_budget_allocations FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "events_budget_allocations_update" ON public.events_budget_allocations FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "events_budget_allocations_delete" ON public.events_budget_allocations FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "events_budget_line_items_insert" ON public.events_budget_line_items FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "events_budget_line_items_update" ON public.events_budget_line_items FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "events_budget_line_items_delete" ON public.events_budget_line_items FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "events_suppliers_insert" ON public.events_suppliers FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "events_suppliers_update" ON public.events_suppliers FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "events_suppliers_delete" ON public.events_suppliers FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "events_revenue_insert" ON public.events_revenue FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "events_revenue_update" ON public.events_revenue FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "events_revenue_delete" ON public.events_revenue FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "events_sponsor_payments_insert" ON public.events_sponsor_payments FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "events_sponsor_payments_update" ON public.events_sponsor_payments FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "events_sponsor_payments_delete" ON public.events_sponsor_payments FOR DELETE TO authenticated USING (public.is_admin());
