-- ============================================================================
-- Module: bulk-emailing
-- Migration: 024_inbound_emails
-- Description: Catch-all record of EVERY inbound email SendGrid hands us.
--
--              email-inbound-parse currently routes Luma, broadcast and
--              newsletter replies, and returns 200 for anything it can't
--              place — so an unmatched message is silently discarded. Speaker
--              and event replies fall into exactly that gap: their
--              email_send_log rows carry batch_job_id, which none of the
--              existing matchers look at.
--
--              This table records the message BEFORE routing is attempted, so
--              nothing is lost while routing is being extended, and so
--              "did the reply even reach us?" is answerable from the database
--              rather than the SendGrid dashboard.
--
--              routed_to/routed_id record where the message ended up, so
--              unrouted mail can be found with `WHERE routed_to IS NULL`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.inbound_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_addresses text[] NOT NULL DEFAULT ARRAY[]::text[],
  from_email text,
  from_name text,
  subject text,
  body_text text,
  body_html text,
  in_reply_to text,
  -- Where routing put it: 'luma' | 'broadcast' | 'newsletter' | 'event' | NULL
  routed_to text,
  routed_id uuid,
  -- Why it wasn't routed, when it wasn't.
  routing_note text,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- The operational question is "what arrived that we couldn't place?"
CREATE INDEX IF NOT EXISTS idx_inbound_emails_unrouted
  ON public.inbound_emails (received_at DESC)
  WHERE routed_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_inbound_emails_received
  ON public.inbound_emails (received_at DESC);

ALTER TABLE public.inbound_emails ENABLE ROW LEVEL SECURITY;

-- Service role (the parse function) writes; active admins read. No anon or
-- broad authenticated access: this holds the full text of private replies.
DROP POLICY IF EXISTS inbound_emails_service ON public.inbound_emails;
CREATE POLICY inbound_emails_service ON public.inbound_emails
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS inbound_emails_admin_read ON public.inbound_emails;
CREATE POLICY inbound_emails_admin_read ON public.inbound_emails
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.admin_profiles ap
    WHERE ap.user_id = auth.uid() AND ap.is_active = true
  ));
