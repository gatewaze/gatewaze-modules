-- ============================================================================
-- Module: broadcasts
-- Migration: 023_broadcast_engagement_cache
-- Description: Cache broadcast engagement. broadcast_engagement was a live
-- computation over email_send_log/email_interactions (~4s per broadcast, ~28s
-- for all of them) with no cache, so the broadcasts table timed out under the
-- 8s PostgREST cap. Mirror the newsletter snapshot cache: rename the live query
-- to broadcast_engagement_live, add a snapshot table + data-version, and make
-- broadcast_engagement a SECURITY DEFINER wrapper that serves cached results for
-- completed broadcasts (auto-caching on first read) and computes live only for
-- still-sending ones. SECURITY DEFINER so the cache lookup + snapshot writes run
-- without per-row RLS over the huge interaction tables (the invoker path was the
-- slow one).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.broadcast_engagement_live(p_broadcast_ids uuid[])
 RETURNS TABLE(broadcast_id uuid, sent bigint, delivered bigint, unique_opens bigint, unique_clicks bigint, human_opens bigint, human_clicks bigint, machine_opens bigint, machine_clicks bigint, human_source text, bounced bigint, unsubscribed bigint, suppressed bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET statement_timeout TO '25s'
AS $function$
  WITH consts AS (SELECT 0.7265::numeric AS g, 0.0212::numeric AS r),
  sends AS (
    SELECT s.id, s.broadcast_id,
           s.list_ids::text[] AS list_ids,
           s.started_at, s.scheduled_at
    FROM public.broadcast_sends s
    WHERE s.broadcast_id = ANY(p_broadcast_ids)
  ),
  -- genuine opt-outs on this send's lists, at/after the send started.
  unsubs AS (
    SELECT DISTINCT lower(ls.email) AS email
    FROM public.list_subscriptions ls
    WHERE ls.subscribed = false
      AND NOT (COALESCE(ls.source, '') ILIKE 'list-hygiene%' OR COALESCE(ls.source, '') ILIKE '%bounce%')
      AND ls.list_id IN (SELECT unnest(list_ids)::uuid FROM sends WHERE COALESCE(array_length(list_ids, 1), 0) > 0)
      AND ls.unsubscribed_at >= (
        SELECT COALESCE(MIN(COALESCE(started_at, scheduled_at)), '1970-01-01'::timestamptz) FROM sends
      )
  ),
  -- list-hygiene removals (bounces/inactivity) on this send's lists.
  supp AS (
    SELECT DISTINCT lower(ls.email) AS email
    FROM public.list_subscriptions ls
    WHERE ls.subscribed = false
      AND (COALESCE(ls.source, '') ILIKE 'list-hygiene%' OR COALESCE(ls.source, '') ILIKE '%bounce%')
      AND ls.list_id IN (SELECT unnest(list_ids)::uuid FROM sends WHERE COALESCE(array_length(list_ids, 1), 0) > 0)
  ),
  recip AS (
    SELECT s.broadcast_id, lower(l.recipient_email) AS email,
      (l.first_opened_at IS NOT NULL)  AS opened,
      (l.first_clicked_at IS NOT NULL) AS clicked,
      (l.delivered_at IS NOT NULL)     AS delivered,
      (l.status = 'bounced')           AS bounced,
      EXISTS (SELECT 1 FROM unsubs u WHERE u.email = lower(l.recipient_email)) AS unsubscribed,
      EXISTS (SELECT 1 FROM supp  p WHERE p.email = lower(l.recipient_email)) AS suppressed
    FROM sends s JOIN public.email_send_log l ON l.broadcast_send_id = s.id
  ),
  ours AS (
    SELECT broadcast_id,
      count(DISTINCT email)                             AS sent,
      count(DISTINCT email) FILTER (WHERE delivered)    AS delivered,
      count(DISTINCT email) FILTER (WHERE opened)       AS unique_opens,
      count(DISTINCT email) FILTER (WHERE clicked)      AS unique_clicks,
      count(DISTINCT email) FILTER (WHERE bounced)      AS bounced,
      count(DISTINCT email) FILTER (WHERE unsubscribed) AS unsubscribed,
      count(DISTINCT email) FILTER (WHERE suppressed)   AS suppressed
    FROM recip GROUP BY broadcast_id
  ),
  -- per-(broadcast, recipient) human flags, MEASURED from the webhook detector.
  cls AS (
    SELECT s.broadcast_id, lower(esl.recipient_email) AS email,
      bool_or(ei.event_type = 'open'  AND ei.human_confidence >= 0.5) AS has_human_open,
      bool_or(ei.event_type = 'click' AND ei.human_confidence >= 0.5) AS has_human_click,
      bool_or(ei.event_type = 'open')  AS has_open,
      bool_or(ei.event_type = 'open')  AS scored_open,
      bool_or(ei.event_type = 'click') AS scored_click
    FROM sends s
    JOIN public.email_send_log esl ON esl.broadcast_send_id = s.id
    JOIN public.email_interactions ei ON ei.email_send_log_id = esl.id
    WHERE ei.scorer_id IS NOT NULL AND ei.event_type IN ('open', 'click')
    GROUP BY s.broadcast_id, lower(esl.recipient_email)
  ),
  sig AS (
    SELECT broadcast_id,
      bool_or(scored_open)  AS scored_opens,
      bool_or(scored_click) AS scored_clicks
    FROM cls GROUP BY broadcast_id
  ),
  humans AS (
    SELECT broadcast_id,
      count(*) FILTER (WHERE has_open AND (has_human_open OR has_human_click)) AS human_openers,
      count(*) FILTER (WHERE has_human_click)                                  AS human_clickers
    FROM cls GROUP BY broadcast_id
  ),
  hc AS (
    SELECT bid AS broadcast_id,
      CASE WHEN sg.scored_clicks THEN COALESCE(hm.human_clickers, 0)
           WHEN COALESCE(o.unique_clicks, 0) > 0 THEN round(o.unique_clicks * k.g)::bigint
           ELSE NULL END AS human_clicks
    FROM unnest(p_broadcast_ids) AS bid
    CROSS JOIN consts k
    LEFT JOIN ours o    ON o.broadcast_id = bid
    LEFT JOIN sig sg    ON sg.broadcast_id = bid
    LEFT JOIN humans hm ON hm.broadcast_id = bid
  )
  SELECT bid AS broadcast_id,
    COALESCE(o.sent, 0), COALESCE(o.delivered, 0),
    COALESCE(o.unique_opens, 0), COALESCE(o.unique_clicks, 0),
    -- human_opens: measured (scored) or calibrated estimate, floored at human_clicks
    GREATEST(
      CASE WHEN sg.scored_opens THEN COALESCE(hm.human_openers, 0)
           WHEN COALESCE(o.delivered, 0) > 0 THEN round(o.delivered * k.r)::bigint
           ELSE 0 END,
      COALESCE(hc.human_clicks, 0)
    ),
    hc.human_clicks,
    GREATEST(
      COALESCE(o.unique_opens, 0)
        - GREATEST(
            CASE WHEN sg.scored_opens THEN COALESCE(hm.human_openers, 0)
                 WHEN COALESCE(o.delivered, 0) > 0 THEN round(o.delivered * k.r)::bigint
                 ELSE 0 END,
            COALESCE(hc.human_clicks, 0)
          ),
      0
    ),
    CASE WHEN sg.scored_clicks THEN GREATEST(COALESCE(o.unique_clicks, 0) - COALESCE(hm.human_clickers, 0), 0)
         WHEN COALESCE(o.unique_clicks, 0) > 0 THEN GREATEST(o.unique_clicks - round(o.unique_clicks * k.g)::bigint, 0)
         ELSE NULL END,
    CASE WHEN sg.scored_opens THEN 'signals-v1' ELSE 'estimate' END,
    COALESCE(o.bounced, 0),
    COALESCE(o.unsubscribed, 0),
    COALESCE(o.suppressed, 0)
  FROM unnest(p_broadcast_ids) AS bid
  CROSS JOIN consts k
  LEFT JOIN ours o    ON o.broadcast_id = bid
  LEFT JOIN sig sg    ON sg.broadcast_id = bid
  LEFT JOIN humans hm ON hm.broadcast_id = bid
  LEFT JOIN hc        ON hc.broadcast_id = bid;
$function$;

CREATE TABLE IF NOT EXISTS public.broadcast_engagement_snapshots (
  broadcast_id     uuid PRIMARY KEY,
  data_version_ts  timestamptz,
  payload          jsonb NOT NULL,
  snapshot_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.broadcast_engagement_snapshots ENABLE ROW LEVEL SECURITY;
DO $pol$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='broadcast_engagement_snapshots' AND policyname='admin_read_broadcast_eng_snap') THEN
    CREATE POLICY "admin_read_broadcast_eng_snap" ON public.broadcast_engagement_snapshots FOR SELECT TO authenticated USING (public.is_admin());
  END IF;
END $pol$;

CREATE OR REPLACE FUNCTION public.broadcast_engagement_data_version(p_broadcast_id uuid)
RETURNS timestamptz LANGUAGE sql STABLE AS $dv$
  SELECT MAX(COALESCE(s.completed_at, s.updated_at, s.started_at, s.created_at))
  FROM public.broadcast_sends s WHERE s.broadcast_id = p_broadcast_id
$dv$;

CREATE OR REPLACE FUNCTION public.broadcast_engagement(p_broadcast_ids uuid[])
RETURNS TABLE(broadcast_id uuid, sent bigint, delivered bigint, unique_opens bigint, unique_clicks bigint, human_opens bigint, human_clicks bigint, machine_opens bigint, machine_clicks bigint, human_source text, bounced bigint, unsubscribed bigint, suppressed bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $fn$
-- use_column: bare identifiers that collide with an OUT-param name (broadcast_id)
-- resolve to the table column, so INSERT column lists / ON CONFLICT targets are
-- unambiguous. We never assign the OUT params directly (RETURN QUERY only).
#variable_conflict use_column
DECLARE v_cached uuid[]; v_live uuid[];
BEGIN
  SELECT COALESCE(array_agg(s.broadcast_id), '{}'::uuid[]) INTO v_cached
  FROM public.broadcast_engagement_snapshots s
  WHERE s.broadcast_id = ANY(p_broadcast_ids)
    AND s.data_version_ts IS NOT DISTINCT FROM public.broadcast_engagement_data_version(s.broadcast_id);

  SELECT COALESCE(array_agg(u.id), '{}'::uuid[]) INTO v_live
  FROM unnest(p_broadcast_ids) AS u(id) WHERE NOT (u.id = ANY(v_cached));

  -- cached rows, straight from the snapshot payload
  RETURN QUERY
    SELECT (s.payload->>'broadcast_id')::uuid,
           (s.payload->>'sent')::bigint,
           (s.payload->>'delivered')::bigint,
           (s.payload->>'unique_opens')::bigint,
           (s.payload->>'unique_clicks')::bigint,
           (s.payload->>'human_opens')::bigint,
           (s.payload->>'human_clicks')::bigint,
           (s.payload->>'machine_opens')::bigint,
           (s.payload->>'machine_clicks')::bigint,
           (s.payload->>'human_source')::text,
           (s.payload->>'bounced')::bigint,
           (s.payload->>'unsubscribed')::bigint,
           (s.payload->>'suppressed')::bigint
    FROM public.broadcast_engagement_snapshots s WHERE s.broadcast_id = ANY(v_cached);

  IF COALESCE(array_length(v_live,1),0) > 0 THEN
    -- compute the uncached ones once
    DROP TABLE IF EXISTS _be;
    CREATE TEMP TABLE _be ON COMMIT DROP AS
      SELECT * FROM public.broadcast_engagement_live(v_live);

    -- auto-cache the completed ones so subsequent reads are instant
    INSERT INTO public.broadcast_engagement_snapshots (broadcast_id, data_version_ts, payload, snapshot_at)
    SELECT be.broadcast_id, public.broadcast_engagement_data_version(be.broadcast_id), to_jsonb(be), now()
    FROM _be be
    WHERE EXISTS (SELECT 1 FROM public.broadcast_sends bs
                  WHERE bs.broadcast_id = be.broadcast_id AND bs.status IN ('sent','completed'))
    ON CONFLICT (broadcast_id) DO UPDATE
      SET data_version_ts = EXCLUDED.data_version_ts, payload = EXCLUDED.payload, snapshot_at = now();

    -- return the live rows
    RETURN QUERY
      SELECT be.broadcast_id, be.sent, be.delivered, be.unique_opens, be.unique_clicks,
             be.human_opens, be.human_clicks, be.machine_opens, be.machine_clicks,
             be.human_source, be.bounced, be.unsubscribed, be.suppressed
      FROM _be be;
    DROP TABLE _be;
  END IF;
END $fn$;

