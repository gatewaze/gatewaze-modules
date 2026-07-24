-- ============================================================================
-- Module: broadcasts
-- Migration: 019_fanout_batch
-- Description: Chunked broadcast fan-out so large audiences don't hit the ~8s
-- PostgREST/role statement_timeout that was cancelling the single-shot
-- fanout_broadcast_send_recipients ("canceling statement due to statement
-- timeout" → send marked failed, total_recipients=0). Mirrors the newsletters
-- fix (070 default-tz-once + 071 batch): the worker loops this batch function —
-- one keyset-paginated slice per call (each a fast, separate RPC) — until
-- `remaining` is false.
--
-- Preserves the existing audience resolution + all exclusion predicates
-- (suppressions, exclude-sent, category-list intersection, outreach-prospects)
-- and the existing send_at formula. Only changes: (a) validate the default
-- timezone ONCE instead of a per-recipient pg_timezone_names re-scan, and (b)
-- process the audience in email-ordered batches. Idempotent via the email
-- cursor + ON CONFLICT.
-- ============================================================================

-- Index the category-list intersection + list-audience lookups by
-- (list_id, lower(email)) for subscribed rows. Without it the per-recipient
-- category EXISTS did a sequential scan, making fan-out O(n²) (a single 5k
-- batch took >2min). On prod this was created CONCURRENTLY out-of-band; the
-- IF NOT EXISTS here covers fresh installs.
CREATE INDEX IF NOT EXISTS idx_list_subscriptions_list_lower_email
  ON public.list_subscriptions (list_id, lower(email)) WHERE subscribed = true;

CREATE OR REPLACE FUNCTION public.fanout_broadcast_send_recipients_batch(
  p_send_id     uuid,
  p_batch_size  integer DEFAULT 5000,
  p_after_email text    DEFAULT NULL
)
RETURNS TABLE(inserted integer, last_email text, remaining boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_send       public.broadcast_sends%ROWTYPE;
  v_send_date  date;
  v_target     text;
  v_strategy   text;
  v_default_tz text;
  v_anchor     timestamptz;
  v_batch      integer;
BEGIN
  SELECT * INTO v_send FROM public.broadcast_sends WHERE id = p_send_id;
  IF v_send.id IS NULL THEN
    RAISE EXCEPTION 'broadcast_send % not found', p_send_id;
  END IF;
  IF v_send.audience_type = 'segment' AND v_send.segment_id IS NULL THEN
    RAISE EXCEPTION 'broadcast_send % has audience_type=segment but no segment_id', p_send_id;
  END IF;
  IF v_send.audience_type = 'list' AND COALESCE(array_length(v_send.list_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'broadcast_send % has audience_type=list but no list_ids', p_send_id;
  END IF;

  v_batch    := GREATEST(1, LEAST(COALESCE(p_batch_size, 5000), 20000));
  v_strategy := COALESCE(NULLIF(v_send.delivery_strategy, ''), 'global');
  v_target   := COALESCE(NULLIF(v_send.target_local, ''), '09:00');
  v_anchor   := COALESCE(v_send.scheduled_at, now());
  SELECT name INTO v_default_tz
    FROM pg_timezone_names WHERE name = NULLIF(v_send.default_timezone, '') LIMIT 1;
  v_default_tz := COALESCE(v_default_tz, 'UTC');
  v_send_date := (v_anchor AT TIME ZONE v_default_tz)::date;

  RETURN QUERY
  WITH aud AS (
    SELECT pp.id AS person_id, pp.email AS email, pp.attributes AS attributes
    FROM public.segments_memberships sm
    JOIN public.people pp ON pp.id = sm.person_id
    WHERE v_send.audience_type = 'segment'
      AND sm.segment_id = v_send.segment_id
      AND pp.email IS NOT NULL AND pp.email <> ''
    UNION ALL
    SELECT pp.id AS person_id, ls.email AS email, pp.attributes AS attributes
    FROM public.list_subscriptions ls
    LEFT JOIN LATERAL (
      SELECT id, attributes FROM public.people WHERE lower(email) = lower(ls.email) LIMIT 1
    ) pp ON true
    WHERE v_send.audience_type = 'list'
      AND ls.list_id = ANY (v_send.list_ids::uuid[])
      AND ls.subscribed = true
      AND ls.email IS NOT NULL AND ls.email <> ''
  ),
  slice AS (
    SELECT person_id, email, attributes
    FROM aud
    WHERE (p_after_email IS NULL OR email > p_after_email)
    ORDER BY email
    LIMIT v_batch
  ),
  ins AS (
    INSERT INTO public.broadcast_send_recipients (send_id, person_id, email, send_at, status, strategy, timezone)
    SELECT
      p_send_id,
      s.person_id,
      s.email,
      CASE WHEN v_strategy = 'global'
        THEN now()
        -- tz_local / personalised: recipient-local target on the schedule date,
        -- clamped to the schedule time (already-passed → send at schedule time,
        -- never the next day). Mirrors newsletters 072.
        ELSE GREATEST(
          v_anchor,
          ((v_send_date::text || ' ' || v_target)::timestamp AT TIME ZONE COALESCE(rtz.name, v_default_tz))
        )
      END,
      'pending',
      v_strategy,
      COALESCE(rtz.name, v_default_tz)
    FROM slice s
    LEFT JOIN pg_timezone_names rtz ON rtz.name = NULLIF(s.attributes->>'timezone', '')
    WHERE
      NOT EXISTS (
        SELECT 1 FROM public.broadcast_suppressions sup
        WHERE lower(sup.email) = lower(s.email)
          AND (sup.topic = v_send.suppression_topic OR sup.topic = 'all')
      )
      AND (
        v_send.exclude_sent_send_ids IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM public.email_send_log esl
          WHERE esl.broadcast_send_id = ANY (v_send.exclude_sent_send_ids)
            AND esl.sent_at IS NOT NULL
            AND lower(esl.recipient_email) = lower(s.email)
        )
      )
      AND (
        v_send.category_list_id IS NULL
        OR EXISTS (
          SELECT 1 FROM public.list_subscriptions ls2
          WHERE ls2.list_id = v_send.category_list_id
            AND ls2.subscribed = true
            AND lower(ls2.email) = lower(s.email)
        )
      )
      AND (
        v_send.include_prospects
        OR NOT EXISTS (
          SELECT 1 FROM public.people pk
          WHERE lower(pk.email) = lower(s.email)
            AND pk.contact_kind = 'prospect'
        )
      )
    ON CONFLICT (send_id, email) DO NOTHING
    RETURNING 1
  )
  SELECT
    (SELECT count(*) FROM ins)::integer          AS inserted,
    (SELECT max(email) FROM slice)               AS last_email,
    ((SELECT count(*) FROM slice) = v_batch)      AS remaining;
END $$;

GRANT EXECUTE ON FUNCTION public.fanout_broadcast_send_recipients_batch(uuid, integer, text)
  TO authenticated, service_role;
