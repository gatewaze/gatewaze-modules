-- ============================================================================
-- Module: event-budget
-- Migration: 000_event_budget_core_tables
-- Description: Core budget_items table moved from 00004_events.sql.
-- ============================================================================

-- ==========================================================================
-- 1. events_budget_items
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.events_budget_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  category    text NOT NULL,
  description text,
  amount      numeric(10, 2) NOT NULL,
  type        text NOT NULL CHECK (type IN ('income', 'expense')),
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_budget_items_event ON public.events_budget_items (event_id);

CREATE TRIGGER events_budget_items_updated_at
  BEFORE UPDATE ON public.events_budget_items
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 2. RLS Policies
-- ==========================================================================

ALTER TABLE public.events_budget_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "budget_items_select"
  ON public.events_budget_items FOR SELECT TO authenticated
  USING (public.can_admin_event(event_id));

CREATE POLICY "budget_items_insert"
  ON public.events_budget_items FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_event(event_id));

CREATE POLICY "budget_items_update"
  ON public.events_budget_items FOR UPDATE TO authenticated
  USING (public.can_admin_event(event_id));

CREATE POLICY "budget_items_delete"
  ON public.events_budget_items FOR DELETE TO authenticated
  USING (public.can_admin_event(event_id));
