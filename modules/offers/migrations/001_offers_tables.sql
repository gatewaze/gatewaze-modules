-- ============================================================================
-- Module: offers
-- Migration: 001_offers_tables
-- Description: Create tables for offer interaction tracking
-- ============================================================================

-- Offer interactions (tracking who accepted/viewed general offers)
CREATE TABLE IF NOT EXISTS public.integrations_offer_interactions (
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

COMMENT ON TABLE public.integrations_offer_interactions IS 'Tracks customer interactions with offers (views, acceptances)';

CREATE INDEX IF NOT EXISTS idx_integrations_offer_interactions_offer
  ON public.integrations_offer_interactions (offer_id);
CREATE INDEX IF NOT EXISTS idx_integrations_offer_interactions_customer
  ON public.integrations_offer_interactions (customer_cio_id);
CREATE INDEX IF NOT EXISTS idx_integrations_offer_interactions_status
  ON public.integrations_offer_interactions (offer_status);
CREATE INDEX IF NOT EXISTS idx_integrations_offer_interactions_offer_status
  ON public.integrations_offer_interactions (offer_id, offer_status);
CREATE INDEX IF NOT EXISTS idx_integrations_offer_interactions_timestamp
  ON public.integrations_offer_interactions (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_integrations_offer_interactions_email
  ON public.integrations_offer_interactions (email) WHERE email IS NOT NULL;

CREATE TRIGGER integrations_offer_interactions_updated_at
  BEFORE UPDATE ON public.integrations_offer_interactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE public.integrations_offer_interactions ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated users
CREATE POLICY "integrations_offer_interactions_select" ON public.integrations_offer_interactions FOR SELECT TO authenticated USING (true);

-- INSERT/UPDATE/DELETE: admin only
CREATE POLICY "integrations_offer_interactions_insert" ON public.integrations_offer_interactions FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "integrations_offer_interactions_update" ON public.integrations_offer_interactions FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "integrations_offer_interactions_delete" ON public.integrations_offer_interactions FOR DELETE TO authenticated USING (public.is_admin());
