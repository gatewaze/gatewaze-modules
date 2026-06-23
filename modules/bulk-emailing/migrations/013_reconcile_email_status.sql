-- ============================================================================
-- Module: bulk-emailing
-- Migration: 013_reconcile_email_status
-- Description: Pull-based delivery-status reconcile from the SendGrid Email
-- Activity API. The Event Webhook (push) is the primary path in prod, but it
-- can't reach localhost and an occasional event can be missed — so a worker
-- periodically queries SendGrid for recent batches and advances email_send_log
-- to its real status (delivered / opened / clicked / bounced), which the
-- sending UI already reads. These RPCs are the DB side of that reconcile.
-- ============================================================================

-- Batches (by provider_message_id) that still have 'sent' rows (accepted by
-- SendGrid but not yet advanced to a delivery outcome) in the recent window —
-- i.e. the work-list for the reconcile worker.
CREATE OR REPLACE FUNCTION public.sendgrid_batches_needing_reconcile(p_limit integer DEFAULT 10)
RETURNS TABLE(provider_message_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT DISTINCT esl.provider_message_id
  FROM public.email_send_log esl
  WHERE esl.provider = 'sendgrid'
    AND esl.status = 'sent'
    AND esl.provider_message_id IS NOT NULL
    AND esl.sent_at > now() - interval '2 days'
  ORDER BY esl.provider_message_id
  LIMIT p_limit;
$function$;

-- Apply a batch of SendGrid Activity rows to email_send_log in one statement.
-- p_messages = jsonb array of { to_email, status, opens_count, clicks_count,
-- last_event_time }. Idempotent + monotonic: timestamps only set once, status
-- advances to the real outcome (clicked > opened > delivered > bounced).
CREATE OR REPLACE FUNCTION public.reconcile_email_send_log(p_provider_message_id text, p_messages jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE n integer;
BEGIN
  -- status only ever becomes delivered/bounced (the email_send_log status set);
  -- opens/clicks are recorded as timestamps (first_opened_at/first_clicked_at) —
  -- the UI derives "opened"/"clicked" from those, matching the Event Webhook.
  UPDATE public.email_send_log e SET
    status = CASE
      WHEN m.status = 'not_delivered' THEN 'bounced'
      WHEN m.status = 'delivered' OR m.opens_count > 0 OR m.clicks_count > 0 THEN 'delivered'
      ELSE e.status
    END,
    delivered_at = COALESCE(e.delivered_at, CASE WHEN m.status = 'delivered' OR m.opens_count > 0 OR m.clicks_count > 0 THEN m.last_event_time END),
    first_opened_at = COALESCE(e.first_opened_at, CASE WHEN m.opens_count > 0 THEN m.last_event_time END),
    first_clicked_at = COALESCE(e.first_clicked_at, CASE WHEN m.clicks_count > 0 THEN m.last_event_time END),
    bounced_at = COALESCE(e.bounced_at, CASE WHEN m.status = 'not_delivered' THEN m.last_event_time END),
    updated_at = now()
  FROM jsonb_to_recordset(p_messages) AS m(to_email text, status text, opens_count integer, clicks_count integer, last_event_time timestamptz)
  WHERE e.provider_message_id = p_provider_message_id
    AND lower(e.recipient_email) = lower(m.to_email)
    -- only advance rows not already terminal (delivered may still gain open/click times)
    AND e.status IN ('sent', 'delivered');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;
