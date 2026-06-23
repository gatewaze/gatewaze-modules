-- ============================================================================
-- Module: bulk-emailing
-- Migration: 015_deferred_status
-- Description: Capture SendGrid 'deferred' lifecycle events. Deferred means the
-- recipient's mail server temporarily rejected the message (4xx SMTP — usually
-- greylisting, throttling on Yahoo/Microsoft, or per-domain rate-limits).
-- SendGrid retries internally for ~72 hours; the message may still eventually
-- deliver OR hard-bounce. Until now this state was invisible — deferred rows
-- sat in status='sent' with no diagnostic and the email-webhook silently
-- dropped the event. Found while investigating a 56k mlopscommunity send
-- where SG reported ~9k Yahoo deferrals (2026-06-23).
--
-- Changes:
--   1. Widen status CHECK to include 'deferred'.
--   2. Add deferred_at timestamptz (first-defer timestamp; never cleared).
--   3. Index for "what's deferred right now and to which domains".
--   4. RPC deferred_emails_by_domain() for the admin sending UI.
--   5. Reconcile pickup: deferred rows are non-terminal — keep them in the
--      reconcile work-list so SendGrid's Activity API can advance them to
--      delivered/bounced as they resolve. Update both the batch-list RPC and
--      reconcile_email_send_log.
-- ============================================================================

-- 1. Widen status CHECK ------------------------------------------------------
ALTER TABLE public.email_send_log DROP CONSTRAINT IF EXISTS email_send_log_status_check;
ALTER TABLE public.email_send_log
  ADD CONSTRAINT email_send_log_status_check
  CHECK (status = ANY (ARRAY[
    'queued','sending','sent','accepted','delivered',
    'send_failed','permanently_failed','bounced','dropped',
    'spam_reported','pending','failed',
    'deferred'
  ]));

-- 2. Lifecycle column --------------------------------------------------------
ALTER TABLE public.email_send_log
  ADD COLUMN IF NOT EXISTS deferred_at timestamptz;

COMMENT ON COLUMN public.email_send_log.deferred_at IS
  'First time SendGrid recorded a deferred (4xx temporary) attempt for this recipient. Non-terminal: row may later advance to delivered or bounced. Never cleared once set.';

-- 3. Read-path index for the admin sending UI dashboards. Partial on
-- "deferred but not yet resolved" — the only set the operator cares about
-- in real time.
CREATE INDEX IF NOT EXISTS idx_email_send_log_deferred_pending
  ON public.email_send_log (deferred_at DESC, recipient_email)
  WHERE deferred_at IS NOT NULL
    AND status NOT IN ('delivered','bounced','dropped','spam_reported');

-- 4. By-domain RPC -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deferred_emails_by_domain(
  p_since timestamptz DEFAULT now() - interval '24 hours',
  p_newsletter_send_id uuid DEFAULT NULL
) RETURNS TABLE (domain text, deferred_count bigint, latest_defer timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    lower(split_part(recipient_email, '@', 2)) AS domain,
    count(*) AS deferred_count,
    max(deferred_at) AS latest_defer
  FROM public.email_send_log
  WHERE deferred_at >= p_since
    AND (p_newsletter_send_id IS NULL OR newsletter_send_id = p_newsletter_send_id)
    AND status NOT IN ('delivered','bounced','dropped','spam_reported')
  GROUP BY 1
  ORDER BY 2 DESC
$$;

GRANT EXECUTE ON FUNCTION public.deferred_emails_by_domain(timestamptz, uuid) TO authenticated;

COMMENT ON FUNCTION public.deferred_emails_by_domain(timestamptz, uuid) IS
  'For the admin sending UI: which domains are currently holding deferred mail for us? p_newsletter_send_id scopes to one send; NULL = all sends.';

-- 5. Reconcile pickup --------------------------------------------------------

-- Include 'deferred' in the work-list so SendGrid's Activity API can advance
-- still-pending rows when greylisting/throttling clears.
CREATE OR REPLACE FUNCTION public.sendgrid_batches_needing_reconcile(p_limit integer DEFAULT 10)
RETURNS TABLE(provider_message_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $function$
  SELECT DISTINCT esl.provider_message_id
  FROM public.email_send_log esl
  WHERE esl.provider = 'sendgrid'
    AND esl.status IN ('sent', 'deferred')
    AND esl.provider_message_id IS NOT NULL
    AND esl.sent_at > now() - interval '4 days'  -- widen: deferred can sit up to ~72h before SG gives up
  ORDER BY esl.provider_message_id
  LIMIT p_limit;
$function$;

-- Teach the reconcile RPC to translate 'deferred' from SG Activity into our
-- status + deferred_at, and to advance deferred rows when they finally
-- resolve. Atomicity: status only ever moves forward (sent → deferred →
-- delivered/bounced); we never demote out of delivered/bounced.
CREATE OR REPLACE FUNCTION public.reconcile_email_send_log(p_provider_message_id text, p_messages jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE n integer;
BEGIN
  UPDATE public.email_send_log e SET
    status = CASE
      WHEN m.status = 'not_delivered' THEN 'bounced'
      WHEN m.status = 'delivered' OR m.opens_count > 0 OR m.clicks_count > 0 THEN 'delivered'
      WHEN m.status = 'deferred' AND e.status IN ('sent', 'deferred') THEN 'deferred'
      ELSE e.status
    END,
    delivered_at = COALESCE(e.delivered_at, CASE WHEN m.status = 'delivered' OR m.opens_count > 0 OR m.clicks_count > 0 THEN m.last_event_time END),
    first_opened_at = COALESCE(e.first_opened_at, CASE WHEN m.opens_count > 0 THEN m.last_event_time END),
    first_clicked_at = COALESCE(e.first_clicked_at, CASE WHEN m.clicks_count > 0 THEN m.last_event_time END),
    bounced_at = COALESCE(e.bounced_at, CASE WHEN m.status = 'not_delivered' THEN m.last_event_time END),
    deferred_at = COALESCE(e.deferred_at, CASE WHEN m.status = 'deferred' THEN m.last_event_time END),
    updated_at = now()
  FROM jsonb_to_recordset(p_messages) AS m(to_email text, status text, opens_count integer, clicks_count integer, last_event_time timestamptz)
  WHERE e.provider_message_id = p_provider_message_id
    AND lower(e.recipient_email) = lower(m.to_email)
    AND e.status IN ('sent', 'deferred', 'delivered');  -- include deferred so we can advance it
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;
