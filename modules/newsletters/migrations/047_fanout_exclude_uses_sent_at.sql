-- ============================================================================
-- Module: newsletters
-- Migration: 047_fanout_exclude_uses_sent_at
-- Description: Make the fanout's "exclude already-sent recipients" actually fire.
--
-- The exclusion subquery in fanout_newsletter_send_recipients filtered
-- email_send_log on status = 'sent', but the send pipeline writes
-- status='sent' only at the instant SendGrid accepts the API call. The
-- webhook then promotes the row to 'delivered', 'bounced', 'opened',
-- 'clicked', 'spam_reported' etc. as SendGrid reports back. By the time
-- the operator clicks Re-send with the previous send's checkbox ticked,
-- not a single row of that send is still status='sent' — the NOT EXISTS
-- subquery matches nothing and every recipient (including the 1,000
-- already reached) gets fanned out again.
--
-- The right discriminator is sent_at IS NOT NULL: it's set once when the
-- send pipeline successfully posted to the provider and never gets
-- cleared, so it cleanly identifies "we've already attempted this
-- recipient in the named send" regardless of subsequent lifecycle state.
--
-- Companion code change in the same release: newsletter-send Edge
-- Function's global-immediate path applies the same correction.
-- ============================================================================

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
  SET LOCAL statement_timeout = '10min';

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
          AND esl.sent_at IS NOT NULL
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

COMMENT ON FUNCTION public.fanout_newsletter_send_recipients(uuid) IS
  'Materialise per-recipient send_at rows for a tz_local/personalised send. Excludes recipients who already have sent_at set on a prior send (the lifecycle-stable "we already attempted them" signal — status alone moves past sent → delivered → opened / clicked / bounced and the exclude window slips).';
