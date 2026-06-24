-- ============================================================================
-- Module: newsletters
-- Migration: 058_engagement_read_webhook_stream
-- Description: Fix two confusing things on the edition engagement card.
--
-- (1) Human engagement read the WRONG stream. The classification CTEs joined
--     email_events -> email_event_classifications (detection_source =
--     'bot-detector-signals'), which is populated by the CIO import + our own
--     pixel/redirect tracking. But SendGrid-webhook-scored editions write their
--     per-event detector output to email_interactions (scorer_id +
--     human_confidence), NOT email_event_classifications. So for webhook
--     editions the RPC saw no classifications, fell back to the calibrated
--     ESTIMATE, and the human_opens floor collapsed it onto human_clicks — even
--     though the "Detection sources" card (edition_detection_comparison, mig
--     056) showed thousands of signals-v1 human opens from email_interactions.
--     Fix: classify from BOTH streams (UNION), mirroring migration 056.
--
-- (2) List churn counted this-send BOUNCES as removals. `bounced` is a delivery
--     stat (status='bounced' on this send) — a single bounce does NOT remove a
--     subscriber; only repeated bounces do (list-hygiene suppresses after N
--     bounce editions). The card rolled raw bounces into "Total removed" (7.6%),
--     which massively overstates churn. Fix: split list_subscriptions opt-outs
--     (`unsubscribed`) from actual bounce/hygiene removals (`suppressed`, new
--     column); "Total removed" = unsubscribed + suppressed. Raw bounces stay a
--     delivery metric (top row), not churn.
--
-- Adds the `suppressed bigint` output column (so the RETURNS TABLE shape
-- changes — the admin EditionEngagement type is updated to match).
--
-- Down (for reference; not auto-run): re-apply migration 057.
-- ============================================================================

DROP FUNCTION IF EXISTS public.newsletter_edition_engagement(uuid[]);
CREATE OR REPLACE FUNCTION public.newsletter_edition_engagement(p_edition_ids uuid[])
RETURNS TABLE(
  edition_id uuid,
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
  suppressed bigint,
  cio_human_opens bigint,
  cio_machine_opens bigint,
  cio_human_clicks bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET statement_timeout TO '25s' AS $$
  WITH consts AS (SELECT 0.7265::numeric AS g, 0.0212::numeric AS r),
  sends AS (
    SELECT s.id, s.edition_id,
           s.metadata->'cio_metrics' AS cio,
           s.list_ids::uuid[]        AS list_ids,
           s.started_at, s.scheduled_at
    FROM public.newsletter_sends s
    WHERE s.edition_id = ANY(p_edition_ids)
  ),
  -- list_subscriptions opt-outs attributable to this send (genuine unsubscribe:
  -- source is NOT a list-hygiene suppression), at/after the send started.
  unsubs AS (
    SELECT DISTINCT lower(ls.email) AS email
    FROM public.list_subscriptions ls
    WHERE ls.subscribed = false
      AND NOT (COALESCE(ls.source, '') ILIKE 'list-hygiene%' OR COALESCE(ls.source, '') ILIKE '%bounce%')
      AND ls.list_id IN (SELECT unnest(list_ids)::uuid FROM sends WHERE list_ids IS NOT NULL)
      AND ls.unsubscribed_at >= (
        SELECT COALESCE(MIN(COALESCE(started_at, scheduled_at)), '1970-01-01'::timestamptz) FROM sends
      )
  ),
  -- actual list removals for bouncing/inactivity (list-hygiene suppression).
  -- Cumulative (not time-scoped): "of this send's lists, who is now suppressed".
  supp AS (
    SELECT DISTINCT lower(ls.email) AS email
    FROM public.list_subscriptions ls
    WHERE ls.subscribed = false
      AND (COALESCE(ls.source, '') ILIKE 'list-hygiene%' OR COALESCE(ls.source, '') ILIKE '%bounce%')
      AND ls.list_id IN (SELECT unnest(list_ids)::uuid FROM sends WHERE list_ids IS NOT NULL)
  ),
  recip AS (
    SELECT s.edition_id, lower(l.recipient_email) AS email,
      (l.first_opened_at IS NOT NULL)  AS opened,
      (l.first_clicked_at IS NOT NULL) AS clicked,
      (l.delivered_at IS NOT NULL)     AS delivered,
      (l.status = 'bounced')           AS bounced,
      EXISTS (SELECT 1 FROM unsubs u WHERE u.email = lower(l.recipient_email)) AS unsubscribed,
      EXISTS (SELECT 1 FROM supp  p WHERE p.email = lower(l.recipient_email)) AS suppressed
    FROM sends s JOIN public.email_send_log l ON l.newsletter_send_id = s.id
  ),
  ours AS (
    SELECT edition_id,
      count(DISTINCT email)                              AS sent,
      count(DISTINCT email) FILTER (WHERE delivered)     AS delivered,
      count(DISTINCT email) FILTER (WHERE opened)        AS unique_opens,
      count(DISTINCT email) FILTER (WHERE clicked)       AS unique_clicks,
      count(DISTINCT email) FILTER (WHERE bounced)       AS bounced,
      count(DISTINCT email) FILTER (WHERE unsubscribed)  AS unsubscribed,
      count(DISTINCT email) FILTER (WHERE suppressed)    AS suppressed
    FROM recip GROUP BY edition_id
  ),
  -- per-(edition, recipient) human flags from BOTH detection streams.
  cls AS (
    SELECT edition_id, email,
      bool_or(is_human_open)  AS has_human_open,
      bool_or(is_human_click) AS has_human_click,
      bool_or(is_open)        AS has_open,
      bool_or(is_open)        AS scored_open,   -- presence of a scored open
      bool_or(is_click)       AS scored_click
    FROM (
      -- old stream: email_events + per-source classifications
      SELECT s.edition_id, lower(e.email) AS email,
        (c.is_human AND e.event_type = 'opened')  AS is_human_open,
        (c.is_human AND e.event_type = 'clicked') AS is_human_click,
        (e.event_type = 'opened')                  AS is_open,
        (e.event_type = 'clicked')                 AS is_click
      FROM sends s
      JOIN public.email_events e ON e.newsletter_send_id = s.id
      JOIN public.email_event_classifications c ON c.event_id = e.id
      WHERE e.event_type IN ('opened','clicked')
      UNION ALL
      -- webhook stream: email_interactions scored by the active detector
      SELECT s.edition_id, lower(esl.recipient_email) AS email,
        (ei.event_type = 'open'  AND ei.human_confidence >= 0.5) AS is_human_open,
        (ei.event_type = 'click' AND ei.human_confidence >= 0.5) AS is_human_click,
        (ei.event_type = 'open')  AS is_open,
        (ei.event_type = 'click') AS is_click
      FROM sends s
      JOIN public.email_send_log esl ON esl.newsletter_send_id = s.id
      JOIN public.email_interactions ei ON ei.email_send_log_id = esl.id
      WHERE ei.scorer_id IS NOT NULL AND ei.event_type IN ('open','click')
    ) u
    GROUP BY edition_id, email
  ),
  sig AS (
    SELECT edition_id,
      bool_or(scored_open)  AS scored_opens,
      bool_or(scored_click) AS scored_clicks
    FROM cls GROUP BY edition_id
  ),
  -- reconciled human openers (rescued by a human click) + human clickers
  humans AS (
    SELECT edition_id,
      count(*) FILTER (WHERE has_open AND (has_human_open OR has_human_click)) AS human_openers,
      count(*) FILTER (WHERE has_human_click)                                  AS human_clickers
    FROM cls GROUP BY edition_id
  ),
  cio AS (
    SELECT edition_id,
      sum((cio->>'human_opened')::bigint)   AS cio_human,
      sum((cio->>'machine_opened')::bigint) AS cio_machine,
      sum((cio->>'human_clicked')::bigint)  AS cio_human_clk
    FROM sends WHERE cio IS NOT NULL GROUP BY edition_id
  ),
  hc AS (
    SELECT ed AS edition_id,
      CASE WHEN sg.scored_clicks THEN COALESCE(hm.human_clickers, 0)
           WHEN COALESCE(o.unique_clicks,0) > 0 THEN round(o.unique_clicks * k.g)::bigint
           ELSE NULL END AS human_clicks
    FROM unnest(p_edition_ids) AS ed
    CROSS JOIN consts k
    LEFT JOIN ours o   ON o.edition_id = ed
    LEFT JOIN sig sg   ON sg.edition_id = ed
    LEFT JOIN humans hm ON hm.edition_id = ed
  )
  SELECT ed AS edition_id,
    COALESCE(o.sent, 0), COALESCE(o.delivered, 0),
    COALESCE(o.unique_opens, 0), COALESCE(o.unique_clicks, 0),
    -- human_opens: measured (signals) or calibrated estimate, floored at human_clicks
    GREATEST(
      CASE WHEN sg.scored_opens THEN COALESCE(hm.human_openers, 0)
           WHEN COALESCE(o.delivered,0) > 0 THEN round(o.delivered * k.r)::bigint
           ELSE 0 END,
      COALESCE(hc.human_clicks, 0)
    ),
    hc.human_clicks,
    -- machine_opens = raw opens minus human opens
    GREATEST(
      COALESCE(o.unique_opens, 0)
        - GREATEST(
            CASE WHEN sg.scored_opens THEN COALESCE(hm.human_openers, 0)
                 WHEN COALESCE(o.delivered,0) > 0 THEN round(o.delivered * k.r)::bigint
                 ELSE 0 END,
            COALESCE(hc.human_clicks, 0)
          ),
      0
    ),
    CASE WHEN sg.scored_clicks THEN GREATEST(COALESCE(o.unique_clicks,0) - COALESCE(hm.human_clickers,0), 0)
         WHEN COALESCE(o.unique_clicks,0) > 0 THEN GREATEST(o.unique_clicks - round(o.unique_clicks * k.g)::bigint, 0)
         ELSE NULL END,
    CASE WHEN sg.scored_opens THEN 'signals-v1' ELSE 'estimate' END,
    COALESCE(o.bounced, 0),
    COALESCE(o.unsubscribed, 0),
    COALESCE(o.suppressed, 0),
    COALESCE(c.cio_human, 0), COALESCE(c.cio_machine, 0), COALESCE(c.cio_human_clk, 0)
  FROM unnest(p_edition_ids) AS ed
  CROSS JOIN consts k
  LEFT JOIN ours o    ON o.edition_id = ed
  LEFT JOIN sig sg    ON sg.edition_id = ed
  LEFT JOIN humans hm ON hm.edition_id = ed
  LEFT JOIN cio c     ON c.edition_id = ed
  LEFT JOIN hc        ON hc.edition_id = ed;
$$;

COMMENT ON FUNCTION public.newsletter_edition_engagement(uuid[]) IS
  'Per-edition engagement. Human/machine split classified from BOTH email_event_classifications and email_interactions (webhook signals). unsubscribed=opt-outs, suppressed=list-hygiene removals (bounces/inactive); bounced is a per-send delivery stat, not a removal. See migration 058.';
