-- ============================================================================
-- Module: newsletters
-- Migration: 057_engagement_unsubscribed_from_list_subscriptions
-- Description: Make the "Unsubscribed" metric on the edition engagement card
-- actually count unsubscribes. The previous version (migration 045) derived
-- `unsubscribed` from `email_send_log.unsubscribed_at` per recipient — but
-- NOTHING writes to that column. The newsletter-unsubscribe Edge Function
-- (the canonical opt-out path) updates `list_subscriptions.subscribed` /
-- `unsubscribed_at`; the email-webhook doesn't handle SendGrid 'unsubscribe'
-- events at all (its switch only covers delivered/bounced/dropped/spam_
-- reported/open/click/deferred). So `email_send_log.unsubscribed_at` was
-- never populated, and the metric was always 0.
--
-- Found on AAIF prod 2026-06-24 right after recovering the 753 broken-HMAC
-- unsubscribes from the 2026-06-23 send — they correctly landed in
-- list_subscriptions but the edition card still showed "Unsubscribed: 0".
--
-- The fix: derive unsubscribed from list_subscriptions, scoped to the lists
-- this send targeted AND to unsubs that happened AT or AFTER the send
-- started. That gives "unsubscribes attributable to this send" rather than
-- "people who happen to currently be unsubscribed from any reachable list",
-- which would include unsubs that pre-dated the send.
--
-- The list_subscriptions table is per-(email, list_id) and is updated by:
--   - newsletter-unsubscribe Edge Function (one-click + Subscription Centre)
--   - subscription-centre portal page (manual opt-outs)
--   - Customer.io webhook (when migrated)
--   - admin-applied recoveries (e.g. the 753 just done)
-- All four converge here, which is exactly the SOT property we want.
--
-- list_ids on newsletter_sends is text[] (not uuid[]) — cast at the join.
--
-- Performance: the first version used `EXISTS (SELECT 1 FROM list_subscriptions
-- WHERE lower(email) = lower(l.recipient_email) ...)` evaluated per recipient
-- — without a `lower(email)` index, it seq-scanned ~60k rows per recipient on
-- AAIF (~56k recipients per send), hit the 25s statement_timeout and returned
-- nothing. Fix: (a) add a functional index on `lower(email)`, (b) materialise
-- the unsub set ONCE per call as a CTE then hash-lookup from `recip`.
-- ============================================================================

-- (a) functional index so the unsubs CTE below can use it
CREATE INDEX IF NOT EXISTS idx_list_subscriptions_lower_email
  ON public.list_subscriptions (lower(email))
  WHERE subscribed = false;

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
           s.started_at,
           s.scheduled_at
    FROM public.newsletter_sends s
    WHERE s.edition_id = ANY(p_edition_ids)
  ),
  -- Materialise the set of emails who unsubscribed from this edition's lists
  -- AT OR AFTER its earliest send start — once, not per-recipient.
  unsubs AS (
    SELECT DISTINCT lower(ls.email) AS email
    FROM public.list_subscriptions ls
    WHERE ls.subscribed = false
      AND ls.list_id IN (
        SELECT unnest(list_ids)::uuid FROM sends WHERE list_ids IS NOT NULL
      )
      AND ls.unsubscribed_at >= (
        SELECT COALESCE(MIN(COALESCE(started_at, scheduled_at)), '1970-01-01'::timestamptz)
        FROM sends
      )
  ),
  recip AS (
    SELECT s.edition_id, l.recipient_email AS email,
      (l.first_opened_at IS NOT NULL)  AS opened,
      (l.first_clicked_at IS NOT NULL) AS clicked,
      (l.delivered_at IS NOT NULL)     AS delivered,
      (l.status = 'bounced')           AS bounced,
      -- Unsubscribed = does this recipient appear in the pre-materialised
      -- unsubs set? See migration 057 header for sourcing rationale.
      EXISTS (SELECT 1 FROM unsubs u WHERE u.email = lower(l.recipient_email)) AS unsubscribed
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
    GREATEST(
      CASE WHEN sg.scored_opens THEN lk.likely_human_openers
           WHEN COALESCE(o.delivered,0) > 0 THEN round(o.delivered * k.r)::bigint
           ELSE 0 END,
      COALESCE(hc.human_clicks, 0)
    ),
    hc.human_clicks,
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
    CASE WHEN sg.scored_clicks THEN COALESCE(mc.n, 0)
         WHEN COALESCE(o.unique_clicks,0) > 0 THEN GREATEST(o.unique_clicks - round(o.unique_clicks * k.g)::bigint, 0)
         ELSE NULL END,
    CASE WHEN sg.scored_opens THEN 'signals-v1' ELSE 'estimate' END,
    COALESCE(o.bounced, 0),
    COALESCE(o.unsubscribed, 0),
    COALESCE(c.cio_human, 0), COALESCE(c.cio_machine, 0), COALESCE(c.cio_human_clk, 0)
  FROM unnest(p_edition_ids) AS ed
  CROSS JOIN consts k
  LEFT JOIN ours o   ON o.edition_id = ed
  LEFT JOIN sig sg   ON sg.edition_id = ed
  LEFT JOIN likely lk ON lk.edition_id = ed
  LEFT JOIN machine_clickers mc ON mc.edition_id = ed
  LEFT JOIN cio c    ON c.edition_id = ed
  LEFT JOIN hc       ON hc.edition_id = ed;
$$;

COMMENT ON FUNCTION public.newsletter_edition_engagement(uuid[]) IS
  'Per-edition engagement aggregate (sent/delivered/opens/clicks/bounced/unsubscribed + signals-v1 human/machine split + Customer.io reference). Unsubscribed sourced from list_subscriptions (canonical) — see migration 057 header.';
