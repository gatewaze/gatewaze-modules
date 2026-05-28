-- ============================================================================
-- Module: conversations
-- Migration: 002_conversations_rls
-- Description: RLS policies + permission helper functions for the
--              multi-level moderation model. Per spec-conversations-module.md
--              §7 (permission and visibility) and §8.1 (multi-level moderation).
-- ============================================================================

-- ==========================================================================
-- 1. Helper: auth_person_id() — resolve current Supabase user → person uuid
--
--    Reads from people.auth_user_id (the standard mapping). Returns NULL
--    for unauthenticated requests.
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

-- ==========================================================================
-- 2. is_super_admin() — already exists in calendars module, but add a fallback
--    so conversations can run without calendars installed.
-- ==========================================================================
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

-- ==========================================================================
-- 3. is_super_admin_with_dm_audit() — gates super-admin DM access behind a
--    brand-level flag.
--
--    brand_settings may not exist on every deployment. If it doesn't, the
--    flag is treated as false (super-admins never auto-read DM contents).
--    This is the safer default.
-- ==========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='brand_settings') THEN
    EXECUTE $f$
      CREATE OR REPLACE FUNCTION public.is_super_admin_with_dm_audit()
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $body$
        SELECT public.is_super_admin()
          AND EXISTS (
            SELECT 1 FROM public.brand_settings
            WHERE COALESCE((metadata->>'dm_audit_enabled')::boolean, false) = true
            LIMIT 1
          );
      $body$;
    $f$;
  ELSE
    EXECUTE $f$
      CREATE OR REPLACE FUNCTION public.is_super_admin_with_dm_audit()
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public
      AS $body$ SELECT false; $body$;
    $f$;
  END IF;
END $$;

-- ==========================================================================
-- 4. can_see_conversation(p_conv_id) — read permission
--
--    Returns true if the current user can SELECT messages from this conversation.
--    Logic per spec §7.1:
--      - super_admin: always (DMs gated separately by is_super_admin_with_dm_audit)
--      - DM: must be one of the two participants
--      - calendar_channel: depends on visibility
--          - public: anyone
--          - members: must be active calendar member
--          - private: must have explicit chat_participants row
--      - event_channel: depends on visibility
--          - public: anyone
--          - registered: must have non-cancelled events_registrations row
--      - group_channel / admin_channel: explicit chat_participants row
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.can_see_conversation(p_conv_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv RECORD;
  v_person_id uuid;
BEGIN
  SELECT * INTO v_conv FROM public.conversations WHERE id = p_conv_id;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Super-admin shortcut, but DMs require dm_audit_enabled
  IF public.is_super_admin() THEN
    IF v_conv.kind = 'dm' THEN
      RETURN public.is_super_admin_with_dm_audit();
    END IF;
    RETURN true;
  END IF;

  v_person_id := public.auth_person_id();
  IF v_person_id IS NULL THEN RETURN false; END IF;

  -- Always: explicit participant row grants access (any conversation kind)
  IF EXISTS (
    SELECT 1 FROM public.conversations_participants
    WHERE conversation_id = p_conv_id AND person_id = v_person_id AND is_left = false
  ) THEN
    RETURN true;
  END IF;

  -- DM: only participants (handled above by participant check)
  IF v_conv.kind = 'dm' THEN
    RETURN false;
  END IF;

  -- calendar_channel
  IF v_conv.kind IN ('calendar_channel', 'group_channel') THEN
    IF v_conv.visibility = 'public' THEN RETURN true; END IF;
    IF v_conv.visibility = 'members' AND v_conv.calendar_id IS NOT NULL THEN
      RETURN EXISTS (
        SELECT 1 FROM public.calendars_members
        WHERE calendar_id = v_conv.calendar_id
          AND person_id = v_person_id
          AND membership_status = 'active'
      );
    END IF;
    -- private: only explicit participants (handled above)
    RETURN false;
  END IF;

  -- event_channel
  IF v_conv.kind = 'event_channel' THEN
    IF v_conv.visibility = 'public' THEN RETURN true; END IF;
    IF v_conv.visibility = 'registered' AND v_conv.event_id IS NOT NULL THEN
      RETURN EXISTS (
        SELECT 1 FROM public.events_registrations
        WHERE event_uuid = v_conv.event_id
          AND person_id = v_person_id
          AND COALESCE(registration_status, 'confirmed') NOT IN ('cancelled')
      );
    END IF;
    RETURN false;
  END IF;

  -- admin_channel: only explicit participants
  RETURN false;
END;
$$;

-- ==========================================================================
-- 5. can_post_conversation(p_conv_id) — write permission
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.can_post_conversation(p_conv_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv RECORD;
  v_person_id uuid;
  v_blocked boolean;
  v_username text;
  v_last_post timestamptz;
BEGIN
  SELECT * INTO v_conv FROM public.conversations WHERE id = p_conv_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_conv.is_archived THEN RETURN false; END IF;

  IF NOT public.can_see_conversation(p_conv_id) THEN RETURN false; END IF;

  v_person_id := public.auth_person_id();
  IF v_person_id IS NULL THEN RETURN false; END IF;

  -- Blocked check: per-conversation OR brand-wide
  SELECT EXISTS (
    SELECT 1 FROM public.conversations_blocked_users
    WHERE person_id = v_person_id
      AND (conversation_id = p_conv_id OR conversation_id IS NULL)
      AND (expires_at IS NULL OR expires_at > now())
  ) INTO v_blocked;
  IF v_blocked THEN RETURN false; END IF;

  -- Username required for channels
  IF v_conv.require_username THEN
    SELECT username INTO v_username
    FROM public.people_profiles WHERE id = (
      SELECT people_profile_id FROM public.people WHERE id = v_person_id
    );
    -- Fall back to direct lookup if people_profile_id isn't set
    IF v_username IS NULL THEN
      SELECT username INTO v_username FROM public.people_profiles WHERE id = v_person_id;
    END IF;
    IF v_username IS NULL OR length(trim(v_username)) = 0 THEN
      RETURN false;
    END IF;
  END IF;

  -- Slowmode
  IF v_conv.slowmode_seconds > 0 THEN
    SELECT max(created_at) INTO v_last_post
    FROM public.conversations_messages
    WHERE conversation_id = p_conv_id AND person_id = v_person_id;
    IF v_last_post IS NOT NULL AND v_last_post > now() - (v_conv.slowmode_seconds || ' seconds')::interval THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$$;

-- ==========================================================================
-- 6. can_moderate_conversation(p_conv_id) — moderator permission
--
--    Implements the multi-level moderation matrix from spec §8.1:
--      - super_admin: all conversations
--      - calendar admin: that calendar's default channel + group channels
--        on it + event channels for events linked via calendars_events
--      - event admin: that event's channels
--      - channel owner/moderator: that one conversation
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.can_moderate_conversation(p_conv_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv RECORD;
  v_person_id uuid;
BEGIN
  SELECT * INTO v_conv FROM public.conversations WHERE id = p_conv_id;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Super-admin always (excluding DM contents which is handled via DM audit)
  IF public.is_super_admin() THEN
    IF v_conv.kind = 'dm' THEN
      RETURN public.is_super_admin_with_dm_audit();
    END IF;
    RETURN true;
  END IF;

  v_person_id := public.auth_person_id();
  IF v_person_id IS NULL THEN RETURN false; END IF;

  -- Owner or moderator on this conversation specifically
  IF EXISTS (
    SELECT 1 FROM public.conversations_participants
    WHERE conversation_id = p_conv_id
      AND person_id = v_person_id
      AND role IN ('owner', 'moderator')
      AND is_left = false
  ) THEN
    RETURN true;
  END IF;

  -- Calendar admin: their calendar's channel + group channels + event channels
  IF v_conv.kind IN ('calendar_channel', 'group_channel') AND v_conv.calendar_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.admin_calendar_permissions acp
      JOIN public.admin_profiles ap ON ap.id = acp.admin_id
      WHERE acp.calendar_id = v_conv.calendar_id
        AND ap.user_id = auth.uid()
        AND ap.is_active = true
        AND acp.is_active = true
        AND acp.permission_level IN ('edit', 'manage')
        AND (acp.expires_at IS NULL OR acp.expires_at > now())
    ) THEN
      RETURN true;
    END IF;
  END IF;

  IF v_conv.kind = 'event_channel' AND v_conv.event_id IS NOT NULL THEN
    -- Event admin (direct)
    IF EXISTS (
      SELECT 1 FROM public.admin_event_permissions aep
      JOIN public.admin_profiles ap ON ap.id = aep.admin_id
      JOIN public.events e ON e.event_id = aep.event_id
      WHERE e.id = v_conv.event_id
        AND ap.user_id = auth.uid()
        AND ap.is_active = true
        AND aep.is_active = true
        AND aep.permission_level IN ('edit', 'manage')
        AND (aep.expires_at IS NULL OR aep.expires_at > now())
    ) THEN
      RETURN true;
    END IF;

    -- Calendar admin: inherit via calendars_events junction
    IF EXISTS (
      SELECT 1 FROM public.admin_calendar_permissions acp
      JOIN public.admin_profiles ap ON ap.id = acp.admin_id
      JOIN public.calendars_events ce ON ce.calendar_id = acp.calendar_id
      WHERE ce.event_id = v_conv.event_id
        AND ap.user_id = auth.uid()
        AND ap.is_active = true
        AND acp.is_active = true
        AND acp.permission_level IN ('edit', 'manage')
        AND (acp.expires_at IS NULL OR acp.expires_at > now())
    ) THEN
      RETURN true;
    END IF;
  END IF;

  RETURN false;
END;
$$;

-- ==========================================================================
-- 7. admin_visible_conversations view — pre-scoped list for the admin UI
-- ==========================================================================
CREATE OR REPLACE VIEW public.admin_visible_conversations AS
SELECT c.*
FROM public.conversations c
WHERE public.can_moderate_conversation(c.id);

-- ==========================================================================
-- 8. RLS policies
-- ==========================================================================
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations_blocked_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations_reports ENABLE ROW LEVEL SECURITY;

-- conversations: SELECT via can_see; INSERT/UPDATE via moderator
DROP POLICY IF EXISTS conversations_select ON public.conversations;
CREATE POLICY conversations_select ON public.conversations
  FOR SELECT USING (public.can_see_conversation(id));

DROP POLICY IF EXISTS conversations_insert ON public.conversations;
CREATE POLICY conversations_insert ON public.conversations
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.auth_person_id() IS NOT NULL);

DROP POLICY IF EXISTS conversations_update ON public.conversations;
CREATE POLICY conversations_update ON public.conversations
  FOR UPDATE USING (public.can_moderate_conversation(id))
  WITH CHECK (public.can_moderate_conversation(id));

DROP POLICY IF EXISTS conversations_delete ON public.conversations;
CREATE POLICY conversations_delete ON public.conversations
  FOR DELETE USING (public.is_super_admin());

-- conversations_messages
DROP POLICY IF EXISTS conversations_messages_select ON public.conversations_messages;
CREATE POLICY conversations_messages_select ON public.conversations_messages
  FOR SELECT USING (
    is_deleted = false
    AND public.can_see_conversation(conversation_id)
  );

DROP POLICY IF EXISTS conversations_messages_insert ON public.conversations_messages;
CREATE POLICY conversations_messages_insert ON public.conversations_messages
  FOR INSERT WITH CHECK (
    person_id = public.auth_person_id()
    AND public.can_post_conversation(conversation_id)
  );

DROP POLICY IF EXISTS conversations_messages_update_author ON public.conversations_messages;
CREATE POLICY conversations_messages_update_author ON public.conversations_messages
  FOR UPDATE USING (
    person_id = public.auth_person_id()
    OR public.can_moderate_conversation(conversation_id)
  );

-- conversations_participants
DROP POLICY IF EXISTS conversations_participants_select ON public.conversations_participants;
CREATE POLICY conversations_participants_select ON public.conversations_participants
  FOR SELECT USING (
    person_id = public.auth_person_id()
    OR public.can_moderate_conversation(conversation_id)
  );

DROP POLICY IF EXISTS conversations_participants_upsert ON public.conversations_participants;
CREATE POLICY conversations_participants_upsert ON public.conversations_participants
  FOR INSERT WITH CHECK (
    person_id = public.auth_person_id()
    OR public.can_moderate_conversation(conversation_id)
  );

DROP POLICY IF EXISTS conversations_participants_update ON public.conversations_participants;
CREATE POLICY conversations_participants_update ON public.conversations_participants
  FOR UPDATE USING (
    person_id = public.auth_person_id()
    OR public.can_moderate_conversation(conversation_id)
  );

-- conversations_reactions
DROP POLICY IF EXISTS conversations_reactions_select ON public.conversations_reactions;
CREATE POLICY conversations_reactions_select ON public.conversations_reactions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.conversations_messages m
      WHERE m.id = message_id AND public.can_see_conversation(m.conversation_id)
    )
  );

DROP POLICY IF EXISTS conversations_reactions_insert ON public.conversations_reactions;
CREATE POLICY conversations_reactions_insert ON public.conversations_reactions
  FOR INSERT WITH CHECK (
    person_id = public.auth_person_id()
    AND EXISTS (
      SELECT 1 FROM public.conversations_messages m
      WHERE m.id = message_id AND public.can_post_conversation(m.conversation_id)
    )
  );

DROP POLICY IF EXISTS conversations_reactions_delete ON public.conversations_reactions;
CREATE POLICY conversations_reactions_delete ON public.conversations_reactions
  FOR DELETE USING (person_id = public.auth_person_id());

-- conversations_blocked_users — moderator-only visibility
DROP POLICY IF EXISTS conversations_blocked_select ON public.conversations_blocked_users;
CREATE POLICY conversations_blocked_select ON public.conversations_blocked_users
  FOR SELECT USING (
    public.is_super_admin()
    OR (conversation_id IS NOT NULL AND public.can_moderate_conversation(conversation_id))
  );

DROP POLICY IF EXISTS conversations_blocked_insert ON public.conversations_blocked_users;
CREATE POLICY conversations_blocked_insert ON public.conversations_blocked_users
  FOR INSERT WITH CHECK (
    public.is_super_admin()
    OR (conversation_id IS NOT NULL AND public.can_moderate_conversation(conversation_id))
  );

DROP POLICY IF EXISTS conversations_blocked_delete ON public.conversations_blocked_users;
CREATE POLICY conversations_blocked_delete ON public.conversations_blocked_users
  FOR DELETE USING (
    public.is_super_admin()
    OR (conversation_id IS NOT NULL AND public.can_moderate_conversation(conversation_id))
  );

-- conversations_notifications — own row only
DROP POLICY IF EXISTS conversations_notifications_self ON public.conversations_notifications;
CREATE POLICY conversations_notifications_self ON public.conversations_notifications
  FOR SELECT USING (recipient_id = public.auth_person_id());

DROP POLICY IF EXISTS conversations_notifications_self_update ON public.conversations_notifications;
CREATE POLICY conversations_notifications_self_update ON public.conversations_notifications
  FOR UPDATE USING (recipient_id = public.auth_person_id());

-- push_tokens — own row only
DROP POLICY IF EXISTS push_tokens_self ON public.push_tokens;
CREATE POLICY push_tokens_self ON public.push_tokens
  FOR ALL USING (person_id = public.auth_person_id())
  WITH CHECK (person_id = public.auth_person_id());

-- conversations_reports — viewer reports their own; moderators see all on
-- conversations they can moderate; super-admins see all
DROP POLICY IF EXISTS conversations_reports_select ON public.conversations_reports;
CREATE POLICY conversations_reports_select ON public.conversations_reports
  FOR SELECT USING (
    reported_by = public.auth_person_id()
    OR public.is_super_admin()
    OR public.can_moderate_conversation(conversation_id)
  );

DROP POLICY IF EXISTS conversations_reports_insert ON public.conversations_reports;
CREATE POLICY conversations_reports_insert ON public.conversations_reports
  FOR INSERT WITH CHECK (reported_by = public.auth_person_id());

DROP POLICY IF EXISTS conversations_reports_update ON public.conversations_reports;
CREATE POLICY conversations_reports_update ON public.conversations_reports
  FOR UPDATE USING (
    public.is_super_admin()
    OR public.can_moderate_conversation(conversation_id)
  );
