-- ============================================================================
-- Module: newsletters
-- Migration: 059_fanout_set_statement_timeout_proconfig
-- Description: Attach statement_timeout=10min as a per-function GUC on
-- fanout_newsletter_send_recipients via ALTER FUNCTION ... SET.
--
-- Symptom: a "Send Now" on the AAIF MLOps Community newsletter (55,437
-- subscribers) flipped to status='failed' within ~25-60s of dispatcher
-- pickup. Worker log:
--
--   [newsletter:dispatch-scheduled] fanout failed: Send 2d81722b-...:
--     canceling statement due to statement timeout
--
-- Migration 046 / 054 already set `SET LOCAL statement_timeout = '10min'`
-- inside the function body. That doesn't extend the timer for the OUTER
-- call: the dispatcher invokes the function via PostgREST as
-- `SELECT * FROM fanout_newsletter_send_recipients($1)`. Postgres begins
-- counting against the role-level statement_timeout at the start of that
-- statement; SET LOCAL inside the body only applies to subsequent
-- statements within the same transaction, so the running SELECT keeps
-- the original (shorter) timer and trips before the body finishes.
--
-- Fix: ALTER FUNCTION ... SET attaches the GUC to the function object's
-- `proconfig`. When Postgres enters the function it applies the SET
-- clauses BEFORE running the body — the running SELECT's timer is the
-- bumped 10-min value, and it survives whatever the caller's role-level
-- default is.
--
-- The body's `SET LOCAL statement_timeout = '10min'` line is now
-- redundant but harmless; left in place to avoid an unrelated function
-- re-create churn here. A future cleanup migration can drop it.
--
-- Validated on AAIF prod 2026-06-25:
--   - EXPLAIN ANALYZE 5,000-row sample: 931ms (idx_people_lower_email
--     used as expected from migration 046). Extrapolates to ~10-15s
--     cold for the 55,437-subscriber list, well under the new 10-min cap.
-- ============================================================================

ALTER FUNCTION public.fanout_newsletter_send_recipients(uuid)
  SET statement_timeout TO '600000';

COMMENT ON FUNCTION public.fanout_newsletter_send_recipients(uuid) IS
  'Fans out per-recipient rows for a newsletter_send. statement_timeout '
  'is bumped to 10 minutes via the function''s proconfig (migration 059) '
  'so PostgREST-initiated calls have time to complete on 50k+ lists.';
