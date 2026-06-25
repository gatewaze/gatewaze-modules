-- ============================================================================
-- Module: newsletters
-- Migration: 060_engagement_rpc_timeout_to_5min
-- Description: Raise the per-function statement_timeout on
-- newsletter_edition_engagement(uuid[]) from 25s to 5 min.
--
-- Symptom: the AAIF stats tab returned 57014 "canceling statement due to
-- statement timeout" the moment a single 55,437-recipient MLOps Community
-- send populated ~54k new email_send_log rows for an edition. The RPC's
-- multi-CTE aggregate joins newsletter_sends -> email_send_log ->
-- email_events/email_interactions -> email_event_classifications and
-- crosses list_subscriptions twice for the unsubs/supp calculation. At
-- AAIF's data volume (3.96M cumulative send_log rows, 147k events), a
-- cold-cache run for a brand-new edition reliably tripped the 25s cap.
--
-- Validated on AAIF prod 2026-06-25:
--   - Warm-cache run for the affected edition: 2.2s.
--   - Cold runs after a fresh 55k send completed in seconds, well under
--     the new cap.
-- ============================================================================

ALTER FUNCTION public.newsletter_edition_engagement(uuid[])
  SET statement_timeout TO '300000';

COMMENT ON FUNCTION public.newsletter_edition_engagement(uuid[]) IS
  'Engagement aggregate for one or more editions. statement_timeout is '
  'bumped to 5 minutes via the function''s proconfig (migration 060) so '
  'cold-cache runs on large brands (50k+ subs, 3M+ send_log rows) survive '
  'the multi-CTE join. The earlier 25s cap was tripped on AAIF/MLOps the '
  'moment a fresh 55k send landed.';
