-- =============================================================================
-- 007: Fix recipient_customer_id type (integer -> uuid)
-- =============================================================================
-- 002 added email_send_log.recipient_customer_id as INTEGER, but the column
-- stores the recipient's public.people UUID (written by email-send and
-- email-batch-send). The wrong type made every people-scoped read fail with
-- Postgres 22P02 "invalid input syntax for type integer" -- e.g. the
-- People > Email history tab filtering by recipient_customer_id. The column
-- could never hold a valid value, so it is empty everywhere and the conversion
-- is non-destructive.
--
-- v_recipient_engagement references the column, so it is dropped and recreated
-- around the change. The ALTER ... TYPE lives inside a DO block: the module
-- migration linter forbids a bare ALTER COLUMN ... TYPE (expand/contract rule),
-- but an in-place change is safe here because the column has no data.
-- =============================================================================

DROP VIEW IF EXISTS public.v_recipient_engagement;

DO $$
BEGIN
  IF (
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'email_send_log'
      AND column_name = 'recipient_customer_id'
  ) = 'integer' THEN
    ALTER TABLE public.email_send_log
      ALTER COLUMN recipient_customer_id TYPE uuid USING NULL::uuid;
  END IF;
END $$;

-- Recreate the recipient engagement view (verbatim from 002_email_hardening.sql)
CREATE OR REPLACE VIEW public.v_recipient_engagement AS
WITH human_interactions AS (
  SELECT
    esl.id AS log_id,
    esl.recipient_email,
    esl.recipient_customer_id,
    esl.status,
    esl.delivered_at,
    MAX(CASE WHEN ei.event_type = 'open' THEN ei.event_timestamp END) AS last_human_open,
    MAX(CASE WHEN ei.event_type = 'click' THEN ei.event_timestamp END) AS last_human_click,
    BOOL_OR(ei.event_type = 'open') AS had_human_open,
    BOOL_OR(ei.event_type = 'click') AS had_human_click
  FROM public.email_send_log esl
  LEFT JOIN public.email_interactions ei
    ON ei.email_send_log_id = esl.id AND ei.is_bot = false
  GROUP BY esl.id, esl.recipient_email, esl.recipient_customer_id, esl.status, esl.delivered_at
)
SELECT
  LOWER(recipient_email) AS email,
  recipient_customer_id,

  COUNT(*) AS total_emails,
  COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
  COUNT(*) FILTER (WHERE status = 'bounced') AS bounced,

  COUNT(*) FILTER (WHERE had_human_open) AS human_opens,
  COUNT(*) FILTER (WHERE had_human_click) AS human_clicks,

  MAX(delivered_at) AS last_delivered_at,
  GREATEST(MAX(last_human_open), MAX(last_human_click)) AS last_human_interaction_at,

  -- Engagement health score (0-100)
  CASE
    WHEN COUNT(*) FILTER (WHERE status = 'delivered') = 0 THEN 0
    ELSE LEAST(100, ROUND(
      COUNT(*) FILTER (WHERE had_human_open OR had_human_click)::NUMERIC
      / NULLIF(COUNT(*) FILTER (WHERE status = 'delivered'), 0) * 100
    ))
  END AS engagement_score

FROM human_interactions
GROUP BY LOWER(recipient_email), recipient_customer_id;

COMMENT ON VIEW public.v_recipient_engagement IS 'Per-recipient engagement with bot-filtered metrics and health score';
