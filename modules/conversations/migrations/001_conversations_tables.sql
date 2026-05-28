-- ============================================================================
-- Module: conversations
-- Migration: 001_conversations_tables
-- Description: Core tables for the unified conversations module — DMs,
--              channels (calendar/event/group/admin), messages, participants,
--              reactions, blocked users, notifications, push tokens, reports.
--              Per spec-conversations-module.md §4.
-- ============================================================================

-- ==========================================================================
-- 1. conversations — central entity
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('dm','calendar_channel','event_channel','group_channel','admin_channel')),
  title           text,
  description     text,
  topic           text,
  calendar_id     uuid,                                    -- soft ref to calendars(id) if calendars module installed
  event_id        uuid REFERENCES public.events(id) ON DELETE CASCADE,
  created_by      uuid,                                    -- people(id), no FK to keep this self-contained
  is_default      boolean NOT NULL DEFAULT false,
  is_archived     boolean NOT NULL DEFAULT false,
  slowmode_seconds integer NOT NULL DEFAULT 0
    CHECK (slowmode_seconds >= 0 AND slowmode_seconds <= 3600),
  require_username boolean NOT NULL DEFAULT true,
  visibility      text NOT NULL DEFAULT 'members'
    CHECK (visibility IN ('members','registered','private','public')),
  metadata        jsonb DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz,
  CONSTRAINT conversations_scope_check CHECK (
    (kind = 'dm' AND calendar_id IS NULL AND event_id IS NULL)
    OR (kind = 'calendar_channel' AND calendar_id IS NOT NULL AND event_id IS NULL)
    OR (kind = 'event_channel' AND event_id IS NOT NULL)
    OR (kind = 'group_channel' AND calendar_id IS NOT NULL AND event_id IS NULL)
    OR (kind = 'admin_channel' AND calendar_id IS NULL AND event_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_conversations_calendar
  ON public.conversations (calendar_id) WHERE calendar_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_event
  ON public.conversations (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_last_message
  ON public.conversations (last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_conversations_kind_archive
  ON public.conversations (kind, is_archived);

-- One default per scope
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_default_calendar
  ON public.conversations (calendar_id)
  WHERE kind = 'calendar_channel' AND is_default = true;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_default_event
  ON public.conversations (event_id)
  WHERE kind = 'event_channel' AND is_default = true;

DROP TRIGGER IF EXISTS conversations_updated_at ON public.conversations;
CREATE TRIGGER conversations_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 2. conversations_participants — explicit membership rows
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.conversations_participants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  person_id         uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  role              text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','moderator','member','guest')),
  joined_at         timestamptz NOT NULL DEFAULT now(),
  last_read_at      timestamptz,
  notification_level text NOT NULL DEFAULT 'mentions' CHECK (notification_level IN ('all','mentions','none')),
  is_muted          boolean NOT NULL DEFAULT false,
  muted_until       timestamptz,
  is_left           boolean NOT NULL DEFAULT false,
  left_at           timestamptz,
  metadata          jsonb DEFAULT '{}'::jsonb,
  UNIQUE (conversation_id, person_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_participants_person
  ON public.conversations_participants (person_id) WHERE is_left = false;
CREATE INDEX IF NOT EXISTS idx_conversations_participants_conv
  ON public.conversations_participants (conversation_id) WHERE is_left = false;

-- ==========================================================================
-- 3. conversations_messages
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.conversations_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  person_id         uuid NOT NULL REFERENCES public.people(id),
  content           text NOT NULL CHECK (char_length(content) > 0 AND char_length(content) <= 4000),
  is_question       boolean DEFAULT false,
  is_team_message   boolean DEFAULT false,
  is_pinned         boolean DEFAULT false,
  is_deleted        boolean DEFAULT false,
  is_edited         boolean DEFAULT false,
  deleted_by        uuid REFERENCES public.people(id),
  reply_to_id       uuid REFERENCES public.conversations_messages(id) ON DELETE SET NULL,
  mentions          uuid[],
  reaction_counts   jsonb DEFAULT '{}'::jsonb,
  moderation_flags  jsonb DEFAULT '{}'::jsonb,
  url_previews      jsonb DEFAULT '[]'::jsonb,
  client_id         uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  edited_at         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_conversations_messages_conv_created
  ON public.conversations_messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_messages_person
  ON public.conversations_messages (person_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_messages_pinned
  ON public.conversations_messages (conversation_id, is_pinned)
  WHERE is_pinned = true;
CREATE INDEX IF NOT EXISTS idx_conversations_messages_mentions
  ON public.conversations_messages USING gin (mentions);

-- Trigger: when a message is inserted, bump conversations.last_message_at
CREATE OR REPLACE FUNCTION public.bump_conversation_last_message()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.conversations
  SET last_message_at = NEW.created_at
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_messages_bump_last ON public.conversations_messages;
CREATE TRIGGER conversations_messages_bump_last
  AFTER INSERT ON public.conversations_messages
  FOR EACH ROW EXECUTE FUNCTION public.bump_conversation_last_message();

-- ==========================================================================
-- 4. conversations_reactions
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.conversations_reactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      uuid NOT NULL REFERENCES public.conversations_messages(id) ON DELETE CASCADE,
  person_id       uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  emoji           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, person_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_conversations_reactions_message
  ON public.conversations_reactions (message_id);

-- Trigger: maintain reaction_counts on the message row
CREATE OR REPLACE FUNCTION public.update_message_reaction_counts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_message_id uuid;
  v_counts jsonb;
BEGIN
  v_message_id := COALESCE(NEW.message_id, OLD.message_id);
  SELECT COALESCE(jsonb_object_agg(emoji, c), '{}'::jsonb)
  INTO v_counts
  FROM (
    SELECT emoji, count(*) AS c
    FROM public.conversations_reactions
    WHERE message_id = v_message_id
    GROUP BY emoji
  ) sub;
  UPDATE public.conversations_messages
  SET reaction_counts = v_counts
  WHERE id = v_message_id;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS conversations_reactions_count_after ON public.conversations_reactions;
CREATE TRIGGER conversations_reactions_count_after
  AFTER INSERT OR DELETE ON public.conversations_reactions
  FOR EACH ROW EXECUTE FUNCTION public.update_message_reaction_counts();

-- ==========================================================================
-- 5. conversations_blocked_users
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.conversations_blocked_users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE,  -- NULL = brand-wide
  person_id       uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  blocked_by      uuid NOT NULL REFERENCES public.people(id),
  reason          text,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, person_id)
);

-- Partial index predicate must use IMMUTABLE functions only, so we index
-- on all rows with no expires_at (permanent blocks) and let queries filter
-- the time-based case. A full index on person_id is the fallback.
CREATE INDEX IF NOT EXISTS idx_conversations_blocked_active
  ON public.conversations_blocked_users (person_id)
  WHERE expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_blocked_expiring
  ON public.conversations_blocked_users (person_id, expires_at)
  WHERE expires_at IS NOT NULL;

-- ==========================================================================
-- 6. conversations_notifications — outbox for in-app + push
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.conversations_notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id    uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  message_id      uuid NOT NULL REFERENCES public.conversations_messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  reason          text NOT NULL CHECK (reason IN ('dm','mention','channel-all','reply')),
  delivered_at    timestamptz,
  read_at         timestamptz,
  channel         text NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app','push','email')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_notifications_unread
  ON public.conversations_notifications (recipient_id, read_at)
  WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_notifications_recipient
  ON public.conversations_notifications (recipient_id, created_at DESC);

-- ==========================================================================
-- 7. push_tokens — device registrations for the future mobile app
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.push_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  token           text NOT NULL,
  platform        text NOT NULL CHECK (platform IN ('ios','android','web')),
  device_id       text,
  app_version     text,
  is_active       boolean NOT NULL DEFAULT true,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token)
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_person
  ON public.push_tokens (person_id) WHERE is_active = true;

-- ==========================================================================
-- 8. conversations_reports — moderator review queue (stub in v1)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.conversations_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      uuid NOT NULL REFERENCES public.conversations_messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  reported_by     uuid NOT NULL REFERENCES public.people(id),
  reason          text NOT NULL CHECK (reason IN ('spam','harassment','off_topic','illegal','other')),
  notes           text,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','reviewed','dismissed','actioned')),
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  action_taken    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_reports_pending
  ON public.conversations_reports (status, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_conversations_reports_message
  ON public.conversations_reports (message_id);
