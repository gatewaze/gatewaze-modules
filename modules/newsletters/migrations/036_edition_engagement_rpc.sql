-- Per-edition engagement aggregates for the editions table.
-- Spec: spec-newsletter-personalised-delivery §6 (Part C).
--
-- All PRIMARY figures come from OUR data (email_send_log per-recipient, all-time
-- + complete, plus the cross-edition click profile), because:
--   • email_send_log first_opened/first_clicked are all-time (from the full CIO
--     messages), unlike Customer.io's windowed metrics snapshot;
--   • Customer.io's human_opened/human_clicked only exist since 2025-03/04, so
--     they're zero for older editions — useless as the displayed number.
-- "human_opens" is the defensible confirmed-human floor: an opener who clicked
-- anywhere in the full history (cross-edition identity ⇒ provably human).
-- Customer.io's human figures are returned separately as a reference only.

CREATE OR REPLACE FUNCTION public.newsletter_edition_engagement(p_edition_ids uuid[])
RETURNS TABLE (
  edition_id        uuid,
  sent              bigint,
  delivered         bigint,
  unique_opens      bigint,
  unique_clicks     bigint,
  human_clicks      bigint,   -- ours: clicks minus machine/scanner clickers we detect
  human_opens       bigint,   -- ours: confirmed human (clicked anywhere)
  machine_opens     bigint,   -- unique_opens − human_opens
  bounced           bigint,
  cio_human_opens   bigint,   -- Customer.io reference (0 for pre-2025 editions)
  cio_machine_opens bigint,
  cio_human_clicks  bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH sends AS (
    SELECT s.id, s.edition_id, s.metadata->'cio_metrics' AS cio
    FROM public.newsletter_sends s
    WHERE s.edition_id = ANY(p_edition_ids)
  ),
  ours AS (
    SELECT s.edition_id,
      count(DISTINCT l.recipient_email)                                            AS sent,
      count(DISTINCT l.recipient_email) FILTER (WHERE l.delivered_at IS NOT NULL)  AS delivered,
      count(DISTINCT l.recipient_email) FILTER (WHERE l.first_opened_at IS NOT NULL)  AS unique_opens,
      count(DISTINCT l.recipient_email) FILTER (WHERE l.first_clicked_at IS NOT NULL) AS unique_clicks,
      count(DISTINCT l.recipient_email) FILTER (WHERE l.status = 'bounced')         AS bounced,
      count(DISTINCT l.recipient_email) FILTER (
        WHERE l.first_opened_at IS NOT NULL AND r.editions_clicked > 0
      )                                                                            AS human_opens
    FROM sends s
    JOIN public.email_send_log l ON l.newsletter_send_id = s.id
    LEFT JOIN public.cio_recipient_engagement r ON r.recipient_email = l.recipient_email
    GROUP BY s.edition_id
  ),
  -- Per-clicker classification (signals-v1) → machine-only clickers (a clicker
  -- with a verdict but no human click). Empty for editions we haven't scored.
  click_class AS (
    SELECT s.edition_id, e.email,
      bool_or(c.is_human)        AS any_human_click,
      bool_or(c.id IS NOT NULL)  AS has_verdict
    FROM sends s
    JOIN public.email_events e ON e.newsletter_send_id = s.id AND e.event_type = 'clicked'
    LEFT JOIN public.email_event_classifications c
      ON c.event_id = e.id AND c.detection_source = 'bot-detector-signals'
    GROUP BY s.edition_id, e.email
  ),
  mclk AS (
    SELECT edition_id, count(*) AS machine_only
    FROM click_class WHERE has_verdict AND NOT any_human_click
    GROUP BY edition_id
  ),
  cio AS (
    SELECT edition_id,
      sum((cio->>'human_opened')::bigint)    AS cio_human,
      sum((cio->>'machine_opened')::bigint)  AS cio_machine,
      sum((cio->>'human_clicked')::bigint)   AS cio_human_clk
    FROM sends WHERE cio IS NOT NULL
    GROUP BY edition_id
  )
  SELECT ed AS edition_id,
    COALESCE(o.sent, 0),
    COALESCE(o.delivered, 0),
    COALESCE(o.unique_opens, 0),
    COALESCE(o.unique_clicks, 0),
    COALESCE(o.unique_clicks - COALESCE(mc.machine_only, 0), 0),
    COALESCE(o.human_opens, 0),
    COALESCE(o.unique_opens - o.human_opens, 0),
    COALESCE(o.bounced, 0),
    COALESCE(c.cio_human, 0),
    COALESCE(c.cio_machine, 0),
    COALESCE(c.cio_human_clk, 0)
  FROM unnest(p_edition_ids) AS ed
  LEFT JOIN ours o ON o.edition_id = ed
  LEFT JOIN mclk mc ON mc.edition_id = ed
  LEFT JOIN cio  c ON c.edition_id = ed;
$$;

GRANT EXECUTE ON FUNCTION public.newsletter_edition_engagement(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.newsletter_edition_engagement(uuid[]) IS
  'Per-edition engagement from our own all-time data; human_opens = confirmed-human floor (clicked anywhere). Customer.io human figures returned as reference only.';
