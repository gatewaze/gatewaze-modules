-- ============================================================================
-- Module: engagement
-- Migration: 001_engagement_tables
-- Description: Core tables for the engagement module — outbox, events log,
--              rules, badges, member badges, eval queue, calendar settings,
--              plus the emit_engagement_signal() stub and the worker dequeue
--              function. Per spec-engagement-module.md §4, §6.
-- ============================================================================

-- ==========================================================================
-- 0. Prerequisite helpers
--
--    auth_person_id() and is_super_admin() are normally provided by the
--    conversations or calendars modules. If engagement is installed before
--    them, we define fallbacks here so our RLS policies can reference them.
--    The later modules use CREATE OR REPLACE and will overwrite safely.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.auth_person_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.people WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'is_super_admin' AND pronamespace = 'public'::regnamespace
  ) THEN
    EXECUTE $f$
      CREATE OR REPLACE FUNCTION public.is_super_admin()
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      AS $body$
        SELECT EXISTS (
          SELECT 1 FROM public.admin_profiles
          WHERE user_id = auth.uid() AND role = 'super_admin' AND is_active = true
        );
      $body$;
    $f$;
  END IF;
END $$;

-- can_admin_calendar is provided by the calendars module. Fallback stub for
-- the case where calendars isn't installed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'can_admin_calendar' AND pronamespace = 'public'::regnamespace
  ) THEN
    EXECUTE $f$
      CREATE OR REPLACE FUNCTION public.can_admin_calendar(p_calendar_id uuid)
      RETURNS boolean
      LANGUAGE sql
      STABLE
      AS $body$ SELECT public.is_super_admin(); $body$;
    $f$;
  END IF;
END $$;

-- ==========================================================================
-- 1. engagement_outbox — pending signals from source modules
--
--    Source modules insert into this table via emit_engagement_signal().
--    The engagement-record-worker drains rows, applies rule logic, and
--    writes the accepted ones into engagement_events.
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.engagement_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal          text NOT NULL,
  person_id       uuid NOT NULL,
  calendar_id     uuid,
  event_id        uuid,
  source_module   text NOT NULL,
  source_record_id uuid,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  metadata        jsonb DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','processed','failed','skipped')),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_engagement_outbox_pending
  ON public.engagement_outbox (status, enqueued_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_engagement_outbox_source
  ON public.engagement_outbox (source_module, source_record_id);

-- ==========================================================================
-- 2. engagement_events — append-only log with denormalised points
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.engagement_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  calendar_id     uuid,                       -- soft ref if calendars installed
  event_id        uuid REFERENCES public.events(id) ON DELETE SET NULL,
  signal          text NOT NULL,
  source_module   text NOT NULL,
  source_record_id uuid,
  points          integer NOT NULL DEFAULT 0,
  metadata        jsonb DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engagement_events_unique_signal
    UNIQUE (person_id, signal, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_engagement_events_person
  ON public.engagement_events (person_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_engagement_events_calendar
  ON public.engagement_events (calendar_id, occurred_at DESC)
  WHERE calendar_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_engagement_events_event
  ON public.engagement_events (event_id, occurred_at DESC)
  WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_engagement_events_signal
  ON public.engagement_events (signal, occurred_at DESC);

COMMENT ON TABLE public.engagement_events IS
  'Append-only log. Never UPDATE rows — insert a compensating row with negative points instead.';

-- ==========================================================================
-- 3. engagement_rules — scoring configuration
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.engagement_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal          text NOT NULL UNIQUE,
  label           text NOT NULL,
  description     text,
  default_points  integer NOT NULL DEFAULT 0,
  is_enabled      boolean NOT NULL DEFAULT true,
  scope           text NOT NULL DEFAULT 'global'
    CHECK (scope IN ('global','per_calendar','per_event')),
  cooldown_seconds integer DEFAULT 0,
  daily_cap       integer,
  metadata        jsonb DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS engagement_rules_updated_at ON public.engagement_rules;
CREATE TRIGGER engagement_rules_updated_at
  BEFORE UPDATE ON public.engagement_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 4. engagement_badges — badge definitions
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.engagement_badges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text UNIQUE NOT NULL,
  label           text NOT NULL,
  description     text,
  icon            text,
  color           varchar(7),
  rule_kind       text NOT NULL CHECK (rule_kind IN ('count','threshold','manual','first','streak')),
  rule_config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  scope           text NOT NULL DEFAULT 'global' CHECK (scope IN ('global','per_calendar')),
  is_visible      boolean NOT NULL DEFAULT true,
  is_active       boolean NOT NULL DEFAULT true,
  sort_order      integer DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS engagement_badges_updated_at ON public.engagement_badges;
CREATE TRIGGER engagement_badges_updated_at
  BEFORE UPDATE ON public.engagement_badges
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 5. engagement_member_badges — earned badges
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.engagement_member_badges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  badge_id        uuid NOT NULL REFERENCES public.engagement_badges(id) ON DELETE CASCADE,
  calendar_id     uuid,
  awarded_at      timestamptz NOT NULL DEFAULT now(),
  awarded_by      uuid,                                     -- admin_profiles(id), soft ref
  reason          text,
  is_revoked      boolean NOT NULL DEFAULT false,
  revoked_at      timestamptz,
  revoked_by      uuid,
  metadata        jsonb DEFAULT '{}'::jsonb,
  UNIQUE (person_id, badge_id, calendar_id)
);

CREATE INDEX IF NOT EXISTS idx_engagement_member_badges_person
  ON public.engagement_member_badges (person_id);
CREATE INDEX IF NOT EXISTS idx_engagement_member_badges_badge
  ON public.engagement_member_badges (badge_id);
CREATE INDEX IF NOT EXISTS idx_engagement_member_badges_calendar
  ON public.engagement_member_badges (calendar_id) WHERE calendar_id IS NOT NULL;

-- ==========================================================================
-- 6. engagement_badge_eval_queue — async badge evaluation queue
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.engagement_badge_eval_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  trigger_event_id uuid REFERENCES public.engagement_events(id) ON DELETE SET NULL,
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processed','failed'))
);

CREATE INDEX IF NOT EXISTS idx_engagement_badge_eval_queue_pending
  ON public.engagement_badge_eval_queue (status, enqueued_at)
  WHERE status = 'pending';

-- ==========================================================================
-- 7. engagement_calendar_settings — per-calendar leaderboard configuration
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.engagement_calendar_settings (
  calendar_id          uuid PRIMARY KEY,                    -- soft ref to calendars(id)
  leaderboard_enabled  boolean NOT NULL DEFAULT true,
  leaderboard_visibility text NOT NULL DEFAULT 'public'
    CHECK (leaderboard_visibility IN ('public','members-only','admin-only')),
  show_in_landing_widget boolean NOT NULL DEFAULT true,
  badges_enabled       boolean NOT NULL DEFAULT true,
  display_name_mode    text NOT NULL DEFAULT 'first_name_initial'
    CHECK (display_name_mode IN ('full_name','first_name_initial','username','anonymous')),
  custom_signal_overrides jsonb DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS engagement_calendar_settings_updated_at ON public.engagement_calendar_settings;
CREATE TRIGGER engagement_calendar_settings_updated_at
  BEFORE UPDATE ON public.engagement_calendar_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 8. emit_engagement_signal() — the stub source modules call
--
--    Idempotent, non-failing. Writes to the outbox. If the insert fails for
--    any reason, the error is logged via RAISE NOTICE but the caller's
--    transaction is NOT rolled back. This is deliberate: we never want the
--    engagement module to break a source module's core transaction.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.emit_engagement_signal(
  p_signal text,
  p_person_id uuid,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_person_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.engagement_outbox (
    signal, person_id, calendar_id, event_id,
    source_module, source_record_id, occurred_at, metadata
  ) VALUES (
    p_signal,
    p_person_id,
    NULLIF(p_payload->>'calendar_id', '')::uuid,
    NULLIF(p_payload->>'event_id', '')::uuid,
    COALESCE(p_payload->>'source_module', 'unknown'),
    NULLIF(p_payload->>'source_record_id', '')::uuid,
    COALESCE(NULLIF(p_payload->>'occurred_at','')::timestamptz, now()),
    p_payload - 'calendar_id' - 'event_id' - 'source_module' - 'source_record_id' - 'occurred_at'
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'emit_engagement_signal failed: %', SQLERRM;
END;
$$;

COMMENT ON FUNCTION public.emit_engagement_signal(text, uuid, jsonb) IS
  'Source modules call this to emit an engagement signal. Non-failing: any error is swallowed so the caller transaction is unaffected.';

-- ==========================================================================
-- 9. engagement_dequeue_batch() — worker dequeue helper
--
--    Claims up to p_limit pending outbox rows with FOR UPDATE SKIP LOCKED so
--    multiple workers can run concurrently without double-processing.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.engagement_dequeue_batch(p_limit integer DEFAULT 100)
RETURNS SETOF public.engagement_outbox
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.engagement_outbox o
  SET status = 'processing'
  WHERE o.id IN (
    SELECT id FROM public.engagement_outbox
    WHERE status = 'pending'
    ORDER BY enqueued_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  RETURNING *;
END;
$$;

-- ==========================================================================
-- 10. RLS
-- ==========================================================================
ALTER TABLE public.engagement_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engagement_member_badges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engagement_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engagement_badges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engagement_calendar_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engagement_outbox ENABLE ROW LEVEL SECURITY;

-- engagement_events: self-select OR admin (via can_admin_calendar/super_admin)
DROP POLICY IF EXISTS engagement_events_select ON public.engagement_events;
CREATE POLICY engagement_events_select ON public.engagement_events
  FOR SELECT USING (
    public.is_super_admin()
    OR person_id = public.auth_person_id()
    OR (calendar_id IS NOT NULL AND public.can_admin_calendar(calendar_id))
  );

-- engagement_rules + engagement_badges: public read, super-admin write
DROP POLICY IF EXISTS engagement_rules_select ON public.engagement_rules;
CREATE POLICY engagement_rules_select ON public.engagement_rules FOR SELECT USING (true);

DROP POLICY IF EXISTS engagement_rules_admin ON public.engagement_rules;
CREATE POLICY engagement_rules_admin ON public.engagement_rules
  FOR ALL USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS engagement_badges_select ON public.engagement_badges;
CREATE POLICY engagement_badges_select ON public.engagement_badges FOR SELECT USING (true);

DROP POLICY IF EXISTS engagement_badges_admin ON public.engagement_badges;
CREATE POLICY engagement_badges_admin ON public.engagement_badges
  FOR ALL USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- engagement_member_badges: same as events
DROP POLICY IF EXISTS engagement_member_badges_select ON public.engagement_member_badges;
CREATE POLICY engagement_member_badges_select ON public.engagement_member_badges
  FOR SELECT USING (
    public.is_super_admin()
    OR person_id = public.auth_person_id()
    OR (calendar_id IS NOT NULL AND public.can_admin_calendar(calendar_id))
  );

-- engagement_calendar_settings: public read, calendar-admin write
DROP POLICY IF EXISTS engagement_calendar_settings_select ON public.engagement_calendar_settings;
CREATE POLICY engagement_calendar_settings_select
  ON public.engagement_calendar_settings FOR SELECT USING (true);

DROP POLICY IF EXISTS engagement_calendar_settings_admin ON public.engagement_calendar_settings;
CREATE POLICY engagement_calendar_settings_admin
  ON public.engagement_calendar_settings
  FOR ALL USING (
    public.is_super_admin() OR public.can_admin_calendar(calendar_id)
  )
  WITH CHECK (
    public.is_super_admin() OR public.can_admin_calendar(calendar_id)
  );

-- engagement_outbox: service-role only (no public policies — default deny)
