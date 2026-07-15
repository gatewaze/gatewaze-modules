-- ============================================================================
-- Module: broadcasts
-- Migration: 014_broadcast_prospect_gating
-- Description: Outreach prospects (people.contact_kind = 'prospect' — contacts
-- stored under legitimate interest who have NOT opted in) are excluded from
-- broadcast sends by default. A send only reaches prospects when its
-- include_prospects flag is explicitly set (the wizard's "outreach send"
-- toggle). Enforced in BOTH duplicated audience resolvers — the preview count
-- and the fan-out — so "will send to N" always matches the real send.
--
-- The people.contact_kind column is owned by the people/community module's
-- contact-kind migration; the guard here only covers fresh installs where this
-- module migrates first.
-- ============================================================================

-- Lawful-basis discriminator (authoritative definition lives with the people
-- module; identical idempotent ADD so migration order doesn't matter).
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS contact_kind text NOT NULL DEFAULT 'member';

-- Fast lower(email) lookups for the prospect-exclusion predicate.
CREATE INDEX IF NOT EXISTS idx_people_email_lower ON public.people (lower(email));

-- The explicit opt-in flag, on the parent (wizard state) and on each send
-- (snapshot the fan-out reads).
ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS include_prospects boolean NOT NULL DEFAULT false;
ALTER TABLE public.broadcast_sends
  ADD COLUMN IF NOT EXISTS include_prospects boolean NOT NULL DEFAULT false;

-- 1. Preview count — add p_include_prospects. (Drop the old 6-arg signature so
--    PostgREST resolves the new one cleanly.)
DROP FUNCTION IF EXISTS public.broadcast_recipient_preview_count(text, uuid, uuid[], text, uuid[], uuid);

CREATE OR REPLACE FUNCTION public.broadcast_recipient_preview_count(
  p_audience_type     text,
  p_segment_id        uuid,
  p_list_ids          uuid[],
  p_suppression_topic text    DEFAULT 'broadcasts',
  p_exclude_send_ids  uuid[]  DEFAULT NULL,
  p_category_list_id  uuid    DEFAULT NULL,
  p_include_prospects boolean DEFAULT false
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
    )
    -- Outreach prospects are excluded unless this send explicitly opts in.
    -- Applied by email across BOTH audience branches (a staff-imported list
    -- subscription is not consent), and conservatively: any prospect person
    -- row on the address excludes it.
    AND (
      p_include_prospects
      OR NOT EXISTS (
        SELECT 1 FROM public.people pk
        WHERE lower(pk.email) = lower(aud.email)
          AND pk.contact_kind = 'prospect'
      )
    );
$fn$;

COMMENT ON FUNCTION public.broadcast_recipient_preview_count(text, uuid, uuid[], text, uuid[], uuid, boolean) IS
  'Deliverable recipient count for a broadcast: audience (segment or lists) minus suppressions/prior-sends/outreach-prospects (unless p_include_prospects), intersected with the chosen unsubscribe list''s subscribers. Mirrors fanout_broadcast_send_recipients.';

-- 2. Fan-out — same prospect exclusion, driven by the send row's
--    include_prospects snapshot. Reproduces migration 010's body plus the
--    extra predicate.
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
    -- Outreach prospects are excluded unless this send explicitly opts in
    -- (see broadcast_recipient_preview_count — predicates must stay in sync).
    AND (
      v_send.include_prospects
      OR NOT EXISTS (
        SELECT 1 FROM public.people pk
        WHERE lower(pk.email) = lower(aud.email)
          AND pk.contact_kind = 'prospect'
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
