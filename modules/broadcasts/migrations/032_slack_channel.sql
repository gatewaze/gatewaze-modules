-- ============================================================================
-- Module: broadcasts
-- Migration: 032_slack_channel
-- Description: Slack as a second broadcast channel. A Slack broadcast sends a
-- direct message to each person in its segment who is linked to a Slack
-- member (people.attributes.slack_user_id, written by the slack module).
--
-- A Slack send is not tied to an email list, so the fan-out ignores list
-- subscriptions. It still skips:
--   - people opted out of Slack broadcasts (broadcast_suppressions, topic
--     'slack') or of everything (topic 'all'), and
--   - outreach prospects unless the send includes them.
-- Compliance erasure is applied by the send engine for every channel.
--
-- The worker sends Slack recipients on their own paced drip
-- (claim_due_broadcast_slack_recipients), so the email claim now skips them.
-- ============================================================================

-- 1. Channel ------------------------------------------------------------------
ALTER TABLE public.broadcast_sends DROP CONSTRAINT IF EXISTS broadcast_sends_channel_check;
ALTER TABLE public.broadcast_sends
  ADD CONSTRAINT broadcast_sends_channel_check CHECK (channel IN ('email', 'slack'));

ALTER TABLE public.broadcasts DROP CONSTRAINT IF EXISTS broadcasts_channel_check;
ALTER TABLE public.broadcasts
  ADD CONSTRAINT broadcasts_channel_check CHECK (channel IN ('email', 'slack'));

-- Who a Slack broadcast is sent as: the workspace bot (SLACK_BOT_TOKEN), or
-- the account connected for welcome DMs. Copied onto each send's metadata.
ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS slack_sender text NOT NULL DEFAULT 'bot';
ALTER TABLE public.broadcasts DROP CONSTRAINT IF EXISTS broadcasts_slack_sender_check;
ALTER TABLE public.broadcasts
  ADD CONSTRAINT broadcasts_slack_sender_check CHECK (slack_sender IN ('bot', 'welcome_sender'));

-- The Slack member a recipient row is addressed to (NULL for email).
ALTER TABLE public.broadcast_send_recipients
  ADD COLUMN IF NOT EXISTS slack_user_id text;

-- 2. Preheader rule is email-only (a Slack message has no inbox preview) ------
CREATE OR REPLACE FUNCTION public.broadcast_sends_require_preheader()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.channel = 'email' AND btrim(coalesce(NEW.preheader, '')) = '' THEN
    RAISE EXCEPTION 'A preheader is required before sending. Add one in Email details and save.'
      USING ERRCODE = 'check_violation',
            HINT = 'Gmail files emails without a preheader as spam.';
  END IF;
  RETURN NEW;
END $$;

-- 3. Slack fan-out ------------------------------------------------------------
-- Same paging contract as fanout_broadcast_send_recipients_batch (keyset on
-- email, so the dispatcher loops it unchanged). One row per Slack member: a
-- member linked to two people rows gets one message.
CREATE OR REPLACE FUNCTION public.fanout_broadcast_slack_recipients_batch(
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
  IF v_send.channel <> 'slack' THEN
    RAISE EXCEPTION 'broadcast_send % is not a Slack send', p_send_id;
  END IF;
  IF v_send.audience_type <> 'segment' OR v_send.segment_id IS NULL THEN
    RAISE EXCEPTION 'A Slack broadcast needs a segment audience (send %)', p_send_id;
  END IF;

  v_batch    := GREATEST(1, LEAST(COALESCE(p_batch_size, 5000), 20000));
  v_strategy := COALESCE(NULLIF(v_send.delivery_strategy, ''), 'global');
  v_target   := COALESCE(NULLIF(v_send.target_local, ''), '09:00');
  v_anchor   := COALESCE(v_send.scheduled_at, now());
  SELECT name INTO v_default_tz
    FROM pg_timezone_names WHERE name = NULLIF(v_send.default_timezone, '') LIMIT 1;
  v_default_tz := COALESCE(v_default_tz, 'UTC');

  RETURN QUERY
  WITH slice AS (
    SELECT pp.id AS person_id, pp.email AS email, pp.attributes AS attributes,
           btrim(pp.attributes->>'slack_user_id') AS slack_user_id,
           pp.contact_kind AS contact_kind
    FROM public.segments_memberships sm
    JOIN public.people pp ON pp.id = sm.person_id
    WHERE sm.segment_id = v_send.segment_id
      AND pp.email IS NOT NULL AND pp.email <> ''
      AND (p_after_email IS NULL OR pp.email > p_after_email)
    ORDER BY pp.email
    LIMIT v_batch
  ),
  elig AS (
    SELECT DISTINCT ON (s.slack_user_id) s.*
    FROM slice s
    WHERE s.slack_user_id ~ '^[UW][A-Z0-9]{2,}$'
      AND NOT EXISTS (
        SELECT 1 FROM public.broadcast_suppressions sup
        WHERE lower(sup.email) = lower(s.email)
          AND (sup.topic = v_send.suppression_topic OR sup.topic = 'all')
      )
      AND (
        v_send.exclude_sent_send_ids IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM public.broadcast_send_recipients prev
          WHERE prev.send_id = ANY (v_send.exclude_sent_send_ids)
            AND prev.email = s.email
            AND prev.status = 'sent'
        )
      )
      AND (v_send.include_prospects OR s.contact_kind IS DISTINCT FROM 'prospect')
      -- A member already queued for this send from an earlier page (linked
      -- to a second person row) is not messaged twice.
      AND NOT EXISTS (
        SELECT 1 FROM public.broadcast_send_recipients dup
        WHERE dup.send_id = p_send_id AND dup.slack_user_id = s.slack_user_id
      )
    ORDER BY s.slack_user_id, s.email
  ),
  ins AS (
    INSERT INTO public.broadcast_send_recipients (send_id, person_id, email, slack_user_id, send_at, status, strategy, timezone)
    SELECT
      p_send_id,
      e.person_id,
      e.email,
      e.slack_user_id,
      CASE WHEN v_strategy = 'global'
        THEN now()
        ELSE public.gw_tz_local_send_at(v_anchor, v_target, COALESCE(rtz.name, v_default_tz))
      END,
      'pending',
      v_strategy,
      COALESCE(rtz.name, v_default_tz)
    FROM elig e
    LEFT JOIN pg_timezone_names rtz ON rtz.name = NULLIF(e.attributes->>'timezone', '')
    ON CONFLICT (send_id, email) DO NOTHING
    RETURNING 1
  )
  SELECT
    (SELECT count(*) FROM ins)::integer          AS inserted,
    (SELECT max(email) FROM slice)               AS last_email,
    ((SELECT count(*) FROM slice) = v_batch)      AS remaining;
END $$;

REVOKE ALL ON FUNCTION public.fanout_broadcast_slack_recipients_batch(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fanout_broadcast_slack_recipients_batch(uuid, integer, text) TO service_role;

-- The dispatcher calls fanout_broadcast_send_recipients_batch for every send.
-- Route Slack sends to the function above; the email body is migration 021's,
-- unchanged.
CREATE OR REPLACE FUNCTION public.fanout_broadcast_send_recipients_batch(p_send_id uuid, p_batch_size integer DEFAULT 5000, p_after_email text DEFAULT NULL::text)
 RETURNS TABLE(inserted integer, last_email text, remaining boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_send       public.broadcast_sends%ROWTYPE;
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
  IF v_send.channel = 'slack' THEN
    RETURN QUERY SELECT * FROM public.fanout_broadcast_slack_recipients_batch(p_send_id, p_batch_size, p_after_email);
    RETURN;
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
        ELSE public.gw_tz_local_send_at(v_anchor, v_target, COALESCE(rtz.name, v_default_tz))
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
END $function$;

-- Fan-out runs only from the worker (service role, or the table owner over
-- DATABASE_URL). It was granted to authenticated in 019 with no guard, so any
-- signed-in user could page a send's audience out through last_email.
REVOKE ALL ON FUNCTION public.fanout_broadcast_send_recipients_batch(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fanout_broadcast_send_recipients_batch(uuid, integer, text) TO service_role;

-- 4. Claims: email and Slack drip separately ----------------------------------
-- Slack is sent one message at a time; sharing the email claim would let a
-- Slack backlog fill every email claim. Email claim: migration 002's, plus
-- the channel filter.
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
      AND s.channel <> 'slack'
    ORDER BY bsr.send_at
    LIMIT p_limit
    FOR UPDATE OF bsr SKIP LOCKED
  ) due
  WHERE r.id = due.id
  RETURNING r.*;
$$;

CREATE OR REPLACE FUNCTION public.claim_due_broadcast_slack_recipients(p_limit integer DEFAULT 10)
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
      AND s.channel = 'slack'
    ORDER BY bsr.send_at, bsr.id
    LIMIT p_limit
    FOR UPDATE OF bsr SKIP LOCKED
  ) due
  WHERE r.id = due.id
  RETURNING r.*;
$$;

REVOKE ALL ON FUNCTION public.claim_due_broadcast_slack_recipients(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_broadcast_slack_recipients(integer) TO service_role;

-- 5. Deliverable count for the Slack sending panel ----------------------------
-- Mirrors the fan-out filters above.
CREATE OR REPLACE FUNCTION public.broadcast_slack_recipient_preview_count(
  p_segment_id        uuid,
  p_exclude_send_ids  uuid[]  DEFAULT NULL,
  p_include_prospects boolean DEFAULT false
) RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(auth.role() = 'service_role', false)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_segment_id IS NULL THEN
    RETURN 0;
  END IF;
  SELECT count(DISTINCT btrim(pp.attributes->>'slack_user_id'))::integer INTO v_count
  FROM public.segments_memberships sm
  JOIN public.people pp ON pp.id = sm.person_id
  WHERE sm.segment_id = p_segment_id
    AND pp.email IS NOT NULL AND pp.email <> ''
    AND btrim(pp.attributes->>'slack_user_id') ~ '^[UW][A-Z0-9]{2,}$'
    AND NOT EXISTS (
      SELECT 1 FROM public.broadcast_suppressions sup
      WHERE lower(sup.email) = lower(pp.email) AND sup.topic IN ('slack', 'all')
    )
    AND (
      p_exclude_send_ids IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.broadcast_send_recipients prev
        WHERE prev.send_id = ANY (p_exclude_send_ids)
          AND prev.email = pp.email
          AND prev.status = 'sent'
      )
    )
    AND (p_include_prospects OR pp.contact_kind IS DISTINCT FROM 'prospect');
  RETURN COALESCE(v_count, 0);
END $$;

REVOKE ALL ON FUNCTION public.broadcast_slack_recipient_preview_count(uuid, uuid[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broadcast_slack_recipient_preview_count(uuid, uuid[], boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.fanout_broadcast_slack_recipients_batch(uuid, integer, text) IS
  'Slack broadcast fan-out: one recipient row per Slack-linked person in the segment, minus Slack opt-outs, prior-send recipients and (unless included) prospects. No list subscription filter.';
COMMENT ON FUNCTION public.claim_due_broadcast_slack_recipients(integer) IS
  'Claim due recipients of sending Slack broadcasts for the paced Slack drip. The email claim skips these.';

-- 6. Admin-only access ---------------------------------------------------------
-- 001 and 006 let any authenticated user read and write these tables. Signed-in
-- community members hold authenticated sessions (LFID), and a Slack send row
-- plus recipient rows would now be enough to DM anyone in the workspace, so
-- limit them to admins. The worker, edge functions and API use the service
-- role, which RLS does not apply to. (SELECT ...) evaluates is_admin() once
-- per query rather than per row.
DROP POLICY IF EXISTS "auth_all_broadcasts" ON public.broadcasts;
DROP POLICY IF EXISTS "admin_all_broadcasts" ON public.broadcasts;
CREATE POLICY "admin_all_broadcasts" ON public.broadcasts
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "auth_all_broadcast_sends" ON public.broadcast_sends;
DROP POLICY IF EXISTS "admin_all_broadcast_sends" ON public.broadcast_sends;
CREATE POLICY "admin_all_broadcast_sends" ON public.broadcast_sends
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "auth_all_broadcast_send_recipients" ON public.broadcast_send_recipients;
DROP POLICY IF EXISTS "admin_all_broadcast_send_recipients" ON public.broadcast_send_recipients;
CREATE POLICY "admin_all_broadcast_send_recipients" ON public.broadcast_send_recipients
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "auth_all_broadcast_suppressions" ON public.broadcast_suppressions;
DROP POLICY IF EXISTS "admin_all_broadcast_suppressions" ON public.broadcast_suppressions;
CREATE POLICY "admin_all_broadcast_suppressions" ON public.broadcast_suppressions
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

-- 004 created the batch table without RLS. A forged 'posting' batch row lets
-- crash recovery mark or release recipients, so admins only here too.
ALTER TABLE public.broadcast_send_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin_all_broadcast_send_batches" ON public.broadcast_send_batches;
CREATE POLICY "admin_all_broadcast_send_batches" ON public.broadcast_send_batches
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));
