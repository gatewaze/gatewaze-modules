-- ============================================================================
-- Module: newsletters
-- Migration: 046_fanout_large_list_perf
-- Description: Make fanout_newsletter_send_recipients survive a 56k+ list.
--
-- Symptom: a scheduled tz_local send on the MLOps Community newsletter (56k
-- subscribers) flipped to status='failed' the moment the dispatcher tick
-- fired. Repro under psql:
--
--   SELECT public.fanout_newsletter_send_recipients('89c46265-…'::uuid);
--   ERROR:  canceling statement due to statement timeout
--   CONTEXT: SQL statement "INSERT INTO public.newsletter_send_recipients …
--
-- The fan-out INSERT does a LATERAL lookup against `people` for every
-- subscriber to resolve a per-recipient timezone. Without a functional index
-- on `lower(people.email)` that's 56k full-table-scan-with-LIMIT-1 lookups
-- per execution; PostgreSQL's default statement timeout (25s on Supabase
-- Edge connections) lapses before the insert completes and the whole
-- function rolls back with zero recipients materialised. The send then sits
-- on status='failed' with no diagnostic of WHY it failed beyond the
-- exception text the JS caller never logged.
--
-- This migration does two surgical things:
--
--   1. CREATE INDEX IF NOT EXISTS idx_people_lower_email ON public.people
--      USING btree (lower(email)). Drops the LATERAL lookup from a seq
--      scan to an index probe. Used by every send-time path that matches
--      a subscriber email to its person row (the fan-out here, the
--      newsletter-unsubscribe edge fn's token verification, the
--      merge-field attribute load), so the index pays for itself many
--      times over.
--
--   2. SET LOCAL statement_timeout = '10min' inside
--      fanout_newsletter_send_recipients so a one-off slow fan-out
--      (large list, hot connection, lock contention) doesn't get killed
--      before it finishes. 10 minutes is the upper bound; the actual
--      runtime on AAIF + the new index should drop to seconds.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_people_lower_email
  ON public.people USING btree (lower(email));

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
  -- Large lists (56k+) blow through the default 25s timeout when the
  -- LATERAL lookup hits unindexed paths. Idempotent — the function only
  -- runs once per send via the dispatcher.
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

COMMENT ON FUNCTION public.fanout_newsletter_send_recipients(uuid) IS
  'Materialise per-recipient send_at rows for a tz_local/personalised send: target_local wall-clock resolved in each recipient timezone (people.attributes->>timezone, else default_timezone, else UTC; validated via pg_timezone_names). Idempotent. Dispatcher then drips via claim_due_newsletter_recipients. Survives 56k+ lists via the lower(email) index added here and a per-call 10min statement_timeout.';
