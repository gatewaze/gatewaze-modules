-- ============================================================================
-- Module: broadcasts
-- Migration: 010_broadcast_list_intersection
-- Description: A broadcast now sends ONLY to segment/list-audience members who
-- are ALSO subscribers of the chosen unsubscribe list (category_list_id). Both
-- the preview count and the fan-out cross-reference the audience with
-- list_subscriptions(category_list_id, subscribed=true), so cold contacts not on
-- the list are excluded and the "will send to N" count matches the real send.
-- ============================================================================

-- 1. Preview count — add p_category_list_id + intersect with its subscribers.
--    (Drop the old 5-arg signature so PostgREST resolves the new one cleanly.)
DROP FUNCTION IF EXISTS public.broadcast_recipient_preview_count(text, uuid, uuid[], text, uuid[]);

CREATE OR REPLACE FUNCTION public.broadcast_recipient_preview_count(
  p_audience_type     text,
  p_segment_id        uuid,
  p_list_ids          uuid[],
  p_suppression_topic text   DEFAULT 'broadcasts',
  p_exclude_send_ids  uuid[] DEFAULT NULL,
  p_category_list_id  uuid   DEFAULT NULL
) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH aud AS (
    SELECT pp.email AS email
    FROM public.segments_memberships sm
    JOIN public.people pp ON pp.id = sm.person_id
    WHERE p_audience_type = 'segment'
      AND p_segment_id IS NOT NULL
      AND sm.segment_id = p_segment_id
      AND pp.email IS NOT NULL AND pp.email <> ''
    UNION ALL
    SELECT ls.email AS email
    FROM public.list_subscriptions ls
    WHERE p_audience_type = 'list'
      AND COALESCE(array_length(p_list_ids, 1), 0) > 0
      AND ls.list_id = ANY (p_list_ids)
      AND ls.subscribed = true
      AND ls.email IS NOT NULL AND ls.email <> ''
  )
  SELECT COUNT(DISTINCT lower(aud.email))::integer
  FROM aud
  WHERE
    NOT EXISTS (
      SELECT 1 FROM public.broadcast_suppressions s
      WHERE lower(s.email) = lower(aud.email)
        AND (s.topic = p_suppression_topic OR s.topic = 'all')
    )
    AND (
      p_exclude_send_ids IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.email_send_log esl
        WHERE esl.broadcast_send_id = ANY (p_exclude_send_ids)
          AND esl.sent_at IS NOT NULL
          AND lower(esl.recipient_email) = lower(aud.email)
      )
    )
    -- Cross-reference: only members who are subscribers of the chosen list.
    -- NULL list → no filter (segment size shown until a list is picked).
    AND (
      p_category_list_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.list_subscriptions ls2
        WHERE ls2.list_id = p_category_list_id
          AND ls2.subscribed = true
          AND lower(ls2.email) = lower(aud.email)
      )
    );
$fn$;

COMMENT ON FUNCTION public.broadcast_recipient_preview_count(text, uuid, uuid[], text, uuid[], uuid) IS
  'Deliverable recipient count for a broadcast: audience (segment or lists) minus suppressions/prior-sends, intersected with the chosen unsubscribe list''s subscribers. Mirrors fanout_broadcast_send_recipients.';

-- 2. Fan-out — apply the same list-subscriber intersection so the real send
--    matches the preview. Reproduces migration 002/047's body with the extra
--    predicate on the audience.
CREATE OR REPLACE FUNCTION public.fanout_broadcast_send_recipients(p_send_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_send       public.broadcast_sends%ROWTYPE;
  v_send_date  date;
  v_target     text;
  v_inserted   integer;
BEGIN
  SET LOCAL statement_timeout = '10min';

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

  v_target := COALESCE(NULLIF(v_send.target_local, ''), '09:00');
  v_send_date := (COALESCE(v_send.scheduled_at, now())
                    AT TIME ZONE COALESCE(NULLIF(v_send.default_timezone, ''), 'UTC'))::date;

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
  )
  INSERT INTO public.broadcast_send_recipients (send_id, person_id, email, send_at, status, strategy, timezone)
  SELECT
    p_send_id,
    aud.person_id,
    aud.email,
    CASE WHEN COALESCE(NULLIF(v_send.delivery_strategy, ''), 'global') = 'global'
      THEN now()
      ELSE ((v_send_date::text || ' ' || v_target)::timestamp
              AT TIME ZONE COALESCE(rtz.name, dtz.name, 'UTC'))
    END,
    'pending',
    COALESCE(NULLIF(v_send.delivery_strategy, ''), 'global'),
    COALESCE(rtz.name, dtz.name, 'UTC')
  FROM aud
  LEFT JOIN pg_timezone_names rtz ON rtz.name = NULLIF(aud.attributes->>'timezone', '')
  LEFT JOIN pg_timezone_names dtz ON dtz.name = NULLIF(v_send.default_timezone, '')
  WHERE
    NOT EXISTS (
      SELECT 1 FROM public.broadcast_suppressions s
      WHERE lower(s.email) = lower(aud.email)
        AND (s.topic = v_send.suppression_topic OR s.topic = 'all')
    )
    AND (
      v_send.exclude_sent_send_ids IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.email_send_log esl
        WHERE esl.broadcast_send_id = ANY (v_send.exclude_sent_send_ids)
          AND esl.sent_at IS NOT NULL
          AND lower(esl.recipient_email) = lower(aud.email)
      )
    )
    -- Cross-reference the audience with the unsubscribe list's subscribers.
    AND (
      v_send.category_list_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.list_subscriptions ls2
        WHERE ls2.list_id = v_send.category_list_id
          AND ls2.subscribed = true
          AND lower(ls2.email) = lower(aud.email)
      )
    )
  ON CONFLICT (send_id, email) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  UPDATE public.broadcast_sends
  SET total_recipients = (SELECT count(*) FROM public.broadcast_send_recipients WHERE send_id = p_send_id),
      updated_at = now()
  WHERE id = p_send_id;

  RETURN v_inserted;
END $$;
