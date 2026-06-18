-- ============================================================================
-- Module: newsletters
-- Migration: 045_engagement_human_opens_floor
-- Description: Floor human_opens at human_clicks in newsletter_edition_engagement.
--
-- A click can't happen without the recipient having opened the email (the
-- click is on a link in the rendered body). So the count of HUMAN OPENERS
-- must be ≥ the count of HUMAN CLICKERS, by construction. The original RPC
-- in migration 036 computes the two metrics independently and the unscored
-- estimate path can produce human_opens=0 while human_clicks=1 — that's the
-- case AAIF prod has hit on small test sends with R=0.0212 (historical
-- AAIF human-open ratio): round(2 delivered × 0.0212) rounds to 0, even
-- though we DO have a measured human click whose author definitionally
-- opened the email.
--
-- This migration wraps the human_opens CASE in a GREATEST(..., human_clicks)
-- so the count never falls below the human-clicker count, on both the
-- scored (signals-v1) and the unscored (estimate) paths. machine_opens is
-- recomputed off the floored human_opens so the two columns still sum to
-- unique_opens.
-- ============================================================================

DROP FUNCTION IF EXISTS public.newsletter_edition_engagement(uuid[]);

CREATE OR REPLACE FUNCTION public.newsletter_edition_engagement(p_edition_ids uuid[])
RETURNS TABLE (
  edition_id        uuid,
  sent              bigint,
  delivered         bigint,
  unique_opens      bigint,
  unique_clicks     bigint,
  human_opens       bigint,
  human_clicks      bigint,
  machine_opens     bigint,
  machine_clicks    bigint,
  human_source      text,
  bounced           bigint,
  unsubscribed      bigint,
  cio_human_opens   bigint,
  cio_machine_opens bigint,
  cio_human_clicks  bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET statement_timeout = '25s'
AS $$
  WITH consts AS (SELECT 0.7265::numeric AS g, 0.0212::numeric AS r),
  sends AS (
    SELECT s.id, s.edition_id, s.metadata->'cio_metrics' AS cio
    FROM public.newsletter_sends s
    WHERE s.edition_id = ANY(p_edition_ids)
  ),
  recip AS (
    SELECT s.edition_id, l.recipient_email AS email,
      (l.first_opened_at IS NOT NULL)  AS opened,
      (l.first_clicked_at IS NOT NULL) AS clicked,
      (l.delivered_at IS NOT NULL)     AS delivered,
      (l.status = 'bounced')           AS bounced,
      (l.unsubscribed_at IS NOT NULL)  AS unsubscribed
    FROM sends s JOIN public.email_send_log l ON l.newsletter_send_id = s.id
  ),
  ours AS (
    SELECT edition_id,
      count(DISTINCT email)                            AS sent,
      count(DISTINCT email) FILTER (WHERE delivered)   AS delivered,
      count(DISTINCT email) FILTER (WHERE opened)      AS unique_opens,
      count(DISTINCT email) FILTER (WHERE clicked)     AS unique_clicks,
      count(DISTINCT email) FILTER (WHERE bounced)     AS bounced,
      count(DISTINCT email) FILTER (WHERE unsubscribed) AS unsubscribed
    FROM recip GROUP BY edition_id
  ),
  sig_human_open AS (
    SELECT DISTINCT s.edition_id, e.email
    FROM sends s
    JOIN public.email_events e ON e.newsletter_send_id = s.id AND e.event_type = 'opened'
    JOIN public.email_event_classifications c
      ON c.event_id = e.id AND c.detection_source = 'bot-detector-signals' AND c.is_human
  ),
  sig AS (
    SELECT s.edition_id,
      bool_or(e.event_type = 'opened')  AS scored_opens,
      bool_or(e.event_type = 'clicked') AS scored_clicks
    FROM sends s
    JOIN public.email_events e ON e.newsletter_send_id = s.id
    JOIN public.email_event_classifications c ON c.event_id = e.id AND c.detection_source = 'bot-detector-signals'
    GROUP BY s.edition_id
  ),
  click_class AS (
    SELECT s.edition_id, e.email, bool_or(c.is_human) AS any_human_click
    FROM sends s
    JOIN public.email_events e ON e.newsletter_send_id = s.id AND e.event_type = 'clicked'
    JOIN public.email_event_classifications c ON c.event_id = e.id AND c.detection_source = 'bot-detector-signals'
    GROUP BY s.edition_id, e.email
  ),
  machine_clickers AS (
    SELECT edition_id, count(*) AS n FROM click_class WHERE NOT any_human_click GROUP BY edition_id
  ),
  likely AS (
    SELECT r.edition_id,
      count(DISTINCT r.email) FILTER (WHERE r.opened AND (sho.email IS NOT NULL OR r.clicked)) AS likely_human_openers
    FROM recip r
    LEFT JOIN sig_human_open sho ON sho.edition_id = r.edition_id AND sho.email = r.email
    GROUP BY r.edition_id
  ),
  cio AS (
    SELECT edition_id,
      sum((cio->>'human_opened')::bigint)   AS cio_human,
      sum((cio->>'machine_opened')::bigint) AS cio_machine,
      sum((cio->>'human_clicked')::bigint)  AS cio_human_clk
    FROM sends WHERE cio IS NOT NULL GROUP BY edition_id
  ),
  -- Compute human_clicks first so we can floor human_opens at it.
  hc AS (
    SELECT ed AS edition_id,
      CASE WHEN sg.scored_clicks THEN GREATEST(COALESCE(o.unique_clicks,0) - COALESCE(mc.n,0), 0)
           WHEN COALESCE(o.unique_clicks,0) > 0 THEN round(o.unique_clicks * k.g)::bigint
           ELSE NULL END AS human_clicks
    FROM unnest(p_edition_ids) AS ed
    CROSS JOIN consts k
    LEFT JOIN ours o ON o.edition_id = ed
    LEFT JOIN sig sg ON sg.edition_id = ed
    LEFT JOIN machine_clickers mc ON mc.edition_id = ed
  )
  SELECT ed AS edition_id,
    COALESCE(o.sent, 0), COALESCE(o.delivered, 0),
    COALESCE(o.unique_opens, 0), COALESCE(o.unique_clicks, 0),
    -- human_opens: max of (estimate / signals-v1 measurement) and human_clicks.
    -- Every human click implies a human open, so the open count never falls
    -- below the click count.
    GREATEST(
      CASE WHEN sg.scored_opens THEN lk.likely_human_openers
           WHEN COALESCE(o.delivered,0) > 0 THEN round(o.delivered * k.r)::bigint
           ELSE 0 END,
      COALESCE(hc.human_clicks, 0)
    ),
    hc.human_clicks,
    -- machine_opens: unique_opens minus human_opens (recomputed with the floor).
    GREATEST(
      COALESCE(o.unique_opens, 0)
        - GREATEST(
            CASE WHEN sg.scored_opens THEN lk.likely_human_openers
                 WHEN COALESCE(o.delivered,0) > 0 THEN round(o.delivered * k.r)::bigint
                 ELSE 0 END,
            COALESCE(hc.human_clicks, 0)
          ),
      0
    ),
    -- machine_clicks: unchanged from migration 036.
    CASE WHEN sg.scored_clicks THEN COALESCE(mc.n, 0)
         WHEN COALESCE(o.unique_clicks,0) > 0 THEN GREATEST(o.unique_clicks - round(o.unique_clicks * k.g)::bigint, 0)
         ELSE NULL END,
    CASE WHEN sg.scored_opens THEN 'signals-v1' ELSE 'estimate' END,
    COALESCE(o.bounced, 0),
    COALESCE(o.unsubscribed, 0),
    COALESCE(c.cio_human, 0), COALESCE(c.cio_machine, 0), COALESCE(c.cio_human_clk, 0)
  FROM unnest(p_edition_ids) AS ed
  CROSS JOIN consts k
  LEFT JOIN ours o  ON o.edition_id = ed
  LEFT JOIN sig  sg ON sg.edition_id = ed
  LEFT JOIN likely lk ON lk.edition_id = ed
  LEFT JOIN machine_clickers mc ON mc.edition_id = ed
  LEFT JOIN cio c   ON c.edition_id = ed
  LEFT JOIN hc      ON hc.edition_id = ed;
$$;

GRANT EXECUTE ON FUNCTION public.newsletter_edition_engagement(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.newsletter_edition_engagement(uuid[]) IS
  'Per-edition engagement, self-contained. human_opens floors at human_clicks (a click implies an open). human_clicks measured (signals-v1) or estimated. CIO columns are historical reference only.';
