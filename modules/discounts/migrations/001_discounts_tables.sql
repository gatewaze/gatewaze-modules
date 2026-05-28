-- ============================================================================
-- Module: discounts
-- Migration: 001_discounts_tables
-- Description: Create tables for discount interactions and competition tracking
-- ============================================================================

-- Discount interactions (tracking who claimed discount offers via Customer.io)
CREATE TABLE IF NOT EXISTS public.events_discount_interactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text,
  customer_cio_id     text NOT NULL,
  offer_id            text NOT NULL,
  offer_status        varchar(50) NOT NULL,
  offer_referrer      text,
  timestamp           timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.events_discount_interactions IS 'Tracks customer interactions with discount offers';

CREATE INDEX IF NOT EXISTS idx_events_discount_interactions_offer
  ON public.events_discount_interactions (offer_id);
CREATE INDEX IF NOT EXISTS idx_events_discount_interactions_customer
  ON public.events_discount_interactions (customer_cio_id);
CREATE INDEX IF NOT EXISTS idx_events_discount_interactions_status
  ON public.events_discount_interactions (offer_status);
CREATE INDEX IF NOT EXISTS idx_events_discount_interactions_offer_status
  ON public.events_discount_interactions (offer_id, offer_status);
CREATE INDEX IF NOT EXISTS idx_events_discount_interactions_email
  ON public.events_discount_interactions (email) WHERE email IS NOT NULL;

CREATE TRIGGER events_discount_interactions_updated_at
  BEFORE UPDATE ON public.events_discount_interactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Competition interactions (tracking who entered/won competitions)
CREATE TABLE IF NOT EXISTS public.events_competition_interactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text,
  customer_cio_id     text,
  offer_id            text NOT NULL,
  offer_status        varchar(50) NOT NULL,
  offer_referrer      text,
  timestamp           timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.events_competition_interactions IS 'Tracks customer interactions with competitions';

CREATE INDEX IF NOT EXISTS idx_events_competition_interactions_offer
  ON public.events_competition_interactions (offer_id);
CREATE INDEX IF NOT EXISTS idx_events_competition_interactions_email
  ON public.events_competition_interactions (email);
CREATE INDEX IF NOT EXISTS idx_events_competition_interactions_status
  ON public.events_competition_interactions (offer_status);

CREATE TRIGGER events_competition_interactions_updated_at
  BEFORE UPDATE ON public.events_competition_interactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE public.events_discount_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_competition_interactions ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated users
CREATE POLICY "events_discount_interactions_select" ON public.events_discount_interactions FOR SELECT TO authenticated USING (true);
CREATE POLICY "events_competition_interactions_select" ON public.events_competition_interactions FOR SELECT TO authenticated USING (true);

-- INSERT/UPDATE/DELETE: admin only for discounts
CREATE POLICY "events_discount_interactions_insert" ON public.events_discount_interactions FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "events_discount_interactions_update" ON public.events_discount_interactions FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "events_discount_interactions_delete" ON public.events_discount_interactions FOR DELETE TO authenticated USING (public.is_admin());

-- Competition: anyone can insert (public entry), admin for update/delete
CREATE POLICY "events_competition_interactions_insert" ON public.events_competition_interactions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "events_competition_interactions_update" ON public.events_competition_interactions FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "events_competition_interactions_delete" ON public.events_competition_interactions FOR DELETE TO authenticated USING (public.is_admin());
