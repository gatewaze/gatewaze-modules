-- ============================================================================
-- Module: lists
-- Migration: 004_subscriptions_cascade_on_person_delete
-- Description: When a person is deleted, delete their subscription rows too
--              (was ON DELETE SET NULL, which left orphaned person_id=null rows
--              lingering by email). Only rows owned by that person (person_id =
--              the deleted person) are removed; unowned subscriptions
--              (person_id null — e.g. pre-auth signups) are untouched.
--
-- Trade-off: an unsubscribe/suppression row owned by the person is removed with
-- them, so a later re-signup with the same address starts from list defaults
-- rather than the prior opt-out. This is the requested behaviour.
--
-- Idempotent / safe to re-run.
-- ============================================================================

ALTER TABLE public.list_subscriptions DROP CONSTRAINT IF EXISTS list_subscriptions_person_id_fkey;
ALTER TABLE public.list_subscriptions
  ADD CONSTRAINT list_subscriptions_person_id_fkey
  FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;
