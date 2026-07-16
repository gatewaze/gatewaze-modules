-- ============================================================================
-- Module: newsletters
-- Migration: 071_fanout_batch
-- Description: Chunked fanout so large tz_local sends never approach the 8s
-- PostgREST/role statement_timeout that was cancelling the single-shot fanout
-- (~5-12s for 60k, load-dependent → intermittent "canceling statement due to
-- statement timeout" → send marked failed).
--
-- fanout_newsletter_send_recipients_batch processes ONE slice per call using
-- keyset pagination over the existing unique index (list_id, email). The worker
-- (newsletters:dispatch-scheduled) calls it in a loop — each call is a separate,
-- fast (~1-2s) RPC statement — until `remaining` is false, then flips the send
-- to 'sending'. Idempotent: ON CONFLICT DO NOTHING, and the keyset cursor
-- advances by email regardless of how many rows actually inserted, so a retry
-- resumes cleanly. send_at uses the same 068 roll-forward + 070 default-tz-once
-- logic. The single-shot fanout_newsletter_send_recipients is left in place for
-- small/immediate callers.
--
-- Additive: new function only, no schema change.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fanout_newsletter_send_recipients_batch(
  p_send_id     uuid,
  p_batch_size  integer DEFAULT 5000,
  p_after_email text    DEFAULT NULL
)
RETURNS TABLE(inserted integer, last_email text, remaining boolean)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_send        public.newsletter_sends%ROWTYPE;
  v_list_id     uuid;
  v_target      text;
  v_strategy    text;
  v_anchor      timestamptz;
  v_default_tz  text;
  v_batch       integer;
BEGIN
  SELECT * INTO v_send FROM public.newsletter_sends WHERE id = p_send_id;
  IF v_send.id IS NULL THEN
    RAISE EXCEPTION 'newsletter_send % not found', p_send_id;
  END IF;

  v_list_id := (v_send.list_ids)[1];
  IF v_list_id IS NULL THEN
    RAISE EXCEPTION 'newsletter_send % has no list_ids to fan out', p_send_id;
  END IF;

  v_batch    := GREATEST(1, LEAST(COALESCE(p_batch_size, 5000), 20000));
  v_strategy := COALESCE(NULLIF(v_send.delivery_strategy, ''), 'tz_local');
  v_target   := COALESCE(NULLIF(v_send.target_local, ''), '09:00');
  v_anchor   := COALESCE(v_send.scheduled_at, now());

  -- Validate the send's default timezone once (see 070).
  SELECT name INTO v_default_tz
    FROM pg_timezone_names WHERE name = NULLIF(v_send.default_timezone, '') LIMIT 1;
  v_default_tz := COALESCE(v_default_tz, 'UTC');

  RETURN QUERY
  WITH slice AS (
    -- One keyset page of this list's subscribers, ordered by email so the
    -- caller can resume from `last_email`. Uses the unique (list_id, email)
    -- index for an index-range scan (no full sort/offset).
    SELECT ls.email
    FROM public.list_subscriptions ls
    WHERE ls.list_id = v_list_id
      AND ls.subscribed = true
      AND (p_after_email IS NULL OR ls.email > p_after_email)
      AND (
        v_send.exclude_sent_send_ids IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM public.email_send_log esl
          WHERE esl.newsletter_send_id = ANY (v_send.exclude_sent_send_ids)
            AND esl.sent_at IS NOT NULL
            AND lower(esl.recipient_email) = lower(ls.email)
        )
      )
    ORDER BY ls.email
    LIMIT v_batch
  ),
  ins AS (
    INSERT INTO public.newsletter_send_recipients
      (send_id, person_id, email, send_at, status, strategy, timezone)
    SELECT
      p_send_id,
      pp.id,
      s.email,
      CASE
        WHEN v_strategy = 'global' THEN now()
        ELSE (
          (date_trunc('day', (v_anchor AT TIME ZONE tzn.name)) + v_target::time)
          + CASE
              WHEN (date_trunc('day', (v_anchor AT TIME ZONE tzn.name)) + v_target::time)
                   >= (v_anchor AT TIME ZONE tzn.name)
              THEN interval '0 day'
              ELSE interval '1 day'
            END
        ) AT TIME ZONE tzn.name
      END,
      'pending',
      v_strategy,
      tzn.name
    FROM slice s
    LEFT JOIN LATERAL (
      SELECT id, attributes FROM public.people
      WHERE lower(email) = lower(s.email)
      LIMIT 1
    ) pp ON true
    LEFT JOIN pg_timezone_names rtz ON rtz.name = NULLIF(pp.attributes->>'timezone', '')
    CROSS JOIN LATERAL (SELECT COALESCE(rtz.name, v_default_tz) AS name) tzn
    ON CONFLICT (send_id, email) DO NOTHING
    RETURNING 1
  )
  SELECT
    (SELECT count(*) FROM ins)::integer         AS inserted,
    (SELECT max(email) FROM slice)              AS last_email,
    -- A full page implies there may be more; a short page is the end.
    ((SELECT count(*) FROM slice) = v_batch)     AS remaining;
END $function$;

GRANT EXECUTE ON FUNCTION public.fanout_newsletter_send_recipients_batch(uuid, integer, text)
  TO authenticated, service_role;
