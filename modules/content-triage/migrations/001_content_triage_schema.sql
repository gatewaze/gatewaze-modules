-- ============================================================================
-- Content Triage — schema (tables, enums, adapter registry, indexes, roles)
-- See spec-content-triage-module.md §4 and §3.3.
-- ============================================================================

-- Required for the EXCLUDE constraint on content_triage_items below.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS btree_gist;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'btree_gist not created (insufficient privilege). Enable via Supabase Dashboard.';
END $$;

-- ============================================================================
-- Trusted role for SECURITY DEFINER functions (§10.1.1)
-- This role owns all module tables + RPCs, giving the RPCs bypass-RLS
-- semantics via the table-owner path (without needing BYPASSRLS).
-- Supabase projects may already have superuser; we create the role idempotently.
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN;
  END IF;
  -- Grant the role to the calling user so subsequent ALTER TABLE
  -- ... OWNER TO gatewaze_module_writer doesn't trip 42501 on
  -- Supabase Cloud (where postgres isn't a true superuser and needs
  -- explicit role membership to transfer ownership).
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);
END $$;

-- ============================================================================
-- content_triage_adapters — registry of content-type adapters
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_triage_adapters (
  content_type   text PRIMARY KEY,
  approve_fn     regprocedure NOT NULL,
  reject_fn      regprocedure NOT NULL,
  suggest_fn     regprocedure,
  submit_fn      regprocedure,
  display_label  text NOT NULL,
  registered_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.content_triage_adapters OWNER TO gatewaze_module_writer;

REVOKE ALL ON public.content_triage_adapters FROM PUBLIC;
GRANT SELECT ON public.content_triage_adapters TO authenticated, anon;

-- Validate adapter registrations: check function existence, ownership, and signature.
CREATE OR REPLACE FUNCTION public.triage_validate_adapter_registration()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_owner_rolname text;
BEGIN
  -- approve_fn: expected (uuid, text[], boolean, uuid)
  SELECT r.rolname INTO v_owner_rolname
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.oid = NEW.approve_fn::oid;
  IF NOT FOUND THEN RAISE EXCEPTION 'approve_fn OID % does not exist', NEW.approve_fn; END IF;
  IF v_owner_rolname <> 'gatewaze_module_writer' THEN
    RAISE EXCEPTION 'approve_fn % must be owned by gatewaze_module_writer (found %)', NEW.approve_fn, v_owner_rolname;
  END IF;
  IF (SELECT oidvectortypes(proargtypes) FROM pg_proc WHERE oid = NEW.approve_fn::oid) <> 'uuid, text[], boolean, uuid' THEN
    RAISE EXCEPTION 'approve_fn % expected signature (uuid, text[], boolean, uuid)', NEW.approve_fn;
  END IF;

  -- reject_fn: expected (uuid, text, uuid)
  SELECT r.rolname INTO v_owner_rolname
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.oid = NEW.reject_fn::oid;
  IF NOT FOUND THEN RAISE EXCEPTION 'reject_fn OID % does not exist', NEW.reject_fn; END IF;
  IF v_owner_rolname <> 'gatewaze_module_writer' THEN
    RAISE EXCEPTION 'reject_fn % must be owned by gatewaze_module_writer', NEW.reject_fn;
  END IF;
  IF (SELECT oidvectortypes(proargtypes) FROM pg_proc WHERE oid = NEW.reject_fn::oid) <> 'uuid, text, uuid' THEN
    RAISE EXCEPTION 'reject_fn % expected signature (uuid, text, uuid)', NEW.reject_fn;
  END IF;

  -- suggest_fn (optional): expected (uuid)
  IF NEW.suggest_fn IS NOT NULL THEN
    SELECT r.rolname INTO v_owner_rolname
    FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = NEW.suggest_fn::oid;
    IF NOT FOUND THEN RAISE EXCEPTION 'suggest_fn OID % does not exist', NEW.suggest_fn; END IF;
    IF v_owner_rolname <> 'gatewaze_module_writer' THEN
      RAISE EXCEPTION 'suggest_fn % must be owned by gatewaze_module_writer', NEW.suggest_fn;
    END IF;
    IF (SELECT oidvectortypes(proargtypes) FROM pg_proc WHERE oid = NEW.suggest_fn::oid) <> 'uuid' THEN
      RAISE EXCEPTION 'suggest_fn % expected signature (uuid)', NEW.suggest_fn;
    END IF;
  END IF;

  -- submit_fn (optional): expected (uuid, boolean)
  IF NEW.submit_fn IS NOT NULL THEN
    SELECT r.rolname INTO v_owner_rolname
    FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = NEW.submit_fn::oid;
    IF NOT FOUND THEN RAISE EXCEPTION 'submit_fn OID % does not exist', NEW.submit_fn; END IF;
    IF v_owner_rolname <> 'gatewaze_module_writer' THEN
      RAISE EXCEPTION 'submit_fn % must be owned by gatewaze_module_writer', NEW.submit_fn;
    END IF;
    IF (SELECT oidvectortypes(proargtypes) FROM pg_proc WHERE oid = NEW.submit_fn::oid) <> 'uuid, boolean' THEN
      RAISE EXCEPTION 'submit_fn % expected signature (uuid, boolean)', NEW.submit_fn;
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS triage_adapters_validate ON public.content_triage_adapters;
CREATE TRIGGER triage_adapters_validate
  BEFORE INSERT OR UPDATE ON public.content_triage_adapters
  FOR EACH ROW EXECUTE FUNCTION public.triage_validate_adapter_registration();

-- ============================================================================
-- content_triage_teams
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_triage_teams (
  name        text PRIMARY KEY,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.content_triage_teams OWNER TO gatewaze_module_writer;

CREATE TABLE IF NOT EXISTS public.content_triage_team_members (
  team_name  text NOT NULL REFERENCES public.content_triage_teams(name) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_name, user_id)
);
ALTER TABLE public.content_triage_team_members OWNER TO gatewaze_module_writer;
CREATE INDEX IF NOT EXISTS idx_team_members_user ON public.content_triage_team_members(user_id);

-- ============================================================================
-- content_triage_items — the core queue
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_triage_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  content_type         text NOT NULL,
  content_id           uuid NOT NULL,

  source               text NOT NULL,
  source_ref           text,

  suggested_categories text[] NOT NULL DEFAULT '{}',
  suggested_from       text NOT NULL DEFAULT 'none',
  suggested_confidence numeric CHECK (suggested_confidence IS NULL OR (suggested_confidence BETWEEN 0 AND 1)),
  applied_categories   text[] NOT NULL DEFAULT '{}',

  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected','changes_requested')),
  priority             smallint NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  is_featured          boolean NOT NULL DEFAULT false,

  assigned_to          uuid REFERENCES auth.users(id),
  assigned_at          timestamptz,
  assigned_by          uuid REFERENCES auth.users(id),
  team_name            text REFERENCES public.content_triage_teams(name) ON DELETE SET NULL,

  reviewed_at          timestamptz,
  reviewed_by          uuid REFERENCES auth.users(id),
  review_notes         text CHECK (review_notes IS NULL OR length(review_notes) <= 2000),
  reject_reason        text CHECK (reject_reason IS NULL OR length(reject_reason) <= 2000),

  auto_approved_at     timestamptz,
  auto_approved_reason text CHECK (auto_approved_reason IS NULL OR length(auto_approved_reason) <= 256),
  flagged_at           timestamptz,

  lifecycle_key        integer NOT NULL DEFAULT 1,

  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,

  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),

  -- An active (pending or changes_requested) item is unique per (content_type, content_id).
  CONSTRAINT content_triage_items_unique_active
    EXCLUDE (content_type WITH =, content_id WITH =)
    WHERE (status IN ('pending','changes_requested')),

  -- Assignment XOR: either user OR team OR neither, never both.
  CONSTRAINT triage_items_assign_xor CHECK (
    (assigned_to IS NULL AND team_name IS NULL)
    OR (assigned_to IS NOT NULL AND team_name IS NULL)
    OR (assigned_to IS NULL AND team_name IS NOT NULL)
  ),

  -- assigned_at consistency.
  CONSTRAINT triage_items_assigned_at_consistency CHECK (
    (assigned_at IS NULL AND assigned_to IS NULL)
    OR (assigned_at IS NOT NULL AND assigned_to IS NOT NULL)
  ),

  -- Review status consistency (pending / human-reviewed / auto-approved).
  CONSTRAINT triage_items_reviewed_consistency CHECK (
    (status = 'pending' AND reviewed_at IS NULL AND reviewed_by IS NULL
       AND auto_approved_at IS NULL)
    OR (status = 'changes_requested' AND reviewed_at IS NOT NULL
       AND reviewed_by IS NOT NULL AND auto_approved_at IS NULL)
    OR (status IN ('approved','rejected') AND (
         (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND auto_approved_at IS NULL)
         OR (auto_approved_at IS NOT NULL AND reviewed_by IS NULL AND reviewed_at IS NULL)
       ))
  )
);
ALTER TABLE public.content_triage_items OWNER TO gatewaze_module_writer;

-- Enforce that content_type matches a registered adapter (can't FK a PK here because
-- of circular-install ordering, so trigger instead).
CREATE OR REPLACE FUNCTION public.triage_validate_content_type()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.content_triage_adapters WHERE content_type = NEW.content_type) THEN
    RAISE EXCEPTION 'No adapter registered for content_type=%', NEW.content_type;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS triage_items_validate_type ON public.content_triage_items;
CREATE TRIGGER triage_items_validate_type
  BEFORE INSERT OR UPDATE OF content_type ON public.content_triage_items
  FOR EACH ROW EXECUTE FUNCTION public.triage_validate_content_type();

CREATE INDEX IF NOT EXISTS idx_triage_queue
  ON public.content_triage_items (status, assigned_to, priority DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_triage_queue_team
  ON public.content_triage_items (status, team_name, priority DESC, created_at DESC)
  WHERE team_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_triage_queue_type
  ON public.content_triage_items (content_type, status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_triage_content_ref
  ON public.content_triage_items (content_type, content_id);
CREATE INDEX IF NOT EXISTS idx_triage_items_metadata_gin
  ON public.content_triage_items USING GIN (metadata jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_triage_auto_approved
  ON public.content_triage_items (auto_approved_at DESC)
  WHERE auto_approved_at IS NOT NULL;

-- ============================================================================
-- content_triage_routes — declarative auto-assignment rules
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_triage_routes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  description      text,

  -- Match criteria; NULL = wildcard.
  content_type     text,
  category         text,
  source           text,
  source_ref_filter text,
  metadata_filter  jsonb,

  -- Action
  assign_to              uuid REFERENCES auth.users(id),
  assign_to_team_name    text REFERENCES public.content_triage_teams(name) ON DELETE SET NULL,
  notify_channels        text[] NOT NULL DEFAULT '{in_app}',
  mode_override          text CHECK (mode_override IS NULL OR mode_override IN ('auto_publish','auto_approve','review')),

  priority         integer NOT NULL DEFAULT 100,
  active           boolean NOT NULL DEFAULT true,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- Exactly one assignment target when either is set. Zero is allowed (catch-all route that only notifies).
  CONSTRAINT triage_routes_assign_exactly_one CHECK (
    (assign_to IS NULL AND assign_to_team_name IS NULL)
    OR ((assign_to IS NOT NULL)::int + (assign_to_team_name IS NOT NULL)::int = 1)
  )
);
ALTER TABLE public.content_triage_routes OWNER TO gatewaze_module_writer;

CREATE INDEX IF NOT EXISTS idx_routes_active_priority
  ON public.content_triage_routes (active, priority DESC);

-- ============================================================================
-- content_triage_events — immutable audit log
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_triage_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES public.content_triage_items(id) ON DELETE CASCADE,
  event_type  text NOT NULL,
  from_status text,
  to_status   text,
  actor_id    uuid REFERENCES auth.users(id),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.content_triage_events OWNER TO gatewaze_module_writer;
CREATE INDEX IF NOT EXISTS idx_triage_events_item
  ON public.content_triage_events (item_id, created_at DESC);

-- Enforce immutability: reject UPDATE and DELETE from everyone (including the owner).
-- Only INSERT is allowed, and only from within the triage RPCs.
REVOKE UPDATE, DELETE ON public.content_triage_events FROM PUBLIC, authenticated, anon;

-- ============================================================================
-- content_triage_notifications — outbound delivery log
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_triage_notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id           uuid NOT NULL REFERENCES public.content_triage_items(id) ON DELETE CASCADE,
  lifecycle_key     integer NOT NULL,
  recipient_id      uuid NOT NULL REFERENCES auth.users(id),
  channel           text NOT NULL CHECK (channel IN ('in_app','email','slack')),
  notification_type text NOT NULL CHECK (notification_type IN (
                       'assigned','changes_requested','reopened','mention','reminder'
                    )),
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,

  sent_at           timestamptz,
  sent_status       text NOT NULL DEFAULT 'pending'
                    CHECK (sent_status IN ('pending','sent','failed_transient','failed_permanent','suppressed')),
  retry_count       smallint NOT NULL DEFAULT 0,
  sent_error        text,
  read_at           timestamptz,
  digest_key        text,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT triage_notifications_unique
    UNIQUE (item_id, lifecycle_key, recipient_id, channel, notification_type)
);
ALTER TABLE public.content_triage_notifications OWNER TO gatewaze_module_writer;
CREATE INDEX IF NOT EXISTS idx_triage_notif_pending
  ON public.content_triage_notifications (sent_status, created_at)
  WHERE sent_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_triage_notif_inbox
  ON public.content_triage_notifications (recipient_id, channel, read_at)
  WHERE channel = 'in_app';

-- ============================================================================
-- content_triage_user_prefs
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_triage_user_prefs (
  user_id                    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  in_app_enabled             boolean NOT NULL DEFAULT true,
  email_enabled              boolean NOT NULL DEFAULT true,
  email_digest_mode          text NOT NULL DEFAULT 'immediate'
                             CHECK (email_digest_mode IN ('immediate','hourly','daily','off')),
  slack_enabled              boolean NOT NULL DEFAULT false,
  slack_user_ref             text,
  max_notifications_per_hour smallint NOT NULL DEFAULT 30,
  timezone                   text,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.content_triage_user_prefs OWNER TO gatewaze_module_writer;

-- ============================================================================
-- content_triage_idempotency — idempotency-key storage (24h retention)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.content_triage_idempotency (
  user_id         uuid NOT NULL,
  route           text NOT NULL,
  key             text NOT NULL,
  first_seen      timestamptz NOT NULL DEFAULT now(),
  request_hash    bytea NOT NULL,
  response_status smallint NOT NULL,
  response_body   jsonb NOT NULL,
  PRIMARY KEY (user_id, route, key)
);
ALTER TABLE public.content_triage_idempotency OWNER TO gatewaze_module_writer;
CREATE INDEX IF NOT EXISTS idx_triage_idempotency_expiry
  ON public.content_triage_idempotency (first_seen);

-- ============================================================================
-- RLS — enable on all tables; policies focus on SELECT for reviewers,
-- and revoke DML from non-owners (RPCs are SECURITY DEFINER + owned by
-- gatewaze_module_writer which bypasses RLS as table owner).
-- ============================================================================
ALTER TABLE public.content_triage_items              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_triage_events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_triage_notifications      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_triage_user_prefs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_triage_routes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_triage_teams              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_triage_team_members       ENABLE ROW LEVEL SECURITY;

-- Helper: is_admin() — reuses the existing Gatewaze admin-check helper if
-- present, else conservative fallback. Each brand has its own is_admin
-- definition in core migrations; we don't redefine.

-- items: SELECT for admins; DML only via RPCs.
DROP POLICY IF EXISTS triage_items_select ON public.content_triage_items;
CREATE POLICY triage_items_select ON public.content_triage_items
  FOR SELECT TO authenticated
  USING ( public.is_admin() );

DROP POLICY IF EXISTS triage_events_select ON public.content_triage_events;
CREATE POLICY triage_events_select ON public.content_triage_events
  FOR SELECT TO authenticated
  USING ( public.is_admin() );

-- notifications: recipient sees own, admins see all
DROP POLICY IF EXISTS triage_notif_select ON public.content_triage_notifications;
CREATE POLICY triage_notif_select ON public.content_triage_notifications
  FOR SELECT TO authenticated
  USING ( recipient_id = auth.uid() OR public.is_admin() );

DROP POLICY IF EXISTS triage_notif_update_read ON public.content_triage_notifications;
CREATE POLICY triage_notif_update_read ON public.content_triage_notifications
  FOR UPDATE TO authenticated
  USING ( recipient_id = auth.uid() )
  WITH CHECK ( recipient_id = auth.uid() );

-- user_prefs: own row only
DROP POLICY IF EXISTS triage_prefs_rw ON public.content_triage_user_prefs;
CREATE POLICY triage_prefs_rw ON public.content_triage_user_prefs
  FOR ALL TO authenticated
  USING ( user_id = auth.uid() )
  WITH CHECK ( user_id = auth.uid() );

-- routes + teams: admin only
DROP POLICY IF EXISTS triage_routes_rw ON public.content_triage_routes;
CREATE POLICY triage_routes_rw ON public.content_triage_routes
  FOR ALL TO authenticated
  USING ( public.is_admin() )
  WITH CHECK ( public.is_admin() );

DROP POLICY IF EXISTS triage_teams_rw ON public.content_triage_teams;
CREATE POLICY triage_teams_rw ON public.content_triage_teams
  FOR ALL TO authenticated
  USING ( public.is_admin() )
  WITH CHECK ( public.is_admin() );

DROP POLICY IF EXISTS triage_team_members_rw ON public.content_triage_team_members;
CREATE POLICY triage_team_members_rw ON public.content_triage_team_members
  FOR ALL TO authenticated
  USING ( public.is_admin() OR user_id = auth.uid() )
  WITH CHECK ( public.is_admin() );

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.triage_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS triage_items_updated_at ON public.content_triage_items;
CREATE TRIGGER triage_items_updated_at BEFORE UPDATE ON public.content_triage_items
  FOR EACH ROW EXECUTE FUNCTION public.triage_set_updated_at();

DROP TRIGGER IF EXISTS triage_routes_updated_at ON public.content_triage_routes;
CREATE TRIGGER triage_routes_updated_at BEFORE UPDATE ON public.content_triage_routes
  FOR EACH ROW EXECUTE FUNCTION public.triage_set_updated_at();

DROP TRIGGER IF EXISTS triage_prefs_updated_at ON public.content_triage_user_prefs;
CREATE TRIGGER triage_prefs_updated_at BEFORE UPDATE ON public.content_triage_user_prefs
  FOR EACH ROW EXECUTE FUNCTION public.triage_set_updated_at();
