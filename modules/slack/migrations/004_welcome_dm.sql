-- ============================================================================
-- 004_welcome_dm
--
-- Storage for the welcome DM: when someone joins the workspace, a message is
-- sent from a real person's Slack account (the community founder's), replacing
-- the make.com scenario that did this from a Google Sheet.
--
--   integrations_slack_user_tokens  — the sender's user token, sealed.
--   integrations_slack_welcome_log  — one row per joiner: who joined, whether
--                                     a welcome went out, and why not.
--
-- Both tables are service-role only. The admin page reads them through the
-- module's super_admin-gated routes, which never select the token column, so
-- no browser role needs any grant here at all.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.integrations_slack_user_tokens (
  -- One connected account per purpose. Only one purpose exists today.
  purpose          text PRIMARY KEY CHECK (purpose IN ('welcome_dm')),
  team_id          text NOT NULL,
  slack_user_id    text NOT NULL,
  slack_user_name  text,
  scopes           text,
  -- Sealed with GATEWAZE_SECRETS_KEY (v1: AES-256-GCM envelope). The CHECK
  -- makes a plaintext token impossible to store, whatever the caller does.
  token_sealed     text NOT NULL CHECK (token_sealed LIKE 'v1:%'),
  connected_by     uuid,
  connected_at     timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'broken')),
  status_detail    text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.integrations_slack_welcome_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id        text NOT NULL,
  slack_user_id  text NOT NULL,
  email          text,
  first_name     text,
  display_name   text,
  person_id      uuid REFERENCES public.people(id) ON DELETE SET NULL,
  joined_at      timestamptz NOT NULL DEFAULT now(),
  send_after     timestamptz,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  skip_reason    text,
  error          text,
  attempts       integer NOT NULL DEFAULT 0,
  sent_as        text,
  message_ts     text,
  sent_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- One welcome per person per workspace, ever. Slack redelivers events it
  -- thinks we missed; this is what makes that harmless.
  UNIQUE (team_id, slack_user_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_welcome_log_status_send_after
  ON public.integrations_slack_welcome_log (status, send_after);
CREATE INDEX IF NOT EXISTS idx_slack_welcome_log_joined_at
  ON public.integrations_slack_welcome_log (joined_at DESC);
CREATE INDEX IF NOT EXISTS idx_slack_welcome_log_email
  ON public.integrations_slack_welcome_log (lower(email));

DROP TRIGGER IF EXISTS set_updated_at ON public.integrations_slack_user_tokens;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.integrations_slack_user_tokens
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS set_updated_at ON public.integrations_slack_welcome_log;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.integrations_slack_welcome_log
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS on, no policies: nothing but service_role reaches these rows.
ALTER TABLE public.integrations_slack_user_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations_slack_welcome_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.integrations_slack_user_tokens FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.integrations_slack_welcome_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.integrations_slack_user_tokens TO service_role;
GRANT ALL ON public.integrations_slack_welcome_log TO service_role;
