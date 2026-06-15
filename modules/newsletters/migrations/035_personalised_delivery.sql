-- Recipient-local & personalised send timing — fan out timing, not content.
-- Spec: spec-newsletter-personalised-delivery.md §4 (Part A).
--
-- The single template newsletter_sends row is unchanged in spirit; we add a
-- delivery strategy + a per-recipient timing queue (newsletter_send_recipients).
-- The dispatcher claims due recipients and sends each via the existing
-- per-recipient substitution path. Personalisation of CONTENT still happens at
-- send time (Part B); this is purely about WHEN each recipient is dispatched.

-- 1. Delivery strategy on the send -------------------------------------------
ALTER TABLE public.newsletter_sends
  ADD COLUMN IF NOT EXISTS delivery_strategy text NOT NULL DEFAULT 'global',
  -- Collection-level fallback IANA tz used when a recipient has none.
  ADD COLUMN IF NOT EXISTS default_timezone text,
  -- Configured local wall-clock for tz_local/personalised sends, 'HH:MM'.
  ADD COLUMN IF NOT EXISTS target_local text,
  -- Personalised lead: dispatch this many minutes before modelled open time.
  ADD COLUMN IF NOT EXISTS lead_minutes integer NOT NULL DEFAULT 45;

ALTER TABLE public.newsletter_sends DROP CONSTRAINT IF EXISTS newsletter_sends_delivery_strategy_check;
ALTER TABLE public.newsletter_sends
  ADD CONSTRAINT newsletter_sends_delivery_strategy_check
  CHECK (delivery_strategy IN ('global', 'tz_local', 'personalised'));

-- 2. Per-recipient timing queue ----------------------------------------------
CREATE TABLE IF NOT EXISTS public.newsletter_send_recipients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id       uuid NOT NULL REFERENCES public.newsletter_sends(id) ON DELETE CASCADE,
  -- Recipient may exist only as a list subscription (no people row yet).
  person_id     uuid,
  -- Snapshot of the recipient address at fan-out time (denormalised on purpose:
  -- addresses change, and this row is an immutable audit + suppression key
  -- independent of people).
  email         text NOT NULL,
  -- UTC instant to dispatch this recipient.
  send_at       timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  -- Provenance for QA: how send_at was computed.
  strategy      text NOT NULL DEFAULT 'global'
                CHECK (strategy IN ('global', 'tz_local', 'personalised')),
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz,
  -- Fan-out is idempotent: re-running replaces only pending rows (see API).
  CONSTRAINT uq_nsr_send_email UNIQUE (send_id, email)
);

-- Dispatcher claim: "pending rows whose send_at has arrived", soonest first.
CREATE INDEX IF NOT EXISTS idx_nsr_due ON public.newsletter_send_recipients(status, send_at);
CREATE INDEX IF NOT EXISTS idx_nsr_send ON public.newsletter_send_recipients(send_id);

CREATE TRIGGER newsletter_send_recipients_updated_at
  BEFORE UPDATE ON public.newsletter_send_recipients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. RLS: admin/service-role only (timing queue holds recipient emails). ------
ALTER TABLE public.newsletter_send_recipients ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'newsletter_send_recipients'
      AND policyname = 'auth_all_newsletter_send_recipients'
  ) THEN
    CREATE POLICY "auth_all_newsletter_send_recipients"
      ON public.newsletter_send_recipients
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE public.newsletter_send_recipients IS
  'Per-recipient send-timing queue for tz-local / personalised delivery '
  '(spec-newsletter-personalised-delivery Part A). One row per (send, recipient).';
COMMENT ON COLUMN public.newsletter_sends.delivery_strategy IS
  'global = one fire-time for all; tz_local = recipient local wall-clock; personalised = modelled human open time.';

-- 4. Atomic dispatcher claim --------------------------------------------------
-- Claims up to p_limit due recipients (status pending → sending) under
-- FOR UPDATE SKIP LOCKED so overlapping pg_cron ticks never double-send the
-- same row (spec §A.4 / §8 dispatcher claim). Returns the claimed rows.
CREATE OR REPLACE FUNCTION public.claim_due_newsletter_recipients(p_limit integer DEFAULT 500)
RETURNS SETOF public.newsletter_send_recipients
LANGUAGE sql
AS $$
  UPDATE public.newsletter_send_recipients r
  SET status = 'sending', attempts = r.attempts + 1, updated_at = now()
  FROM (
    SELECT id
    FROM public.newsletter_send_recipients
    WHERE status = 'pending' AND send_at <= now()
    ORDER BY send_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ) due
  WHERE r.id = due.id
  RETURNING r.*;
$$;

COMMENT ON FUNCTION public.claim_due_newsletter_recipients(integer) IS
  'Atomically claim due newsletter_send_recipients (pending→sending) for the dispatcher; FOR UPDATE SKIP LOCKED makes overlapping ticks safe.';
