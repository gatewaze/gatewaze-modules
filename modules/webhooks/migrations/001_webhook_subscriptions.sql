-- ============================================================================
-- Module: webhooks
-- Migration: 001_webhook_subscriptions
-- Description: Tables for mutation-driven outbound webhooks (Layer 2 of
--              spec-api-cache-and-revalidation.md). Three tables:
--                * webhook_subscriptions  — destinations + HMAC secrets
--                * webhook_event_topics   — table → surrogate-key mapping
--                * webhook_deliveries     — append-only delivery log
-- ============================================================================

-- ----------------------------------------------------------------------------
-- webhook_subscriptions
-- ----------------------------------------------------------------------------
-- Per spec §4.1. host_id is `text` (not uuid) so future host_kinds
-- ('list', 'newsletter', 'global') can identify hosts by slug, int, or
-- the well-known global UUID without a schema migration.
CREATE TABLE IF NOT EXISTS public.webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_kind text NOT NULL CHECK (host_kind IN ('site','list','newsletter','global')),
  host_id text NOT NULL,
  url text NOT NULL,
  -- Empty array = subscribe to all registered topics for the host_kind/host_id.
  -- Non-empty = subset filter; elements must match webhook_event_topics.topic.
  topics text[] NOT NULL DEFAULT '{}',
  -- HMAC shared secret. Rotated via admin endpoint; old secret kept in
  -- secret_previous for 24h to give themes time to redeploy.
  secret text NOT NULL,
  secret_previous text,
  secret_rotated_at timestamptz,
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled','suspended')),
  -- consecutive_failures auto-flips status to 'suspended' at 10 (handled
  -- in webhook-hub.ts, not by trigger — gives the hub a chance to log the
  -- failure context before suspension).
  consecutive_failures int NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS webhook_subscriptions_host_status_idx
  ON public.webhook_subscriptions (host_kind, host_id, status);

-- Auto-touch updated_at on UPDATE.
CREATE OR REPLACE FUNCTION public.webhooks_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS webhook_subscriptions_updated_at ON public.webhook_subscriptions;
CREATE TRIGGER webhook_subscriptions_updated_at
  BEFORE UPDATE ON public.webhook_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.webhooks_set_updated_at();

-- ----------------------------------------------------------------------------
-- webhook_event_topics
-- ----------------------------------------------------------------------------
-- Per spec §4.2. Static-ish lookup keyed by table name. Data-driven so the
-- shared emit_mutation_event() trigger function never needs to be modified
-- to add a new module — only INSERT a row here and CREATE TRIGGER on the
-- module's table.
CREATE TABLE IF NOT EXISTS public.webhook_event_topics (
  topic text PRIMARY KEY,
  -- Column on the row that holds the row's host_id. NULL = global topic
  -- (cross-tenant; the trigger emits host_kind='global' and the
  -- well-known global UUID).
  host_id_column text,
  -- Literal (no template variables in v1). Becomes the bulk surrogate
  -- key for the topic (e.g. 'daily-briefing').
  surrogate_key_template text NOT NULL,
  -- Optional detail key template. May reference fields captured into
  -- notify_columns, e.g. 'daily-briefing:{slug}'. Webhook Hub
  -- materialises {field} placeholders from the NOTIFY payload's
  -- `row` object.
  detail_key_template text,
  -- Columns to materialise into the NOTIFY payload (from OLD on delete,
  -- NEW on insert/update). The only way to populate detail keys for
  -- DELETE operations — the row is gone by the time the Hub runs.
  notify_columns text[] NOT NULL DEFAULT '{}',
  description text
);

-- ----------------------------------------------------------------------------
-- webhook_deliveries
-- ----------------------------------------------------------------------------
-- Per spec §4.3. Append-only delivery log; auto-purged at 30d via a cron
-- (delete rows past retention_until).
CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES public.webhook_subscriptions(id) ON DELETE CASCADE,
  -- Correlation across the fan-out from a single mutation event. Multiple
  -- delivery rows share an event_id when one mutation fans out to N subs.
  event_id uuid NOT NULL,
  topic text NOT NULL,
  op text NOT NULL CHECK (op IN ('insert','update','delete','burst')),
  row_id uuid,
  payload jsonb NOT NULL,
  surrogate_keys text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','failed','permanently_failed','skipped')),
  attempt_count int NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  last_response_status int,
  last_response_body text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  first_sent_at timestamptz,
  succeeded_at timestamptz,
  retention_until timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_subscription_status_idx
  ON public.webhook_deliveries (subscription_id, status, next_retry_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_retention_idx
  ON public.webhook_deliveries (retention_until)
  WHERE status IN ('sent','permanently_failed','skipped');
-- Speeds up the recovery sweep (LISTEN worker on reconnect).
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending_created_idx
  ON public.webhook_deliveries (created_at)
  WHERE status = 'pending';

-- ----------------------------------------------------------------------------
-- RLS — service_role bypasses; everything else denied unless explicitly granted
-- ----------------------------------------------------------------------------
ALTER TABLE public.webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_event_topics  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries    ENABLE ROW LEVEL SECURITY;

-- webhook_event_topics: authenticated read (admin UI shows the topics list
-- in the subscription form's topic-multiselect). Writes via service_role
-- only (module migrations).
DROP POLICY IF EXISTS "webhook_event_topics_authenticated_read" ON public.webhook_event_topics;
CREATE POLICY "webhook_event_topics_authenticated_read"
  ON public.webhook_event_topics FOR SELECT
  TO authenticated
  USING (true);

-- webhook_subscriptions: per spec §4.1 — admins (via the platform's
-- is_platform_admin helper, when present) can SELECT/INSERT/UPDATE on
-- rows whose host they administer. The `secret` column is masked in API
-- responses (returned as '<redacted>' except on creation); enforced in
-- the route handler, not by RLS.
CREATE OR REPLACE FUNCTION public.webhooks_can_admin_subscription(
  p_host_kind text,
  p_host_id text
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid uuid;
BEGIN
  v_uid = auth.uid();
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  -- Defer to the platform helper when available.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
     WHERE n.nspname = 'public' AND p.proname = 'is_platform_admin'
  ) THEN
    IF (SELECT public.is_platform_admin()) THEN
      RETURN true;
    END IF;
  END IF;

  -- Site-scoped: delegate to can_admin_site() when present and host_kind='site'.
  IF p_host_kind = 'site' THEN
    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = 'public' AND p.proname = 'can_admin_site'
    ) THEN
      -- host_id is text; can_admin_site takes uuid. The cast can throw if
      -- a host_id row isn't UUID-shaped, which is fine — that row isn't
      -- managed by a site admin.
      BEGIN
        RETURN (SELECT public.can_admin_site(p_host_id::uuid));
      EXCEPTION WHEN invalid_text_representation THEN
        RETURN false;
      END;
    END IF;
  END IF;

  RETURN false;
END;
$$;

DROP POLICY IF EXISTS "webhook_subscriptions_admin_select" ON public.webhook_subscriptions;
CREATE POLICY "webhook_subscriptions_admin_select"
  ON public.webhook_subscriptions FOR SELECT
  TO authenticated
  USING (public.webhooks_can_admin_subscription(host_kind, host_id));

-- webhook_deliveries: admin of the parent subscription may read.
DROP POLICY IF EXISTS "webhook_deliveries_admin_select" ON public.webhook_deliveries;
CREATE POLICY "webhook_deliveries_admin_select"
  ON public.webhook_deliveries FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.webhook_subscriptions s
     WHERE s.id = webhook_deliveries.subscription_id
       AND public.webhooks_can_admin_subscription(s.host_kind, s.host_id)
  ));

COMMENT ON TABLE public.webhook_subscriptions IS
  'Per-host outbound webhook destinations. Layer 2 of spec-api-cache-and-revalidation.';
COMMENT ON TABLE public.webhook_event_topics IS
  'Lookup driving the shared emit_mutation_event() trigger. One row per subscribed table.';
COMMENT ON TABLE public.webhook_deliveries IS
  'Append-only delivery log. Auto-purged 30d after creation by webhooks retention cron.';
