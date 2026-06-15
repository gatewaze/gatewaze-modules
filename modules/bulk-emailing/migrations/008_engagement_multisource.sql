-- Engagement model for multi-source bot detection.
-- Spec: spec-newsletter-personalised-delivery.md §6 (Part C).
--
-- Two layers:
--   1. Raw events  — extend email_events with a source tag + UA/IP signals +
--      a newsletter-send link, so opens/clicks from our own pixel/redirects and
--      from Customer.io live side by side as one immutable event stream.
--   2. Per-source classifications — append-only human/bot verdicts, one row per
--      (event, detection_source), so independent sources (our bot detector,
--      Customer.io, open-time-consistency) can be compared and diffed without
--      overwriting each other.

-- 1. Raw-event signal columns ------------------------------------------------
ALTER TABLE public.email_events
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'gatewaze',
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS ip inet,
  -- Soft link to newsletter_sends(id) (no cross-module FK — modules migrate
  -- independently; mirrors email_send_log.newsletter_send_id).
  ADD COLUMN IF NOT EXISTS newsletter_send_id uuid;

-- 'gatewaze'    = captured via our own tracking pixel / link redirects
-- 'customer.io' = imported from the Customer.io historical export
ALTER TABLE public.email_events DROP CONSTRAINT IF EXISTS email_events_source_check;
ALTER TABLE public.email_events
  ADD CONSTRAINT email_events_source_check
  CHECK (source IN ('gatewaze', 'customer.io'));

CREATE INDEX IF NOT EXISTS idx_email_events_source
  ON public.email_events(source);
CREATE INDEX IF NOT EXISTS idx_email_events_nl_send
  ON public.email_events(newsletter_send_id) WHERE newsletter_send_id IS NOT NULL;
-- Lookup index supporting the import's idempotency check (spec §7). Not UNIQUE:
-- the table already holds live data, and the import dedups in code via this key
-- (source, email, event_type, event_timestamp, broadcast/send scope).
CREATE INDEX IF NOT EXISTS idx_email_events_import_key
  ON public.email_events(source, email, event_type, event_timestamp);

-- 2. Per-source classifications ----------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_event_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.email_events(id) ON DELETE CASCADE,
  -- e.g. 'customer.io' | 'bot-detector-signals' | 'open-time-consistency'
  detection_source text NOT NULL,
  is_human boolean NOT NULL,
  confidence numeric,
  reason jsonb,
  classified_at timestamptz NOT NULL DEFAULT now(),
  -- One verdict per source per event; re-running a source upserts via this key
  -- rather than appending duplicates.
  CONSTRAINT uq_eec_event_source UNIQUE (event_id, detection_source)
);

CREATE INDEX IF NOT EXISTS idx_eec_event ON public.email_event_classifications(event_id);
CREATE INDEX IF NOT EXISTS idx_eec_source ON public.email_event_classifications(detection_source);
CREATE INDEX IF NOT EXISTS idx_eec_human ON public.email_event_classifications(is_human);

-- RLS: admin/service-role only, no anon access (spec §9). Mirrors the
-- email_events policy added in migration 001.
ALTER TABLE public.email_event_classifications ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'email_event_classifications'
      AND policyname = 'auth_all_email_event_classifications'
  ) THEN
    CREATE POLICY "auth_all_email_event_classifications"
      ON public.email_event_classifications
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE public.email_event_classifications IS
  'Append-only per-detection-source human/bot verdicts for email_events '
  '(spec-newsletter-personalised-delivery Part C). One row per (event, source); never overwrite.';
COMMENT ON COLUMN public.email_events.source IS
  'Origin of the raw event: gatewaze (own pixel/redirects) or customer.io (import).';
