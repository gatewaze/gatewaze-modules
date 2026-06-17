-- Persist the resolved timezone on each recipient row + a per-timezone
-- breakdown RPC for the Sending UI. Storing the zone (rather than re-joining
-- people at read time) means the breakdown groups cleanly, reflects the exact
-- zone used (incl. default fallback), and survives after the send completes.

ALTER TABLE public.newsletter_send_recipients
  ADD COLUMN IF NOT EXISTS timezone text;

-- Recreate the fan-out so it records the resolved zone on each row. Same logic
-- as migration 040, now also writing `timezone`.
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
  WHERE ls.list_id = v_list_id AND ls.subscribed = true
  ON CONFLICT (send_id, email) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  UPDATE public.newsletter_sends
  SET total_recipients = (SELECT count(*) FROM public.newsletter_send_recipients WHERE send_id = p_send_id),
      updated_at = now()
  WHERE id = p_send_id;

  RETURN v_inserted;
END $$;

-- Backfill rows materialised before the column existed.
UPDATE public.newsletter_send_recipients r
SET timezone = COALESCE(
  (SELECT tzn.name FROM public.people p
     JOIN pg_timezone_names tzn ON tzn.name = NULLIF(p.attributes->>'timezone', '')
     WHERE lower(p.email) = lower(r.email) LIMIT 1),
  (SELECT tzn.name FROM public.newsletter_sends s
     JOIN pg_timezone_names tzn ON tzn.name = NULLIF(s.default_timezone, '')
     WHERE s.id = r.send_id),
  'UTC')
WHERE r.timezone IS NULL;

-- Per-timezone breakdown for the Sending UI: one row per zone with status
-- counts and the (shared) dispatch instant. Ordered by dispatch time so the
-- table reads as the drip schedule. Readable by admins (RLS allows
-- authenticated to read the recipient queue).
CREATE OR REPLACE FUNCTION public.newsletter_send_timezone_breakdown(p_send_id uuid)
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
  FROM public.newsletter_send_recipients r
  WHERE r.send_id = p_send_id
  GROUP BY COALESCE(r.timezone, 'UTC')
  ORDER BY min(r.send_at);
$$;

COMMENT ON FUNCTION public.newsletter_send_timezone_breakdown(uuid) IS
  'Per-timezone status breakdown for a staggered newsletter send (timezone, recipient + per-status counts, dispatch instant), ordered by dispatch time.';
