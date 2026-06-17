-- Allow the transient 'cancelling' status on newsletter_sends.
--
-- Stopping an in-flight send sets status='cancelling' (the "stop requested"
-- state): the newsletter-send dispatcher observes it before each batch / drip
-- claim, drains cleanly, then flips the row to 'cancelled'. That value was
-- never added to the status check constraint, so the Stop button failed with
-- a 23514 check-constraint violation and the send kept going.
ALTER TABLE public.newsletter_sends DROP CONSTRAINT IF EXISTS newsletter_sends_status_check;
ALTER TABLE public.newsletter_sends
  ADD CONSTRAINT newsletter_sends_status_check
  CHECK (status = ANY (ARRAY['draft', 'scheduled', 'sending', 'sent', 'cancelling', 'cancelled', 'failed']::text[]));
