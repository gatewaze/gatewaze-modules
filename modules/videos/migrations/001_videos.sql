-- ============================================================================
-- Module: videos
-- Migration: 001_videos
-- Description: Canonical video object. One row per (YouTube-hosted) video,
--              referenced by resources blocks, events, and podcasts, and
--              registered with the content platform (002). See
--              gatewaze-environments/specs/spec-videos-module.md.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.videos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           text NOT NULL DEFAULT 'youtube' CHECK (provider IN ('youtube')),
  provider_video_id  text NOT NULL,
  url                text NOT NULL,
  title              text NOT NULL,
  description        text,
  thumbnail_url      text,
  duration_seconds   integer,
  published_at       timestamptz,
  channel_id         text,
  channel_title      text,
  content_category   varchar(100),
  topics             text[] NOT NULL DEFAULT '{}',
  speakers           jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- status = portal display filter (public reads gate on 'published').
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','published','archived','pending_review','rejected')),
  -- publish_state = content-platform state machine column (register_content_type).
  publish_state      text NOT NULL DEFAULT 'published'
                     CHECK (publish_state IN ('draft','pending_review','auto_suppressed','rejected','published','unpublished')),
  rejection_reason   text,
  is_external        boolean NOT NULL DEFAULT true,
  visibility         text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  source             text,
  raw                jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT videos_provider_video_id_unique UNIQUE (provider, provider_video_id)
);

COMMENT ON TABLE public.videos IS 'Canonical video object (YouTube-hosted); referenced by resources/events/podcasts, embedded for related-content.';

CREATE INDEX IF NOT EXISTS idx_videos_channel        ON public.videos (channel_id);
CREATE INDEX IF NOT EXISTS idx_videos_published_at   ON public.videos (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_content_cat    ON public.videos (content_category);
CREATE INDEX IF NOT EXISTS idx_videos_status         ON public.videos (status);
CREATE INDEX IF NOT EXISTS idx_videos_topics_gin     ON public.videos USING gin (topics);

CREATE TRIGGER videos_updated_at
  BEFORE UPDATE ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Sync the portal-facing `status` from the content-platform `publish_state`
-- machine (so a triage/keyword verdict that flips publish_state is reflected in
-- what the portal shows). Fires only when publish_state actually changes, so a
-- scraper/admin write that sets status directly is not clobbered.
CREATE OR REPLACE FUNCTION public.videos_sync_status_from_publish_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.publish_state IS DISTINCT FROM OLD.publish_state THEN
    NEW.status := CASE NEW.publish_state
      WHEN 'published'       THEN 'published'
      WHEN 'pending_review'  THEN 'pending_review'
      WHEN 'auto_suppressed' THEN 'pending_review'
      WHEN 'rejected'        THEN 'rejected'
      WHEN 'unpublished'     THEN 'archived'
      WHEN 'draft'           THEN 'draft'
      ELSE NEW.status
    END;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS videos_sync_status ON public.videos;
CREATE TRIGGER videos_sync_status
  BEFORE UPDATE OF publish_state ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.videos_sync_status_from_publish_state();

-- event ↔ video link (used by the events integration; created here so the FK
-- target exists once). Guarded FK to events (present on any full install).
CREATE TABLE IF NOT EXISTS public.event_videos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_uuid  uuid NOT NULL,
  video_id    uuid NOT NULL REFERENCES public.videos (id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'session'
              CHECK (role IN ('recording','recap','trailer','session','other')),
  playlist_id text,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_videos_pair_unique UNIQUE (event_uuid, video_id)
);

CREATE INDEX IF NOT EXISTS idx_event_videos_event ON public.event_videos (event_uuid);
CREATE INDEX IF NOT EXISTS idx_event_videos_video ON public.event_videos (video_id);

DO $$
BEGIN
  IF to_regclass('public.events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_videos_event_uuid_fkey') THEN
    ALTER TABLE public.event_videos
      ADD CONSTRAINT event_videos_event_uuid_fkey
      FOREIGN KEY (event_uuid) REFERENCES public.events (id) ON DELETE CASCADE;
  END IF;
END $$;

-- Ownership (module writer), consistent with other module tables. Grant the
-- role to the calling user first so ALTER ... OWNER doesn't trip 42501 on
-- Supabase Cloud (where postgres isn't a true superuser).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN BYPASSRLS;
  END IF;
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);
  EXECUTE 'ALTER TABLE public.videos OWNER TO gatewaze_module_writer';
  EXECUTE 'ALTER TABLE public.event_videos OWNER TO gatewaze_module_writer';
  EXECUTE 'ALTER FUNCTION public.videos_sync_status_from_publish_state() OWNER TO gatewaze_module_writer';
END $$;
