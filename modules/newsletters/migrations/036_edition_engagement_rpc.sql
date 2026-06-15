-- Per-edition engagement for the editions table.
-- Spec: spec-newsletter-personalised-delivery §6 (Part C).
--
-- SELF-CONTAINED methodology (no dependency on Customer.io going forward — we're
-- leaving CIO, so the live metric must come only from our own tracking):
--   * Raw counts (sent/delivered/opens/clicks) from our own email_send_log.
--   * human_clicks (PRIMARY engagement metric — reliable, MPP-proof): where we've
--     scored the edition's raw events with signals-v1, = clicks minus detected
--     scanner/bot clickers; otherwise estimated as clicks × G.
--   * human_opens (SECONDARY, an estimate — opens are unreliable post-MPP): where
--     scored, = signals-v1 likely-human (non-MPP open or this-edition click);
--     otherwise estimated as delivered × R.
-- G/R are calibrated from the editions we HAVE scored (see CALIBRATION below) so
-- scored and estimated editions stay on one consistent scale. Customer.io's
-- numbers are returned only as a frozen historical reference (cio_* columns).
--
-- CALIBRATION (refresh from scored editions when more are scored):
--   G = Σ(human_clicks)/Σ(clicks)        over signals-v1-scored editions
--   R = Σ(human_opens)/Σ(delivered)      over signals-v1-scored editions

-- Return type changed over time (added unsubscribed); drop before recreate.
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
  human_source      text,     -- 'signals-v1' | 'estimate'
  bounced           bigint,   -- system suppression (bounce/drop) — explains a SENT drop
  unsubscribed      bigint,   -- genuine opt-out (global or topic) — explains a SENT drop
  cio_human_opens   bigint,   -- frozen historical reference only
  cio_machine_opens bigint,
  cio_human_clicks  bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
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
  )
  SELECT ed AS edition_id,
    COALESCE(o.sent, 0), COALESCE(o.delivered, 0),
    COALESCE(o.unique_opens, 0), COALESCE(o.unique_clicks, 0),
    -- human_opens: signals-v1 likely-human where scored, else estimate (delivered × R)
    CASE WHEN sg.scored_opens THEN lk.likely_human_openers
         WHEN COALESCE(o.delivered,0) > 0 THEN round(o.delivered * k.r)::bigint
         ELSE NULL END,
    -- human_clicks: measured where scored, else estimate (clicks × G)
    CASE WHEN sg.scored_clicks THEN GREATEST(COALESCE(o.unique_clicks,0) - COALESCE(mc.n,0), 0)
         WHEN COALESCE(o.unique_clicks,0) > 0 THEN round(o.unique_clicks * k.g)::bigint
         ELSE NULL END,
    CASE WHEN sg.scored_opens THEN GREATEST(COALESCE(o.unique_opens,0) - lk.likely_human_openers, 0)
         WHEN COALESCE(o.unique_opens,0) > 0 THEN GREATEST(o.unique_opens - round(o.delivered * k.r)::bigint, 0)
         ELSE NULL END,
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
  LEFT JOIN cio  c  ON c.edition_id = ed;
$$;

GRANT EXECUTE ON FUNCTION public.newsletter_edition_engagement(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.newsletter_edition_engagement(uuid[]) IS
  'Per-edition engagement, self-contained (no CIO). human_clicks primary (measured/estimated), human_opens secondary estimate. CIO columns are historical reference only.';
