-- Fan-out for tz_local / personalised sends: materialise one
-- newsletter_send_recipients row per subscriber, each with a `send_at` set to
-- the configured local wall-clock (target_local) in the recipient's OWN
-- timezone (people.attributes->>'timezone'), falling back to the send's
-- default_timezone, then UTC. The dispatcher then drips due rows via
-- claim_due_newsletter_recipients (migration 035).
--
-- Timezone math lives here (not JS) so Postgres handles DST correctly via
-- AT TIME ZONE. Bad/unknown zone strings are guarded by joining
-- pg_timezone_names — an invalid attribute on one person can't abort the whole
-- fan-out, it just falls back. Idempotent: ON CONFLICT DO NOTHING preserves
-- already-materialised rows so a re-run never duplicates or resets progress.
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
  -- Reference "send day" = local calendar date in the default tz at the
  -- scheduled instant (the operator's frame of reference).
  v_send_date := (COALESCE(v_send.scheduled_at, now())
                    AT TIME ZONE COALESCE(NULLIF(v_send.default_timezone, ''), 'UTC'))::date;

  INSERT INTO public.newsletter_send_recipients (send_id, person_id, email, send_at, status, strategy)
  SELECT
    p_send_id,
    pp.id,
    ls.email,
    ((v_send_date::text || ' ' || v_target)::timestamp
       AT TIME ZONE COALESCE(rtz.name, dtz.name, 'UTC')),
    'pending',
    COALESCE(NULLIF(v_send.delivery_strategy, ''), 'tz_local')
  FROM public.list_subscriptions ls
  LEFT JOIN LATERAL (
    SELECT id, attributes FROM public.people
    WHERE lower(email) = lower(ls.email)
    LIMIT 1
  ) pp ON true
  -- Validate the recipient + default zones against the IANA name set so a
  -- junk value falls back instead of raising.
  LEFT JOIN pg_timezone_names rtz ON rtz.name = NULLIF(pp.attributes->>'timezone', '')
  LEFT JOIN pg_timezone_names dtz ON dtz.name = NULLIF(v_send.default_timezone, '')
  WHERE ls.list_id = v_list_id AND ls.subscribed = true
  ON CONFLICT (send_id, email) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  UPDATE public.newsletter_sends
  SET total_recipients = (SELECT count(*) FROM public.newsletter_send_recipients WHERE send_id = p_send_id),
      updated_at = now()
  WHERE id = p_send_id;

  RETURN v_inserted;
END $$;

COMMENT ON FUNCTION public.fanout_newsletter_send_recipients(uuid) IS
  'Materialise per-recipient send_at rows for a tz_local/personalised send: target_local wall-clock resolved in each recipient timezone (people.attributes->>timezone, else default_timezone, else UTC; validated via pg_timezone_names). Idempotent. Dispatcher then drips via claim_due_newsletter_recipients.';
