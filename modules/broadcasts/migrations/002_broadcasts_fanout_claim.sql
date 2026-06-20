-- ============================================================================
-- Module: broadcasts
-- Migration: 002_broadcasts_fanout_claim
-- Description: The send-engine RPCs for broadcasts — direct clones of the proven
-- newsletter fan-out / claim / timezone-breakdown functions (migrations
-- 040/041/044/046/047), with the recipient SOURCE swapped to segment
-- membership (or contact lists) and a compliance-critical suppression filter.
--
-- These mirror newsletters so a future Tier 2 generalization can fold both onto
-- one table-parametric engine (spec-broadcasts-module.md Phase 0). Until then
-- broadcasts ride the same drip pattern newsletters use in production today.
-- ============================================================================

-- 1. Atomic dispatcher claim: pending rows whose send_at has arrived, soonest
--    first, ONLY for actively 'sending' broadcasts (so paused/scheduled/
--    cancelling sends never drip). FOR UPDATE SKIP LOCKED makes overlapping
--    ticks + N worker replicas safe. (cf. claim_due_newsletter_recipients)
CREATE OR REPLACE FUNCTION public.claim_due_broadcast_recipients(p_limit integer DEFAULT 500)
RETURNS SETOF public.broadcast_send_recipients
LANGUAGE sql
AS $$
  UPDATE public.broadcast_send_recipients r
  SET status = 'sending', attempts = r.attempts + 1, updated_at = now()
  FROM (
    SELECT bsr.id
    FROM public.broadcast_send_recipients bsr
    JOIN public.broadcast_sends s ON s.id = bsr.send_id
    WHERE bsr.status = 'pending'
      AND bsr.send_at <= now()
      AND s.status = 'sending'
    ORDER BY bsr.send_at
    LIMIT p_limit
    FOR UPDATE OF bsr SKIP LOCKED
  ) due
  WHERE r.id = due.id
  RETURNING r.*;
$$;

COMMENT ON FUNCTION public.claim_due_broadcast_recipients(integer) IS
  'Atomically claim due broadcast_send_recipients (pending→sending) for the dispatcher; gated on parent status=sending; FOR UPDATE SKIP LOCKED makes overlapping ticks / replicas safe.';

-- 2. Fan-out: materialise one broadcast_send_recipients row per audience member,
--    each with send_at = target_local wall-clock in the recipient's OWN
--    timezone (people.attributes->>'timezone', else default_timezone, else
--    UTC; validated via pg_timezone_names so a junk value falls back instead of
--    aborting). Source = segment membership OR contact lists. Excludes
--    suppressed recipients and any already-sent in exclude_sent_send_ids.
--    Idempotent (ON CONFLICT DO NOTHING). SECURITY DEFINER so the cron/service
--    path can read membership + people regardless of RLS. (cf.
--    fanout_newsletter_send_recipients 047)
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
  -- Large audiences (50k+) blow the default 25s timeout when the per-recipient
  -- timezone resolution runs unindexed. Idempotent — runs once per send.
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
    -- Segment source: materialise the segment membership snapshot.
    SELECT pp.id AS person_id, pp.email AS email, pp.attributes AS attributes
    FROM public.segments_memberships sm
    JOIN public.people pp ON pp.id = sm.person_id
    WHERE v_send.audience_type = 'segment'
      AND sm.segment_id = v_send.segment_id
      AND pp.email IS NOT NULL AND pp.email <> ''
    UNION ALL
    -- Contact-list source (matches the newsletter list path).
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
    -- 'global' = everyone due immediately; 'tz_local'/'personalised' = the
    -- configured wall-clock resolved in each recipient's own timezone. Unifying
    -- on fan-out+drip means one send path for all strategies.
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
    -- Suppression filter (compliance-critical): never email an opted-out /
    -- globally suppressed person, even if they match the segment.
    NOT EXISTS (
      SELECT 1 FROM public.broadcast_suppressions s
      WHERE lower(s.email) = lower(aud.email)
        AND (s.topic = v_send.suppression_topic OR s.topic = 'all')
    )
    -- Exclude recipients already sent in a prior broadcast send. sent_at (not
    -- status) is the lifecycle-stable "already attempted" signal (cf. 047).
    AND (
      v_send.exclude_sent_send_ids IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.email_send_log esl
        WHERE esl.broadcast_send_id = ANY (v_send.exclude_sent_send_ids)
          AND esl.sent_at IS NOT NULL
          AND lower(esl.recipient_email) = lower(aud.email)
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

COMMENT ON FUNCTION public.fanout_broadcast_send_recipients(uuid) IS
  'Materialise per-recipient send_at rows for a broadcast send from segment membership (or contact lists). target_local resolved per recipient timezone; suppression-filtered; excludes prior-send recipients via email_send_log.sent_at. Idempotent. Dispatcher drips via claim_due_broadcast_recipients.';

-- 3. Per-timezone breakdown for the Sending UI (cf.
--    newsletter_send_timezone_breakdown).
CREATE OR REPLACE FUNCTION public.broadcast_send_timezone_breakdown(p_send_id uuid)
RETURNS TABLE (
  timezone   text,
  recipients bigint,
  sent       bigint,
  failed     bigint,
  pending    bigint,
  skipped    bigint,
  send_at    timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COALESCE(r.timezone, 'UTC') AS timezone,
    count(*) AS recipients,
    count(*) FILTER (WHERE r.status = 'sent') AS sent,
    count(*) FILTER (WHERE r.status = 'failed') AS failed,
    count(*) FILTER (WHERE r.status IN ('pending', 'sending')) AS pending,
    count(*) FILTER (WHERE r.status = 'skipped') AS skipped,
    min(r.send_at) AS send_at
  FROM public.broadcast_send_recipients r
  WHERE r.send_id = p_send_id
  GROUP BY COALESCE(r.timezone, 'UTC')
  ORDER BY min(r.send_at);
$$;

COMMENT ON FUNCTION public.broadcast_send_timezone_breakdown(uuid) IS
  'Per-timezone status breakdown for a staggered broadcast send, ordered by dispatch time.';
