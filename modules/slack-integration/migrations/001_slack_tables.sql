-- ============================================================================
-- Module: slack-integration
-- Migration: 001_slack_tables
-- Description: Create Slack integration tables for workspace connections,
--              notifications, and invitation queue management
-- ============================================================================

-- Slack integration configs (custom workspace connections per event)
CREATE TABLE IF NOT EXISTS public.integrations_slack_configs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        text NOT NULL,
  access_token    text NOT NULL,
  bot_user_id     text NOT NULL,
  team_id         text NOT NULL,
  team_name       text NOT NULL,
  scope           text NOT NULL,
  installed_by    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id)
);

COMMENT ON TABLE public.integrations_slack_configs IS 'Slack OAuth workspace connections per event';

CREATE INDEX IF NOT EXISTS idx_integrations_slack_configs_event
  ON public.integrations_slack_configs (event_id);

CREATE TRIGGER integrations_slack_configs_updated_at
  BEFORE UPDATE ON public.integrations_slack_configs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Slack notification settings
CREATE TABLE IF NOT EXISTS public.integrations_slack_notifications (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                  text NOT NULL,
  notification_type         varchar(50) NOT NULL,
  enabled                   boolean NOT NULL DEFAULT false,
  use_custom_workspace      boolean NOT NULL DEFAULT false,
  channel_id                text,
  channel_name              text,
  user_id                   text,
  user_email                varchar(255),
  custom_message_template   text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, notification_type)
);

COMMENT ON TABLE public.integrations_slack_notifications IS 'Per-event Slack notification configuration';

CREATE INDEX IF NOT EXISTS idx_integrations_slack_notifications_event
  ON public.integrations_slack_notifications (event_id);

CREATE TRIGGER integrations_slack_notifications_updated_at
  BEFORE UPDATE ON public.integrations_slack_notifications
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Slack notification logs
CREATE TABLE IF NOT EXISTS public.integrations_slack_notification_logs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              text NOT NULL,
  notification_type     varchar(50) NOT NULL,
  channel_or_user       text NOT NULL,
  message_ts            text,
  trigger_entity_type   varchar(50) NOT NULL,
  trigger_entity_id     text NOT NULL,
  status                varchar(20) NOT NULL DEFAULT 'sent'
                        CHECK (status IN ('sent', 'failed')),
  error_message         text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.integrations_slack_notification_logs IS 'Audit log of all Slack notifications sent';

CREATE INDEX IF NOT EXISTS idx_integrations_slack_notification_logs_event
  ON public.integrations_slack_notification_logs (event_id);
CREATE INDEX IF NOT EXISTS idx_integrations_slack_notification_logs_created
  ON public.integrations_slack_notification_logs (created_at DESC);

-- Slack invitation queue
CREATE TABLE IF NOT EXISTS public.integrations_slack_invitation_queue (
  id              serial PRIMARY KEY,
  email           varchar(255) NOT NULL,
  status          varchar(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  error_message   text,
  invited_at      timestamptz,
  retry_count     integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.integrations_slack_invitation_queue IS 'Queue for Slack workspace invitation processing';

CREATE INDEX IF NOT EXISTS idx_integrations_slack_invitation_queue_status
  ON public.integrations_slack_invitation_queue (status);
CREATE INDEX IF NOT EXISTS idx_integrations_slack_invitation_queue_email
  ON public.integrations_slack_invitation_queue (email);
CREATE INDEX IF NOT EXISTS idx_integrations_slack_invitation_queue_created
  ON public.integrations_slack_invitation_queue (created_at DESC);

CREATE TRIGGER integrations_slack_invitation_queue_updated_at
  BEFORE UPDATE ON public.integrations_slack_invitation_queue
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE public.integrations_slack_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_slack_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_slack_notification_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_slack_invitation_queue ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated users
CREATE POLICY "integrations_slack_configs_select" ON public.integrations_slack_configs FOR SELECT TO authenticated USING (true);
CREATE POLICY "integrations_slack_notifications_select" ON public.integrations_slack_notifications FOR SELECT TO authenticated USING (true);
CREATE POLICY "integrations_slack_notification_logs_select" ON public.integrations_slack_notification_logs FOR SELECT TO authenticated USING (true);
CREATE POLICY "integrations_slack_invitation_queue_select" ON public.integrations_slack_invitation_queue FOR SELECT TO authenticated USING (true);

-- INSERT/UPDATE/DELETE: admin only
CREATE POLICY "integrations_slack_configs_insert" ON public.integrations_slack_configs FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "integrations_slack_configs_update" ON public.integrations_slack_configs FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "integrations_slack_configs_delete" ON public.integrations_slack_configs FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "integrations_slack_notifications_insert" ON public.integrations_slack_notifications FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "integrations_slack_notifications_update" ON public.integrations_slack_notifications FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "integrations_slack_notifications_delete" ON public.integrations_slack_notifications FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "integrations_slack_notification_logs_insert" ON public.integrations_slack_notification_logs FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "integrations_slack_notification_logs_delete" ON public.integrations_slack_notification_logs FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "integrations_slack_invitation_queue_insert" ON public.integrations_slack_invitation_queue FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "integrations_slack_invitation_queue_update" ON public.integrations_slack_invitation_queue FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "integrations_slack_invitation_queue_delete" ON public.integrations_slack_invitation_queue FOR DELETE TO authenticated USING (public.is_admin());
