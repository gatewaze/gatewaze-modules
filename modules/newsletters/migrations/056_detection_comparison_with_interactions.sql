-- ============================================================================
-- Module: newsletters
-- Migration: 056_detection_comparison_with_interactions
-- Description: Extend edition_detection_comparison so SendGrid-webhook-scored
-- events surface in the admin UI's "Detection sources" card alongside the
-- existing email_events / email_event_classifications stream.
--
-- Background: the original RPC (migration 037) joined only email_events ->
-- email_event_classifications. That stream is populated by (a) the CIO
-- historical import (source='customer.io') and (b) our own pixel/redirect
-- tracking (source='gatewaze'). The SendGrid Event Webhook writes per-event
-- records to a DIFFERENT table — email_interactions — with the detector's
-- output in scorer_id + human_confidence. The RPC never read that stream, so
-- signals-v1 scores were invisible in the admin UI no matter what the
-- detector did. Found on AAIF prod 2026-06-23 — even after fixing detector
-- loading, the UI still showed "no signals-v1 data" because the RPC didn't
-- consult email_interactions.
--
-- Fix: UNION ALL a second per-recipient CTE that reads email_interactions
-- (joined back to newsletter_sends via email_send_log.newsletter_send_id) and
-- treats `ei.scorer_id` as the detection_source. Threshold for human:
-- `ei.human_confidence >= 0.5` (matches newsletter_geo_config's
-- open_human_confidence_min default).
--
-- Event-type naming difference handled inline: email_events uses 'opened' /
-- 'clicked'; email_interactions uses 'open' / 'click'. The CTE normalises.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.edition_detection_comparison(p_edition_id uuid)
RETURNS TABLE (
  detection_source         text,
  human_openers            bigint,
  machine_openers          bigint,
  human_clickers           bigint,
  reconciled_human_openers bigint,
  rescued_by_click         bigint,
  total_open_events        bigint,
  human_open_events        bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH sends AS (
    SELECT id FROM public.newsletter_sends WHERE edition_id = p_edition_id
  ),
  -- Existing stream: email_events (CIO import + own pixel/redirect) joined
  -- to its per-source classifications.
  per_recipient_events AS (
    SELECT e.email, c.detection_source,
      bool_or(c.is_human AND e.event_type = 'opened')   AS has_human_open,
      bool_or(e.event_type = 'opened')                   AS has_open,
      bool_or(c.is_human AND e.event_type = 'clicked')   AS has_human_click,
      count(*) FILTER (WHERE e.event_type = 'opened')                     AS open_events,
      count(*) FILTER (WHERE e.event_type = 'opened' AND c.is_human)      AS human_open_events
    FROM public.email_events e
    JOIN sends s ON e.newsletter_send_id = s.id
    JOIN public.email_event_classifications c ON c.event_id = e.id
    WHERE e.event_type IN ('opened', 'clicked')
    GROUP BY e.email, c.detection_source
  ),
  -- New stream: SendGrid webhook → email_interactions, scored by the active
  -- bot detector. scorer_id is the detection_source for the UI.
  per_recipient_interactions AS (
    SELECT
      lower(esl.recipient_email) AS email,
      ei.scorer_id              AS detection_source,
      bool_or(ei.event_type = 'open'  AND ei.human_confidence >= 0.5) AS has_human_open,
      bool_or(ei.event_type = 'open')                                  AS has_open,
      bool_or(ei.event_type = 'click' AND ei.human_confidence >= 0.5) AS has_human_click,
      count(*) FILTER (WHERE ei.event_type = 'open')                                          AS open_events,
      count(*) FILTER (WHERE ei.event_type = 'open' AND ei.human_confidence >= 0.5)           AS human_open_events
    FROM public.email_interactions ei
    JOIN public.email_send_log esl ON esl.id = ei.email_send_log_id
    JOIN sends s ON esl.newsletter_send_id = s.id
    WHERE ei.scorer_id IS NOT NULL
    GROUP BY lower(esl.recipient_email), ei.scorer_id
  ),
  per_recipient AS (
    SELECT * FROM per_recipient_events
    UNION ALL
    SELECT * FROM per_recipient_interactions
  )
  SELECT detection_source,
    count(*) FILTER (WHERE has_human_open)                                          AS human_openers,
    count(*) FILTER (WHERE has_open AND NOT has_human_open)                         AS machine_openers,
    count(*) FILTER (WHERE has_human_click)                                         AS human_clickers,
    count(*) FILTER (WHERE has_open AND (has_human_open OR has_human_click))        AS reconciled_human_openers,
    count(*) FILTER (WHERE has_open AND NOT has_human_open AND has_human_click)     AS rescued_by_click,
    sum(open_events)                                                                AS total_open_events,
    sum(human_open_events)                                                          AS human_open_events
  FROM per_recipient
  GROUP BY detection_source;
$$;
