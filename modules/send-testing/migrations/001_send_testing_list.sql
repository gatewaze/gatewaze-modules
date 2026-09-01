-- ============================================================================
-- Module: send-testing
-- Migration: 001_send_testing_list
-- Description: Seed the well-known 'send-testing' list that every send test
-- targets. Synthetic test people are subscribed to this list and any sender
-- (broadcasts, newsletters, or an external system fed from the CSV export)
-- selects it through its normal list-selection UI, so the production send
-- path is what gets exercised.
--
-- The list is internal (hidden from the portal Subscription Centre) and
-- non-public: end users can neither see nor subscribe to it.
-- Idempotent; referenced by the stable slug 'send-testing'.
-- ============================================================================

INSERT INTO public.lists (id, slug, name, description, is_active, is_public, is_internal, default_subscribed)
VALUES (
  '5e4d0000-0000-0000-0000-000000000001',
  'send-testing',
  'Bulk Send Testing',
  'Synthetic recipients used to rehearse large sends. Hidden from the Subscription Centre; never contains real people.',
  true,
  false,
  true,
  false
)
ON CONFLICT (slug) DO NOTHING;
