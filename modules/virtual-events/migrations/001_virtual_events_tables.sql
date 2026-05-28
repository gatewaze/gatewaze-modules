-- ============================================================================
-- Module: virtual-events
-- Migration: 001_virtual_events_tables
-- Description: Creates tables for virtual event streaming and real-time chat.
--              Includes: live_event_config, live_event_tracks,
--              live_chat_messages, live_chat_reactions, live_chat_pinned_messages,
--              live_chat_blocked_users. Plus triggers for input sanitization,
--              question detection, and reaction count denormalization.
-- ============================================================================

-- ==========================================================================
-- 1. live_event_config — per-event virtual event configuration
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.live_event_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE UNIQUE,
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  event_status text DEFAULT 'upcoming'
    CHECK (event_status IN ('upcoming', 'live', 'ended')),
  chat_enabled boolean DEFAULT true,
  chat_slowmode_seconds integer DEFAULT 0
    CHECK (chat_slowmode_seconds >= 0 AND chat_slowmode_seconds <= 300),
  reactions_enabled boolean DEFAULT true,
  questions_enabled boolean DEFAULT true,
  show_replay_after_end boolean DEFAULT true,
  filter_linkedin_urls boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_live_event_config_event ON live_event_config(event_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'live_event_config_updated_at') THEN
    CREATE TRIGGER live_event_config_updated_at
      BEFORE UPDATE ON public.live_event_config
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ==========================================================================
-- 2. live_event_tracks — per-event tracks/stages with YouTube streams
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.live_event_tracks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  youtube_video_id text,
  stream_status text DEFAULT 'upcoming'
    CHECK (stream_status IN ('upcoming', 'live', 'ended', 'replay')),
  is_default boolean DEFAULT false,
  sort_order integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_live_event_tracks_event ON live_event_tracks(event_id, sort_order);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'live_event_tracks_updated_at') THEN
    CREATE TRIGGER live_event_tracks_updated_at
      BEFORE UPDATE ON public.live_event_tracks
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ==========================================================================
-- 3. live_chat_messages — per-track chat messages
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.live_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  track_id uuid NOT NULL REFERENCES public.live_event_tracks(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES public.people(id),
  content text NOT NULL CHECK (char_length(content) > 0 AND char_length(content) <= 1000),
  is_question boolean DEFAULT false,
  is_team_message boolean DEFAULT false,
  is_surfaced boolean DEFAULT false,
  is_deleted boolean DEFAULT false,
  deleted_by uuid REFERENCES public.people(id),
  reply_to_id uuid REFERENCES public.live_chat_messages(id) ON DELETE SET NULL,
  moderation_flags jsonb DEFAULT '{}'::jsonb,
  reaction_counts jsonb DEFAULT '{}'::jsonb,
  is_edited boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_live_chat_messages_track ON live_chat_messages(track_id, created_at);
CREATE INDEX IF NOT EXISTS idx_live_chat_messages_event ON live_chat_messages(event_id, created_at);
CREATE INDEX IF NOT EXISTS idx_live_chat_messages_questions ON live_chat_messages(track_id, is_question, created_at)
  WHERE is_question = true;
CREATE INDEX IF NOT EXISTS idx_live_chat_messages_surfaced ON live_chat_messages(track_id, is_surfaced)
  WHERE is_surfaced = true;
CREATE INDEX IF NOT EXISTS idx_live_chat_messages_person_event_created
  ON live_chat_messages(event_id, person_id, created_at DESC);

-- ==========================================================================
-- 3.1 Input sanitization + question detection trigger
-- ==========================================================================
CREATE OR REPLACE FUNCTION live_chat_sanitize_and_classify() RETURNS trigger AS $$
BEGIN
  -- Strip HTML tags
  NEW.content := regexp_replace(NEW.content, '<[^>]+>', '', 'g');
  -- Trim whitespace
  NEW.content := trim(NEW.content);
  -- Detect questions (message ends with ?)
  IF NEW.content LIKE '%?' THEN
    NEW.is_question := true;
  END IF;
  -- Auto-moderate: LinkedIn profile URLs (if enabled in config)
  IF NEW.content ~* 'linkedin\.com/(in|pub|profile)/' THEN
    DECLARE linkedin_filter boolean;
    BEGIN
      SELECT filter_linkedin_urls INTO linkedin_filter
      FROM live_event_config WHERE event_id = NEW.event_id;

      IF linkedin_filter IS TRUE THEN
        NEW.is_deleted := true;
        NEW.moderation_flags := jsonb_set(
          COALESCE(NEW.moderation_flags, '{}'::jsonb),
          '{auto_moderated}',
          '"linkedin_url"'
        );
      END IF;
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS live_chat_sanitize_trigger ON public.live_chat_messages;
CREATE TRIGGER live_chat_sanitize_trigger
  BEFORE INSERT ON public.live_chat_messages
  FOR EACH ROW EXECUTE FUNCTION live_chat_sanitize_and_classify();

-- ==========================================================================
-- 4. live_chat_reactions — per-user reaction tracking
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.live_chat_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.live_chat_messages(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES public.people(id),
  reaction_type text NOT NULL
    CHECK (reaction_type IN ('thumbsup', 'heart', 'laughing', 'clapping', 'thinking', 'fire')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, person_id, reaction_type)
);

CREATE INDEX IF NOT EXISTS idx_live_chat_reactions_message ON live_chat_reactions(message_id);

-- ==========================================================================
-- 4.1 Reaction count denormalization trigger
-- ==========================================================================
CREATE OR REPLACE FUNCTION live_chat_update_reaction_counts() RETURNS trigger AS $$
BEGIN
  UPDATE live_chat_messages
  SET reaction_counts = (
    SELECT COALESCE(jsonb_object_agg(reaction_type, cnt), '{}'::jsonb)
    FROM (
      SELECT reaction_type, COUNT(*) as cnt
      FROM live_chat_reactions
      WHERE message_id = COALESCE(NEW.message_id, OLD.message_id)
      GROUP BY reaction_type
    ) sub
  )
  WHERE id = COALESCE(NEW.message_id, OLD.message_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS live_chat_reaction_count_trigger ON public.live_chat_reactions;
CREATE TRIGGER live_chat_reaction_count_trigger
  AFTER INSERT OR DELETE ON public.live_chat_reactions
  FOR EACH ROW EXECUTE FUNCTION live_chat_update_reaction_counts();

-- ==========================================================================
-- 5. live_chat_pinned_messages
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.live_chat_pinned_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES public.live_chat_messages(id) ON DELETE CASCADE,
  pinned_by uuid NOT NULL REFERENCES public.people(id),
  pinned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, message_id)
);

-- ==========================================================================
-- 6. live_chat_blocked_users
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.live_chat_blocked_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES public.people(id),
  blocked_by uuid NOT NULL REFERENCES public.people(id),
  reason text,
  is_permanent boolean DEFAULT false,
  blocked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (event_id, person_id)
);

CREATE INDEX IF NOT EXISTS idx_live_chat_blocked_users_event ON live_chat_blocked_users(event_id, person_id);

-- ==========================================================================
-- 7. RLS Policies
-- ==========================================================================

-- Helper functions
CREATE OR REPLACE FUNCTION is_event_attendee(p_event_id uuid) RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM events_registrations
    WHERE event_id = p_event_id
    AND person_id = (SELECT id FROM people WHERE auth_user_id = auth.uid() LIMIT 1)
    AND status IN ('confirmed', 'attended')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION is_admin_user() RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM admin_profiles
    WHERE user_id = auth.uid()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION check_chat_slowmode(p_event_id uuid) RETURNS boolean AS $$
DECLARE
  slowmode_secs integer;
  last_msg_at timestamptz;
  p_person_id uuid;
BEGIN
  SELECT id INTO p_person_id FROM people WHERE auth_user_id = auth.uid() LIMIT 1;
  IF p_person_id IS NULL THEN RETURN false; END IF;

  SELECT chat_slowmode_seconds INTO slowmode_secs
  FROM live_event_config WHERE event_id = p_event_id;

  IF slowmode_secs IS NULL OR slowmode_secs = 0 THEN RETURN true; END IF;

  SELECT MAX(created_at) INTO last_msg_at
  FROM live_chat_messages
  WHERE event_id = p_event_id AND person_id = p_person_id;

  IF last_msg_at IS NULL THEN RETURN true; END IF;

  RETURN (now() - last_msg_at) >= make_interval(secs => slowmode_secs);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Enable RLS on all tables
ALTER TABLE public.live_event_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_event_tracks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_chat_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_chat_pinned_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_chat_blocked_users ENABLE ROW LEVEL SECURITY;

-- Config: read — anyone (config is not sensitive; UI gates access); write — admins only
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_event_config' AND policyname = 'read_config') THEN
    CREATE POLICY "read_config" ON live_event_config FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_event_config' AND policyname = 'anon_read_config') THEN
    CREATE POLICY "anon_read_config" ON live_event_config FOR SELECT TO anon USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_event_config' AND policyname = 'admin_manage_config') THEN
    CREATE POLICY "admin_manage_config" ON live_event_config FOR ALL TO authenticated
      USING (is_admin_user()) WITH CHECK (is_admin_user());
  END IF;
END $$;

-- Tracks: read — anyone; write — admins only
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_event_tracks' AND policyname = 'read_tracks') THEN
    CREATE POLICY "read_tracks" ON live_event_tracks FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_event_tracks' AND policyname = 'anon_read_tracks') THEN
    CREATE POLICY "anon_read_tracks" ON live_event_tracks FOR SELECT TO anon USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_event_tracks' AND policyname = 'admin_manage_tracks') THEN
    CREATE POLICY "admin_manage_tracks" ON live_event_tracks FOR ALL TO authenticated
      USING (is_admin_user()) WITH CHECK (is_admin_user());
  END IF;
END $$;

-- Messages: read non-deleted — anyone (UI gates auth); write requires attendee check
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_chat_messages' AND policyname = 'read_messages') THEN
    CREATE POLICY "read_messages" ON live_chat_messages FOR SELECT TO authenticated
      USING (is_deleted = false);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_chat_messages' AND policyname = 'anon_read_messages') THEN
    CREATE POLICY "anon_read_messages" ON live_chat_messages FOR SELECT TO anon
      USING (is_deleted = false);
  END IF;

  -- Insert — not blocked, chat enabled, slowmode OK
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_chat_messages' AND policyname = 'insert_messages') THEN
    CREATE POLICY "insert_messages" ON live_chat_messages FOR INSERT TO authenticated
      WITH CHECK (
        person_id = (SELECT id FROM people WHERE auth_user_id = auth.uid() LIMIT 1)
        AND (is_event_attendee(event_id) OR is_admin_user())
        AND NOT EXISTS (
          SELECT 1 FROM live_chat_blocked_users
          WHERE event_id = live_chat_messages.event_id
          AND person_id = live_chat_messages.person_id
          AND (expires_at IS NULL OR expires_at > now())
        )
        AND EXISTS (
          SELECT 1 FROM live_event_config
          WHERE event_id = live_chat_messages.event_id
          AND chat_enabled = true
        )
        AND check_chat_slowmode(live_chat_messages.event_id)
      );
  END IF;

  -- Update — admins only (soft delete, surfacing)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_chat_messages' AND policyname = 'admin_update_messages') THEN
    CREATE POLICY "admin_update_messages" ON live_chat_messages FOR UPDATE TO authenticated
      USING (is_admin_user());
  END IF;

  -- Admin can see all messages including deleted (needed for UPDATE to pass RLS check on new row)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_chat_messages' AND policyname = 'admin_read_all_messages') THEN
    CREATE POLICY "admin_read_all_messages" ON live_chat_messages FOR SELECT TO authenticated
      USING (is_admin_user());
  END IF;
END $$;

-- Reactions
DO $$
DECLARE
  p_person_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_chat_reactions' AND policyname = 'read_reactions') THEN
    CREATE POLICY "read_reactions" ON live_chat_reactions FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_chat_reactions' AND policyname = 'anon_read_reactions') THEN
    CREATE POLICY "anon_read_reactions" ON live_chat_reactions FOR SELECT TO anon USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_chat_reactions' AND policyname = 'insert_reactions') THEN
    CREATE POLICY "insert_reactions" ON live_chat_reactions FOR INSERT TO authenticated
      WITH CHECK (person_id = (SELECT id FROM people WHERE auth_user_id = auth.uid() LIMIT 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_chat_reactions' AND policyname = 'delete_reactions') THEN
    CREATE POLICY "delete_reactions" ON live_chat_reactions FOR DELETE TO authenticated
      USING (person_id = (SELECT id FROM people WHERE auth_user_id = auth.uid() LIMIT 1));
  END IF;
END $$;

-- Pinned: read — attendees; manage — admins
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_chat_pinned_messages' AND policyname = 'read_pinned') THEN
    CREATE POLICY "read_pinned" ON live_chat_pinned_messages FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_chat_pinned_messages' AND policyname = 'anon_read_pinned') THEN
    CREATE POLICY "anon_read_pinned" ON live_chat_pinned_messages FOR SELECT TO anon USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_chat_pinned_messages' AND policyname = 'admin_manage_pinned') THEN
    CREATE POLICY "admin_manage_pinned" ON live_chat_pinned_messages FOR ALL TO authenticated
      USING (is_admin_user()) WITH CHECK (is_admin_user());
  END IF;
END $$;

-- Blocked: admins only
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_chat_blocked_users' AND policyname = 'admin_manage_blocked') THEN
    CREATE POLICY "admin_manage_blocked" ON live_chat_blocked_users FOR ALL TO authenticated
      USING (is_admin_user()) WITH CHECK (is_admin_user());
  END IF;
END $$;

-- ==========================================================================
-- 8. Supabase Realtime — enable for chat messages
-- ==========================================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.live_chat_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.live_chat_blocked_users;

-- ==========================================================================
-- 9. live_event_viewer_log — tracks viewer join/leave for analytics
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.live_event_viewer_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES public.people(id),
  action text NOT NULL CHECK (action IN ('join', 'leave')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_live_event_viewer_log_event ON live_event_viewer_log(event_id, created_at);

ALTER TABLE public.live_event_viewer_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_event_viewer_log' AND policyname = 'authenticated_read_viewer_log') THEN
    CREATE POLICY "authenticated_read_viewer_log" ON live_event_viewer_log FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_event_viewer_log' AND policyname = 'authenticated_insert_viewer_log') THEN
    CREATE POLICY "authenticated_insert_viewer_log" ON live_event_viewer_log FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'live_event_viewer_log' AND policyname = 'anon_insert_viewer_log') THEN
    CREATE POLICY "anon_insert_viewer_log" ON live_event_viewer_log FOR INSERT TO anon WITH CHECK (true);
  END IF;
END $$;
