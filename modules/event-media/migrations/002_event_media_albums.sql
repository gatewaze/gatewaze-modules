-- ============================================================================
-- Module: event-media
-- Migration: 002_event_media_albums
-- Description: Album management tables for organizing event media into albums.
-- ============================================================================

-- ==========================================================================
-- 1. events_media_albums
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.events_media_albums (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  cover_media_id  uuid REFERENCES public.events_media(id) ON DELETE SET NULL,
  sort_order      integer DEFAULT 0,
  is_default      boolean DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_media_albums_event ON public.events_media_albums (event_id);

-- ==========================================================================
-- 2. event_media_album_items (junction table)
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.event_media_album_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  album_id    uuid NOT NULL REFERENCES public.events_media_albums(id) ON DELETE CASCADE,
  media_id    uuid NOT NULL REFERENCES public.events_media(id) ON DELETE CASCADE,
  sort_order  integer DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(album_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_event_media_album_items_album ON public.event_media_album_items (album_id);
CREATE INDEX IF NOT EXISTS idx_event_media_album_items_media ON public.event_media_album_items (media_id);

-- ==========================================================================
-- 3. RLS Policies
-- ==========================================================================

ALTER TABLE public.events_media_albums ENABLE ROW LEVEL SECURITY;

CREATE POLICY "event_media_albums_select"
  ON public.events_media_albums FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "event_media_albums_insert"
  ON public.events_media_albums FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_event(event_id));

CREATE POLICY "event_media_albums_update"
  ON public.events_media_albums FOR UPDATE TO authenticated
  USING (public.can_admin_event(event_id));

CREATE POLICY "event_media_albums_delete"
  ON public.events_media_albums FOR DELETE TO authenticated
  USING (public.can_admin_event(event_id));

ALTER TABLE public.event_media_album_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "event_media_album_items_select"
  ON public.event_media_album_items FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "event_media_album_items_insert"
  ON public.event_media_album_items FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.events_media_albums a
      WHERE a.id = album_id AND public.can_admin_event(a.event_id)
    )
  );

CREATE POLICY "event_media_album_items_update"
  ON public.event_media_album_items FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.events_media_albums a
      WHERE a.id = album_id AND public.can_admin_event(a.event_id)
    )
  );

CREATE POLICY "event_media_album_items_delete"
  ON public.event_media_album_items FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.events_media_albums a
      WHERE a.id = album_id AND public.can_admin_event(a.event_id)
    )
  );

-- ==========================================================================
-- 4. Updated_at trigger
-- ==========================================================================

CREATE OR REPLACE TRIGGER set_events_media_albums_updated_at
  BEFORE UPDATE ON public.events_media_albums
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ==========================================================================
-- 5. events_media_zip_uploads (tracks zip file processing)
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.events_media_zip_uploads (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                  uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  file_name                 text NOT NULL,
  storage_path              text NOT NULL,
  file_size                 bigint,
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  total_count               integer DEFAULT 0,
  processed_count           integer DEFAULT 0,
  error_message             text,
  processing_started_at     timestamptz,
  processing_completed_at   timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_media_zip_uploads_event ON public.events_media_zip_uploads (event_id);

ALTER TABLE public.events_media_zip_uploads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "event_media_zip_uploads_select"
  ON public.events_media_zip_uploads FOR SELECT TO authenticated
  USING (public.can_admin_event(event_id));

CREATE POLICY "event_media_zip_uploads_insert"
  ON public.events_media_zip_uploads FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_event(event_id));

CREATE POLICY "event_media_zip_uploads_update"
  ON public.events_media_zip_uploads FOR UPDATE TO authenticated
  USING (public.can_admin_event(event_id));

CREATE POLICY "event_media_zip_uploads_delete"
  ON public.events_media_zip_uploads FOR DELETE TO authenticated
  USING (public.can_admin_event(event_id));

CREATE OR REPLACE TRIGGER set_events_media_zip_uploads_updated_at
  BEFORE UPDATE ON public.events_media_zip_uploads
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
