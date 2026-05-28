-- ============================================================================
-- Module: bulk-emailing
-- Migration: 002_email_hardening
-- Description: Email system hardening — complete lifecycle tracking,
--              bot detection, retry queue, watchdog, provider abstraction.
-- ============================================================================

-- ==========================================================================
-- 1. Rename email_logs → email_send_log, add lifecycle columns
-- ==========================================================================

-- Rename table if it still has the old name
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'email_logs' AND table_schema = 'public') THEN
    ALTER TABLE public.email_logs RENAME TO email_send_log;
  END IF;
END $$;

-- Create email_send_log if it doesn't exist at all (fresh install)
CREATE TABLE IF NOT EXISTS public.email_send_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_email text NOT NULL,
  from_address text,
  subject text,
  template_id uuid,
  status text NOT NULL DEFAULT 'queued',
  sent_at timestamptz,
  failure_error text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Rename columns safely (only if old name exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'email_send_log' AND column_name = 'to_email') THEN
    ALTER TABLE public.email_send_log RENAME COLUMN to_email TO recipient_email;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'email_send_log' AND column_name = 'from_email') THEN
    ALTER TABLE public.email_send_log RENAME COLUMN from_email TO from_address;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'email_send_log' AND column_name = 'error_message') THEN
    ALTER TABLE public.email_send_log RENAME COLUMN error_message TO failure_error;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'email_send_log' AND column_name = 'sendgrid_message_id') THEN
    ALTER TABLE public.email_send_log RENAME COLUMN sendgrid_message_id TO provider_message_id;
  END IF;
END $$;

-- Add provider_message_id if it doesn't exist yet
ALTER TABLE public.email_send_log ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

-- Add new lifecycle columns (idempotent)
ALTER TABLE public.email_send_log
  ADD COLUMN IF NOT EXISTS recipient_customer_id INTEGER,
  ADD COLUMN IF NOT EXISTS reply_to TEXT,
  ADD COLUMN IF NOT EXISTS content_html TEXT,
  ADD COLUMN IF NOT EXISTS template_variables JSONB,
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'sendgrid',
  ADD COLUMN IF NOT EXISTS batch_job_id UUID,
  ADD COLUMN IF NOT EXISTS newsletter_send_id UUID,
  ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_clicked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dropped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS spam_reported_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bounce_type TEXT,
  ADD COLUMN IF NOT EXISTS bounce_reason TEXT,
  ADD COLUMN IF NOT EXISTS send_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_by_admin_user_id UUID,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Drop old status constraint and add new one with expanded statuses
ALTER TABLE public.email_send_log DROP CONSTRAINT IF EXISTS email_logs_status_check;
ALTER TABLE public.email_send_log DROP CONSTRAINT IF EXISTS email_send_log_status_check;
ALTER TABLE public.email_send_log
  ADD CONSTRAINT email_send_log_status_check
  CHECK (status IN (
    'queued', 'sending', 'sent', 'accepted', 'delivered',
    'send_failed', 'permanently_failed',
    'bounced', 'dropped', 'spam_reported',
    -- Keep legacy statuses for backward compat during migration
    'pending', 'failed'
  ));

-- Backfill queued_at from created_at
UPDATE public.email_send_log SET queued_at = created_at WHERE queued_at IS NULL;
ALTER TABLE public.email_send_log ALTER COLUMN queued_at SET DEFAULT now();

-- Backfill send_attempts for already-sent emails
UPDATE public.email_send_log SET send_attempts = 1 WHERE status IN ('sent', 'delivered') AND send_attempts = 0;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_esl_recipient ON public.email_send_log(recipient_email);
CREATE INDEX IF NOT EXISTS idx_esl_provider_msg ON public.email_send_log(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_esl_batch_job ON public.email_send_log(batch_job_id) WHERE batch_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_esl_newsletter_send ON public.email_send_log(newsletter_send_id) WHERE newsletter_send_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_esl_status ON public.email_send_log(status);
CREATE INDEX IF NOT EXISTS idx_esl_retry ON public.email_send_log(next_retry_at)
  WHERE status = 'send_failed' AND send_attempts < max_attempts;
CREATE INDEX IF NOT EXISTS idx_esl_created ON public.email_send_log(created_at DESC);

-- RLS on email_send_log
ALTER TABLE public.email_send_log ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'email_send_log' AND policyname = 'auth_all_email_send_log'
  ) THEN
    CREATE POLICY "auth_all_email_send_log"
      ON public.email_send_log FOR ALL TO authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Updated at trigger
CREATE OR REPLACE FUNCTION public.email_send_log_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS email_send_log_updated_at ON public.email_send_log;
CREATE TRIGGER email_send_log_updated_at
  BEFORE UPDATE ON public.email_send_log
  FOR EACH ROW EXECUTE FUNCTION public.email_send_log_set_updated_at();

-- ==========================================================================
-- 2. Email interactions table (raw open/click events with bot scoring)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.email_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_send_log_id UUID NOT NULL REFERENCES public.email_send_log(id) ON DELETE CASCADE,

  -- Event details
  event_type TEXT NOT NULL CHECK (event_type IN ('open', 'click')),
  event_timestamp TIMESTAMPTZ NOT NULL,

  -- Click-specific
  clicked_url TEXT,

  -- Fingerprint for bot detection
  user_agent TEXT,
  ip_address INET,
  ip_geo_country TEXT,

  -- Bot detection scoring (populated by bot detector sub-module)
  human_confidence NUMERIC(3,2) NOT NULL DEFAULT 1.00
    CHECK (human_confidence >= 0 AND human_confidence <= 1),
  bot_signals JSONB NOT NULL DEFAULT '[]',
  is_bot BOOLEAN GENERATED ALWAYS AS (human_confidence < 0.3) STORED,
  scorer_id TEXT,
  scored_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ei_send_log ON public.email_interactions(email_send_log_id);
CREATE INDEX IF NOT EXISTS idx_ei_type ON public.email_interactions(event_type);
CREATE INDEX IF NOT EXISTS idx_ei_human ON public.email_interactions(email_send_log_id, event_type)
  WHERE is_bot = false;
CREATE INDEX IF NOT EXISTS idx_ei_timestamp ON public.email_interactions(event_timestamp DESC);

COMMENT ON TABLE public.email_interactions IS 'Raw open/click events with bot detection scoring';

-- RLS
ALTER TABLE public.email_interactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_email_interactions" ON public.email_interactions
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ==========================================================================
-- 3. Email interaction scores (for comparing multiple bot detectors)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.email_interaction_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id UUID NOT NULL REFERENCES public.email_interactions(id) ON DELETE CASCADE,
  scorer_id TEXT NOT NULL,
  human_confidence NUMERIC(3,2) NOT NULL
    CHECK (human_confidence >= 0 AND human_confidence <= 1),
  signals JSONB NOT NULL DEFAULT '[]',
  scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(interaction_id, scorer_id)
);

CREATE INDEX IF NOT EXISTS idx_eis_interaction ON public.email_interaction_scores(interaction_id);
CREATE INDEX IF NOT EXISTS idx_eis_scorer ON public.email_interaction_scores(scorer_id);

COMMENT ON TABLE public.email_interaction_scores IS 'Multiple bot detection scores per interaction for comparison';

ALTER TABLE public.email_interaction_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_email_interaction_scores" ON public.email_interaction_scores
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ==========================================================================
-- 4. email_batch_jobs (create if not exists — may already exist from competitions module)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.email_batch_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid,
  email_type text NOT NULL,
  subject_template text,
  template_id uuid,
  from_email text,
  reply_to text,
  status text DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','cancelled')),
  total_recipients integer DEFAULT 0,
  processed_count integer DEFAULT 0,
  success_count integer DEFAULT 0,
  fail_count integer DEFAULT 0,
  errors jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_email_batch_jobs_event ON public.email_batch_jobs (event_id);

-- RLS (idempotent)
ALTER TABLE public.email_batch_jobs ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'email_batch_jobs' AND policyname = 'authenticated_all_email_batch_jobs'
  ) THEN
    CREATE POLICY "authenticated_all_email_batch_jobs"
      ON public.email_batch_jobs FOR ALL TO authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Add watchdog and extra columns
ALTER TABLE public.email_batch_jobs
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stall_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_stalls INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS last_processed_offset INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS from_address TEXT,
  ADD COLUMN IF NOT EXISTS content_template TEXT,
  ADD COLUMN IF NOT EXISTS created_by UUID,
  ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS cc TEXT;

-- ==========================================================================
-- 5. Advisory lock function for concurrency control
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.try_advisory_lock(lock_key BIGINT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN pg_try_advisory_lock(lock_key);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.release_advisory_lock(lock_key BIGINT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN pg_advisory_unlock(lock_key);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.try_advisory_lock IS 'Non-blocking advisory lock for batch job concurrency';

-- ==========================================================================
-- 6. Campaign engagement view (bot-filtered)
-- ==========================================================================
CREATE OR REPLACE VIEW public.v_campaign_engagement AS
SELECT
  esl.batch_job_id,
  esl.newsletter_send_id,

  -- Delivery metrics
  COUNT(*) AS total_sent,
  COUNT(*) FILTER (WHERE esl.status = 'delivered') AS delivered,
  COUNT(*) FILTER (WHERE esl.status = 'bounced') AS bounced,
  COUNT(*) FILTER (WHERE esl.status = 'dropped') AS dropped,
  COUNT(*) FILTER (WHERE esl.status = 'spam_reported') AS spam_reported,
  COUNT(*) FILTER (WHERE esl.status = 'permanently_failed') AS permanently_failed,

  -- Raw engagement (includes bots)
  COUNT(DISTINCT esl.id) FILTER (WHERE esl.first_opened_at IS NOT NULL) AS raw_opens,
  COUNT(DISTINCT esl.id) FILTER (WHERE esl.first_clicked_at IS NOT NULL) AS raw_clicks,

  -- Human-filtered engagement
  COUNT(DISTINCT ei_open.email_send_log_id) AS human_opens,
  COUNT(DISTINCT ei_click.email_send_log_id) AS human_clicks,

  -- Rates (percentages, against delivered)
  ROUND(
    COUNT(DISTINCT ei_open.email_send_log_id)::NUMERIC
    / NULLIF(COUNT(*) FILTER (WHERE esl.status = 'delivered'), 0) * 100, 1
  ) AS human_open_rate,
  ROUND(
    COUNT(DISTINCT ei_click.email_send_log_id)::NUMERIC
    / NULLIF(COUNT(*) FILTER (WHERE esl.status = 'delivered'), 0) * 100, 1
  ) AS human_click_rate

FROM public.email_send_log esl
LEFT JOIN public.email_interactions ei_open
  ON ei_open.email_send_log_id = esl.id
  AND ei_open.event_type = 'open'
  AND ei_open.is_bot = false
LEFT JOIN public.email_interactions ei_click
  ON ei_click.email_send_log_id = esl.id
  AND ei_click.event_type = 'click'
  AND ei_click.is_bot = false
WHERE esl.batch_job_id IS NOT NULL OR esl.newsletter_send_id IS NOT NULL
GROUP BY esl.batch_job_id, esl.newsletter_send_id;

COMMENT ON VIEW public.v_campaign_engagement IS 'Per-campaign engagement stats with bot-filtered metrics';

-- ==========================================================================
-- 7. Recipient engagement view (bot-filtered)
-- ==========================================================================
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

-- ==========================================================================
-- 8. pg_cron jobs (watchdog, resume, retry, IP anonymization)
--    Wrapped in DO block — skipped gracefully if pg_cron is not available
-- ==========================================================================
DO $$
BEGIN
  -- Check if pg_cron extension is available
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not available — skipping scheduled job creation. Install pg_cron and re-run this migration to enable watchdog, retry, and anonymization jobs.';
    RETURN;
  END IF;

  -- Watchdog: detect stalled jobs
  PERFORM cron.schedule(
    'email-job-watchdog',
    '*/2 * * * *',
    'UPDATE public.email_batch_jobs SET status = CASE WHEN stall_count + 1 >= max_stalls THEN ''failed'' ELSE ''pending'' END, stall_count = stall_count + 1, updated_at = NOW() WHERE status = ''processing'' AND last_heartbeat_at < NOW() - INTERVAL ''5 minutes'';'
  );

  -- Resume: re-trigger stalled jobs
  PERFORM cron.schedule(
    'email-job-resume',
    '1-59/2 * * * *',
    'SELECT net.http_post(url := current_setting(''app.supabase_url'') || ''/functions/v1/email-batch-send'', body := jsonb_build_object(''jobId'', id::text), headers := jsonb_build_object(''Authorization'', ''Bearer '' || current_setting(''app.service_role_key''), ''Content-Type'', ''application/json'')) FROM public.email_batch_jobs WHERE status = ''pending'' AND last_processed_offset > 0 AND stall_count < max_stalls LIMIT 1;'
  );

  -- Retry: process failed individual emails with backoff
  PERFORM cron.schedule(
    'email-retry-failed',
    '*/2 * * * *',
    'WITH eligible AS (SELECT id FROM public.email_send_log WHERE status = ''send_failed'' AND send_attempts < max_attempts AND next_retry_at <= NOW() ORDER BY next_retry_at ASC LIMIT 20) SELECT net.http_post(url := current_setting(''app.supabase_url'') || ''/functions/v1/email-retry-send'', body := jsonb_build_object(''log_ids'', (SELECT array_agg(id::text) FROM eligible)), headers := jsonb_build_object(''Authorization'', ''Bearer '' || current_setting(''app.service_role_key''), ''Content-Type'', ''application/json'')) FROM eligible HAVING count(*) > 0;'
  );

  -- IP anonymization: clear PII from interactions older than 90 days
  PERFORM cron.schedule(
    'email-interactions-anonymize',
    '0 3 * * *',
    'UPDATE public.email_interactions SET ip_address = NULL, user_agent = NULL WHERE created_at < NOW() - INTERVAL ''90 days'' AND ip_address IS NOT NULL;'
  );

  RAISE NOTICE 'pg_cron jobs created: email-job-watchdog, email-job-resume, email-retry-failed, email-interactions-anonymize';
END $$;
