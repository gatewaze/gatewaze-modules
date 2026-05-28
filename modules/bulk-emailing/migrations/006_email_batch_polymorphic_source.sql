-- ============================================================================
-- bulk-emailing 006: polymorphic source on email_batch_jobs
--
-- Per spec-calendars-microsites §7.3 — email_batch_jobs needs to carry the
-- source kind + id so the worker can route to the right module's audience
-- resolver. Adding typed FK columns (one per source kind) would create a
-- hard dependency on the calendars module (and any future content-type
-- module). Polymorphic soft-reference avoids that.
--
-- Cleanup of orphaned rows (where source_id no longer resolves) is the
-- responsibility of a periodic cleanup job — out of scope for this
-- migration; bulk-emailing-cleanup-orphans worker will land separately.
--
-- Backwards compat:
--   - source_type defaults to 'event' so every existing row is correctly
--     classified without a backfill.
--   - event_id stays populated alongside source_id for the events flow —
--     a follow-up migration drops event_id once all callers (including
--     edge function readers) are updated.
-- ============================================================================

ALTER TABLE public.email_batch_jobs
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'event'
  CHECK (source_type IN ('event', 'calendar'));

ALTER TABLE public.email_batch_jobs
  ADD COLUMN IF NOT EXISTS source_id uuid;

-- Index for the typical "history of all jobs for this source" query.
-- Includes created_at DESC because every consumer call site sorts that way.
CREATE INDEX IF NOT EXISTS idx_email_batch_jobs_source
  ON public.email_batch_jobs (source_type, source_id, created_at DESC);

COMMENT ON COLUMN public.email_batch_jobs.source_type IS
  'Polymorphic discriminator for source_id. Per spec-calendars-microsites §7.3.';
COMMENT ON COLUMN public.email_batch_jobs.source_id IS
  'Soft-reference to the source row (events.id when source_type=event; calendars.id when source_type=calendar). No FK constraint — see spec §7.3 polymorphic soft-reference rationale.';

-- Backfill source_id for existing rows so the new query path works without
-- a one-shot script. event_id is the source_id for legacy event jobs.
UPDATE public.email_batch_jobs
  SET source_id = event_id
  WHERE source_id IS NULL AND event_id IS NOT NULL;
