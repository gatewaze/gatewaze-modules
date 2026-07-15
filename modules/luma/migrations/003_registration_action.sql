-- ============================================================================
-- luma module — registration_action column + widened status CHECK
--
-- integrations-luma-process-registration has been writing a
-- registration_action column and a 'cancelled' status that 001 never
-- created: inserts of new pending rows raised "column does not exist" and
-- cancellation updates violated the status CHECK (both failed silently in
-- the update paths, and threw in the insert path). This migration makes the
-- schema match the code. It also backs the reverse signup flow
-- (LumaPendingEventsScraper), which distinguishes queued registrations from
-- queued cancellations when replaying.
-- ============================================================================

ALTER TABLE public.integrations_luma_pending_registrations
  ADD COLUMN IF NOT EXISTS registration_action text DEFAULT 'registered';

DO $constraints$
BEGIN
  -- Widen the status CHECK to allow 'cancelled' (written by the edge
  -- function when a cancellation email arrives for a queued row).
  ALTER TABLE public.integrations_luma_pending_registrations
    DROP CONSTRAINT IF EXISTS integrations_luma_pending_registrations_status_check;
  ALTER TABLE public.integrations_luma_pending_registrations
    ADD CONSTRAINT integrations_luma_pending_registrations_status_check
    CHECK (status IN ('pending', 'matched', 'processed', 'failed', 'no_event', 'cancelled'));

  ALTER TABLE public.integrations_luma_pending_registrations
    DROP CONSTRAINT IF EXISTS integrations_luma_pending_registrations_action_check;
  ALTER TABLE public.integrations_luma_pending_registrations
    ADD CONSTRAINT integrations_luma_pending_registrations_action_check
    CHECK (registration_action IS NULL OR registration_action IN ('registered', 'cancelled'));
END $constraints$;

-- The reverse signup flow polls for queued rows by (status, luma_event_id).
CREATE INDEX IF NOT EXISTS idx_integrations_luma_pending_registrations_status_event
  ON public.integrations_luma_pending_registrations(status, luma_event_id);

COMMENT ON COLUMN public.integrations_luma_pending_registrations.registration_action IS
  'What the notification email conveyed: ''registered'' or ''cancelled''. Rows predating this column are NULL (treated as registered).';
