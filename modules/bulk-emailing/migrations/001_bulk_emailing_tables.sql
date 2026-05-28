-- ============================================================================
-- Module: bulk-emailing
-- Migration: 001_bulk_emailing_tables
-- Description: Extended email tables for bulk emailing - subscriptions,
--              delivery event tracking (CIO webhooks), engagement summaries,
--              notification logs, and email topic labels.
--              Core email_templates and email_logs live in the base schema.
-- ============================================================================

-- ==========================================================================
-- 1. Email subscriptions
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.email_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  list_id text NOT NULL,
  subscribed boolean NOT NULL DEFAULT true,
  subscribed_at timestamptz,
  unsubscribed_at timestamptz,
  source text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(email, list_id)
);

CREATE INDEX IF NOT EXISTS idx_email_subscriptions_email ON public.email_subscriptions(email);
CREATE INDEX IF NOT EXISTS idx_email_subscriptions_list ON public.email_subscriptions(list_id);
CREATE INDEX IF NOT EXISTS idx_email_subscriptions_subscribed ON public.email_subscriptions(subscribed);

COMMENT ON TABLE public.email_subscriptions IS 'Tracks email subscription preferences for mailing lists';

CREATE TRIGGER email_subscriptions_updated_at
  BEFORE UPDATE ON public.email_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 2. Email events (CIO delivery tracking)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.email_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  event_type text NOT NULL,
  email_id text,
  campaign_id text,
  broadcast_id text,
  action_id text,
  subject text,
  recipient text,
  link_url text,
  link_id text,
  bounce_type text,
  failure_reason text,
  raw_payload jsonb,
  event_timestamp timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_events_email ON public.email_events(email);
CREATE INDEX IF NOT EXISTS idx_email_events_event_type ON public.email_events(event_type);
CREATE INDEX IF NOT EXISTS idx_email_events_email_id ON public.email_events(email_id);
CREATE INDEX IF NOT EXISTS idx_email_events_campaign_id ON public.email_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_email_events_timestamp ON public.email_events(event_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_email_events_email_timestamp ON public.email_events(email, event_timestamp DESC);

COMMENT ON TABLE public.email_events IS 'Stores email delivery events from Customer.io webhooks';

-- ==========================================================================
-- 3. Email engagement summary view
-- ==========================================================================
CREATE OR REPLACE VIEW public.email_engagement_summary AS
SELECT
  lower(email) as email,
  COUNT(*) FILTER (WHERE event_type = 'sent') as emails_sent,
  COUNT(*) FILTER (WHERE event_type = 'delivered') as emails_delivered,
  COUNT(*) FILTER (WHERE event_type = 'opened') as emails_opened,
  COUNT(*) FILTER (WHERE event_type = 'clicked') as emails_clicked,
  COUNT(*) FILTER (WHERE event_type = 'bounced') as emails_bounced,
  COUNT(*) FILTER (WHERE event_type = 'unsubscribed') as unsubscribes,
  COUNT(*) FILTER (WHERE event_type = 'spammed') as spam_reports,
  MAX(event_timestamp) FILTER (WHERE event_type = 'opened') as last_opened_at,
  MAX(event_timestamp) FILTER (WHERE event_type = 'clicked') as last_clicked_at,
  MAX(event_timestamp) as last_event_at
FROM public.email_events
GROUP BY lower(email);

COMMENT ON VIEW public.email_engagement_summary IS 'Aggregated email engagement metrics per user';

-- ==========================================================================
-- 4. Notification logs
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.notification_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_type text NOT NULL,
  recipient_email text,
  recipient_id uuid,
  event_id varchar,
  subject text,
  status text CHECK (status IN ('sent', 'failed', 'queued')),
  error_message text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_logs_type ON public.notification_logs(notification_type);
CREATE INDEX IF NOT EXISTS idx_notification_logs_event ON public.notification_logs(event_id);
CREATE INDEX IF NOT EXISTS idx_notification_logs_created ON public.notification_logs(created_at DESC);

COMMENT ON TABLE public.notification_logs IS 'Audit trail for all notifications sent';

-- ==========================================================================
-- 5. Email topic labels
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.email_topic_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id text UNIQUE NOT NULL,
  label text NOT NULL,
  description text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TRIGGER email_topic_labels_updated_at
  BEFORE UPDATE ON public.email_topic_labels
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 6. RPC: email_get_topic_counts
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.email_get_topic_counts()
RETURNS TABLE(topic_id text, label text, subscriber_count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT
    etl.topic_id,
    etl.label,
    COUNT(es.id) as subscriber_count
  FROM public.email_topic_labels etl
  LEFT JOIN public.email_subscriptions es
    ON es.list_id = etl.topic_id AND es.subscribed = true
  WHERE etl.is_active = true
  GROUP BY etl.topic_id, etl.label
  ORDER BY etl.label;
$$;

COMMENT ON FUNCTION public.email_get_topic_counts()
  IS 'Email topic subscriber counts';

-- ==========================================================================
-- 7. RLS
-- ==========================================================================
ALTER TABLE public.email_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_topic_labels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_email_subscriptions" ON public.email_subscriptions FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_email_events" ON public.email_events FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_notification_logs" ON public.notification_logs FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_email_topic_labels" ON public.email_topic_labels FOR ALL TO authenticated USING (true) WITH CHECK (true);
