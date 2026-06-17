-- Pause/resume for in-flight staggered sends + "exclude already-sent
-- recipients" when creating a new send (re-send corrected content without
-- double-sending). Spec follow-on to personalised delivery.

-- 1. New status: 'paused' — a stop-but-resumable in-flight state.
ALTER TABLE public.newsletter_sends DROP CONSTRAINT IF EXISTS newsletter_sends_status_check;
ALTER TABLE public.newsletter_sends
  ADD CONSTRAINT newsletter_sends_status_check
  CHECK (status = ANY (ARRAY['draft', 'scheduled', 'sending', 'sent', 'cancelling', 'cancelled', 'failed', 'paused']::text[]));

-- 2. Optional exclusion list: a new send can skip recipients already
--    successfully sent in one or more prior sends. Matched on email via
--    email_send_log status='sent' (both the all-at-once and drip paths write
--    that row on success, so it covers either kind of prior send).
ALTER TABLE public.newsletter_sends
  ADD COLUMN IF NOT EXISTS exclude_sent_send_ids uuid[];

-- 3. The drip must only dispatch ACTIVELY 'sending' sends. Joining the parent
--    send means paused / scheduled / cancelling sends never have their pending
--    recipients claimed — so pause simply stops the drip, and resume (back to
--    'sending') picks up exactly where it left off. FOR UPDATE OF the recipient
--    rows only (not the parent) keeps overlapping ticks safe without locking
--    newsletter_sends.
CREATE OR REPLACE FUNCTION public.claim_due_newsletter_recipients(p_limit integer DEFAULT 500)
RETURNS SETOF public.newsletter_send_recipients
LANGUAGE sql
AS $$
  UPDATE public.newsletter_send_recipients r
  SET status = 'sending', attempts = r.attempts + 1, updated_at = now()
  FROM (
    SELECT nsr.id
    FROM public.newsletter_send_recipients nsr
    JOIN public.newsletter_sends s ON s.id = nsr.send_id
    WHERE nsr.status = 'pending'
      AND nsr.send_at <= now()
      AND s.status = 'sending'
    ORDER BY nsr.send_at
    LIMIT p_limit
    FOR UPDATE OF nsr SKIP LOCKED
  ) due
  WHERE r.id = due.id
  RETURNING r.*;
$$;

-- 4. Recreate the fan-out (timezone population from 041) + apply the
--    exclude_sent_send_ids exclusion when present.
CREATE OR REPLACE FUNCTION public.fanout_newsletter_send_recipients(p_send_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_send       public.newsletter_sends%ROWTYPE;
  v_list_id    uuid;
  v_send_date  date;
  v_target     text;
  v_inserted   integer;
BEGIN
  SELECT * INTO v_send FROM public.newsletter_sends WHERE id = p_send_id;
  IF v_send.id IS NULL THEN
    RAISE EXCEPTION 'newsletter_send % not found', p_send_id;
  END IF;

  v_list_id := (v_send.list_ids)[1];
  IF v_list_id IS NULL THEN
    RAISE EXCEPTION 'newsletter_send % has no list_ids to fan out', p_send_id;
  END IF;

  v_target := COALESCE(NULLIF(v_send.target_local, ''), '09:00');
  v_send_date := (COALESCE(v_send.scheduled_at, now())
                    AT TIME ZONE COALESCE(NULLIF(v_send.default_timezone, ''), 'UTC'))::date;

  INSERT INTO public.newsletter_send_recipients (send_id, person_id, email, send_at, status, strategy, timezone)
  SELECT
    p_send_id,
    pp.id,
    ls.email,
    ((v_send_date::text || ' ' || v_target)::timestamp
       AT TIME ZONE COALESCE(rtz.name, dtz.name, 'UTC')),
    'pending',
    COALESCE(NULLIF(v_send.delivery_strategy, ''), 'tz_local'),
    COALESCE(rtz.name, dtz.name, 'UTC')
  FROM public.list_subscriptions ls
  LEFT JOIN LATERAL (
    SELECT id, attributes FROM public.people
    WHERE lower(email) = lower(ls.email)
    LIMIT 1
  ) pp ON true
  LEFT JOIN pg_timezone_names rtz ON rtz.name = NULLIF(pp.attributes->>'timezone', '')
  LEFT JOIN pg_timezone_names dtz ON dtz.name = NULLIF(v_send.default_timezone, '')
  WHERE ls.list_id = v_list_id
    AND ls.subscribed = true
    AND (
      v_send.exclude_sent_send_ids IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.email_send_log esl
        WHERE esl.newsletter_send_id = ANY (v_send.exclude_sent_send_ids)
          AND esl.status = 'sent'
          AND lower(esl.recipient_email) = lower(ls.email)
      )
    )
  ON CONFLICT (send_id, email) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  UPDATE public.newsletter_sends
  SET total_recipients = (SELECT count(*) FROM public.newsletter_send_recipients WHERE send_id = p_send_id),
      updated_at = now()
  WHERE id = p_send_id;

  RETURN v_inserted;
END $$;
