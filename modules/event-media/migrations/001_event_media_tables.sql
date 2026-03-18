-- ============================================================================
-- Module: event-media
-- Migration: 001_event_media_tables
-- Description: Event media (photos/videos) with optional sponsor tagging.
-- ============================================================================

-- ==========================================================================
-- 1. events_media
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.events_media (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  url           text NOT NULL,
  type          text NOT NULL CHECK (type IN ('image', 'video')),
  caption       text,
  album         text,
  sort_order    integer DEFAULT 0,
  sponsor_id    uuid,
  uploaded_by   uuid,
  file_name     text,
  storage_path  text,
  file_size     bigint,
  mime_type     text,
  width         integer,
  height        integer,
  is_featured   boolean DEFAULT false,
  display_order integer DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_media_event ON public.events_media (event_id);

-- Conditional FK: sponsor_id → events_sponsor_profiles (if sponsors module installed)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'events_sponsor_profiles') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'events_media_sponsor_id_fkey') THEN
      ALTER TABLE public.events_media
        ADD CONSTRAINT events_media_sponsor_id_fkey
        FOREIGN KEY (sponsor_id) REFERENCES public.events_sponsor_profiles(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

-- ==========================================================================
-- 2. RLS Policies
-- ==========================================================================

ALTER TABLE public.events_media ENABLE ROW LEVEL SECURITY;

CREATE POLICY "event_media_select"
  ON public.events_media FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "event_media_insert"
  ON public.events_media FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_event(event_id));

CREATE POLICY "event_media_update"
  ON public.events_media FOR UPDATE TO authenticated
  USING (public.can_admin_event(event_id));

CREATE POLICY "event_media_delete"
  ON public.events_media FOR DELETE TO authenticated
  USING (public.can_admin_event(event_id));
