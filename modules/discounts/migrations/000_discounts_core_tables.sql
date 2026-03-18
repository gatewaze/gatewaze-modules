-- ============================================================================
-- Module: discounts
-- Migration: 000_discounts_core_tables
-- Description: Core discount tables moved from 00004_events.sql.
--              events_discount_codes and events_discounts.
-- ============================================================================

-- ==========================================================================
-- 1. events_discount_codes
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.events_discount_codes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  code            text NOT NULL,
  description     text,
  discount_type   text NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value  numeric(10, 2) NOT NULL,
  max_uses        integer,
  current_uses    integer NOT NULL DEFAULT 0,
  valid_from      timestamptz,
  valid_until     timestamptz,
  status          text DEFAULT 'active' CHECK (status IN ('active', 'used', 'expired', 'revoked')),
  issued          boolean DEFAULT false,
  issued_to       text,
  issued_at       timestamptz,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, code)
);

CREATE INDEX IF NOT EXISTS idx_events_discount_codes_event ON public.events_discount_codes (event_id);

CREATE TRIGGER events_discount_codes_updated_at
  BEFORE UPDATE ON public.events_discount_codes
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 2. events_discounts
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.events_discounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  title           text NOT NULL,
  slug            text,
  value           text,
  ticket_details  text,
  close_date      timestamptz,
  close_display   text,
  intro           text,
  is_beta         boolean NOT NULL DEFAULT false,
  status          text DEFAULT 'active' CHECK (status IN ('draft', 'active', 'closed', 'expired')),
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_discounts_event ON public.events_discounts (event_id);
CREATE INDEX IF NOT EXISTS idx_events_discounts_slug ON public.events_discounts (slug);

CREATE TRIGGER events_discounts_updated_at
  BEFORE UPDATE ON public.events_discounts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 3. Conditional: Add discount_code_id to events_registrations
-- ==========================================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'events_registrations' AND column_name = 'discount_code_id'
  ) THEN
    ALTER TABLE public.events_registrations ADD COLUMN discount_code_id uuid
      REFERENCES public.events_discount_codes(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ==========================================================================
-- 4. RLS Policies
-- ==========================================================================

ALTER TABLE public.events_discount_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_discounts ENABLE ROW LEVEL SECURITY;

-- Discount codes
CREATE POLICY "discount_codes_select_anon"
  ON public.events_discount_codes FOR SELECT TO anon
  USING (issued = true);

CREATE POLICY "discount_codes_select"
  ON public.events_discount_codes FOR SELECT TO authenticated
  USING (public.can_admin_event(event_id));

CREATE POLICY "discount_codes_insert"
  ON public.events_discount_codes FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_event(event_id));

CREATE POLICY "discount_codes_update"
  ON public.events_discount_codes FOR UPDATE TO authenticated
  USING (public.can_admin_event(event_id));

CREATE POLICY "discount_codes_delete"
  ON public.events_discount_codes FOR DELETE TO authenticated
  USING (public.can_admin_event(event_id));

-- Discounts
CREATE POLICY "anon_select_events_discounts"
  ON public.events_discounts FOR SELECT TO anon
  USING (true);

CREATE POLICY "auth_all_events_discounts"
  ON public.events_discounts FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
