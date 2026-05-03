-- ============================================================================
-- Module: lists
-- Migration: 001_lists_tables
-- Description: Core tables for subscription list management.
-- ============================================================================

-- ==========================================================================
-- 1. Lists table — subscription list definitions
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.lists (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text UNIQUE NOT NULL,
  name              text NOT NULL,
  description       text,
  is_active         boolean DEFAULT true,
  is_public         boolean DEFAULT true,
  default_subscribed boolean DEFAULT false,
  webhook_url       text,
  webhook_secret    text,
  webhook_events    text[] DEFAULT '{}',
  metadata          jsonb DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lists_slug ON public.lists (slug);
CREATE INDEX IF NOT EXISTS idx_lists_is_active ON public.lists (is_active);

-- ==========================================================================
-- 2. List subscriptions — per-person subscription records
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.list_subscriptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id           uuid NOT NULL REFERENCES public.lists(id) ON DELETE CASCADE,
  person_id         uuid REFERENCES public.people(id) ON DELETE SET NULL,
  email             text NOT NULL,
  subscribed        boolean DEFAULT true,
  subscribed_at     timestamptz DEFAULT now(),
  unsubscribed_at   timestamptz,
  source            text DEFAULT 'manual',
  metadata          jsonb DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE(list_id, email)
);

CREATE INDEX IF NOT EXISTS idx_list_subscriptions_list_id ON public.list_subscriptions (list_id);
CREATE INDEX IF NOT EXISTS idx_list_subscriptions_email ON public.list_subscriptions (email);
CREATE INDEX IF NOT EXISTS idx_list_subscriptions_person_id ON public.list_subscriptions (person_id);
CREATE INDEX IF NOT EXISTS idx_list_subscriptions_subscribed ON public.list_subscriptions (list_id, subscribed);

-- ==========================================================================
-- 3. List webhook logs — delivery tracking
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.list_webhook_logs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id           uuid NOT NULL REFERENCES public.lists(id) ON DELETE CASCADE,
  event_type        text NOT NULL,
  email             text NOT NULL,
  status            text DEFAULT 'pending',
  response_code     integer,
  response_body     text,
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_list_webhook_logs_list_id ON public.list_webhook_logs (list_id);

-- ==========================================================================
-- 4. RPC: Get subscriber counts per list
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.lists_get_subscriber_counts()
RETURNS TABLE(list_id uuid, subscriber_count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT ls.list_id, COUNT(*) AS subscriber_count
  FROM list_subscriptions ls
  WHERE ls.subscribed = true
  GROUP BY ls.list_id;
$$;

-- ==========================================================================
-- 5. RLS Policies
-- ==========================================================================
ALTER TABLE public.lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.list_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.list_webhook_logs ENABLE ROW LEVEL SECURITY;

-- Lists: anyone can read active lists, admin can manage
DROP POLICY IF EXISTS lists_select ON public.lists;
DROP POLICY IF EXISTS lists_insert ON public.lists;
DROP POLICY IF EXISTS lists_update ON public.lists;
DROP POLICY IF EXISTS lists_delete ON public.lists;
CREATE POLICY lists_select ON public.lists FOR SELECT TO authenticated USING (true);
CREATE POLICY lists_insert ON public.lists FOR INSERT TO authenticated WITH CHECK (
  EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND role IN ('super_admin', 'admin'))
);
CREATE POLICY lists_update ON public.lists FOR UPDATE TO authenticated USING (
  EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND role IN ('super_admin', 'admin'))
);
CREATE POLICY lists_delete ON public.lists FOR DELETE TO authenticated USING (
  EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND role IN ('super_admin', 'admin'))
);

-- List subscriptions: authenticated can read, admin can manage all
DROP POLICY IF EXISTS list_subs_select ON public.list_subscriptions;
DROP POLICY IF EXISTS list_subs_insert ON public.list_subscriptions;
DROP POLICY IF EXISTS list_subs_update ON public.list_subscriptions;
DROP POLICY IF EXISTS list_subs_delete ON public.list_subscriptions;
CREATE POLICY list_subs_select ON public.list_subscriptions FOR SELECT TO authenticated USING (true);
CREATE POLICY list_subs_insert ON public.list_subscriptions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY list_subs_update ON public.list_subscriptions FOR UPDATE TO authenticated USING (true);
CREATE POLICY list_subs_delete ON public.list_subscriptions FOR DELETE TO authenticated USING (
  EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND role IN ('super_admin', 'admin'))
);

-- Webhook logs: admin only
DROP POLICY IF EXISTS webhook_logs_select ON public.list_webhook_logs;
CREATE POLICY webhook_logs_select ON public.list_webhook_logs FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM admin_profiles WHERE user_id = auth.uid() AND role IN ('super_admin', 'admin'))
);
