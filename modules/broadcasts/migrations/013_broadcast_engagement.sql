-- ============================================================================
-- Module: broadcasts
-- Migration: 013_broadcast_engagement
-- Description: Per-broadcast engagement rollup for the broadcasts dashboard
-- table — mirrors newsletters' newsletter_edition_engagement (same output shape
-- minus the Customer.io reference columns, which broadcasts never have), but
-- keyed by broadcast_id and aggregated across all of a broadcast's sends.
--
-- Delivery/open/click/bounce counts come from email_send_log (broadcast_send_id);
-- the human/machine split is MEASURED from email_interactions (per-event
-- human_confidence from the webhook detector), so broadcasts don't rely on the
-- calibrated estimate the way newsletters do — though the same estimate is kept
-- as a fallback for any broadcast with no scored interactions. List churn
-- (unsubscribed/suppressed) is computed from the send's list_ids, like
-- newsletters; segment-audience broadcasts have no list_ids so churn is 0.
-- ============================================================================

DROP FUNCTION IF EXISTS public.broadcast_engagement(uuid[]);
CREATE OR REPLACE FUNCTION public.broadcast_engagement(p_broadcast_ids uuid[])
RETURNS TABLE(
  broadcast_id uuid,
  sent bigint,
  delivered bigint,
  unique_opens bigint,
  unique_clicks bigint,
  human_opens bigint,
  human_clicks bigint,
  machine_opens bigint,
  machine_clicks bigint,
  human_source text,
  bounced bigint,
  unsubscribed bigint,
  suppressed bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET statement_timeout TO '25s' AS $$
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
$$;

GRANT EXECUTE ON FUNCTION public.broadcast_engagement(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.broadcast_engagement(uuid[]) IS
  'Per-broadcast engagement rollup across the broadcast''s sends. Human/machine split measured from email_interactions (webhook detector); mirrors newsletter_edition_engagement minus the Customer.io columns. See migration 013.';
