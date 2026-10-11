-- Which albums guests see.
--
-- The album view at /photos shows every album the event has. Some are
-- not for guests: "Photo booth elsewhere" is pictures people made at
-- home afterwards, which belong in the Media tab and not on the wedding's
-- own page (asked 2026-09-27).
--
-- A row per album, kept here rather than as a column on
-- host_media_albums: that table belongs to host-media and is shared with
-- every other consumer, and this is event-media's own idea. An album
-- with no row is shown, so nothing changes for an event that never sets
-- one.

CREATE TABLE IF NOT EXISTS public.event_media_album_settings (
  album_id       uuid PRIMARY KEY REFERENCES public.host_media_albums(id) ON DELETE CASCADE,
  event_id       uuid NOT NULL,
  show_on_portal boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.event_media_album_settings IS
  'Per-album event-media settings. Absent row = shown on the portal.';

CREATE INDEX IF NOT EXISTS idx_event_media_album_settings_event
  ON public.event_media_album_settings (event_id);

ALTER TABLE public.event_media_album_settings ENABLE ROW LEVEL SECURITY;

-- Written from the Media tab by an organiser of that event, and read
-- back there. The public gallery reads it with the service role, so anon
-- needs nothing.
DROP POLICY IF EXISTS album_settings_read ON public.event_media_album_settings;
CREATE POLICY album_settings_read ON public.event_media_album_settings
  FOR SELECT TO authenticated
  USING (public.can_admin_host_media('event', event_id));

DROP POLICY IF EXISTS album_settings_write ON public.event_media_album_settings;
CREATE POLICY album_settings_write ON public.event_media_album_settings
  FOR INSERT TO authenticated
  WITH CHECK (public.can_admin_host_media('event', event_id));

DROP POLICY IF EXISTS album_settings_update ON public.event_media_album_settings;
CREATE POLICY album_settings_update ON public.event_media_album_settings
  FOR UPDATE TO authenticated
  USING (public.can_admin_host_media('event', event_id))
  WITH CHECK (public.can_admin_host_media('event', event_id));

DROP POLICY IF EXISTS album_settings_delete ON public.event_media_album_settings;
CREATE POLICY album_settings_delete ON public.event_media_album_settings
  FOR DELETE TO authenticated
  USING (public.can_admin_host_media('event', event_id));

REVOKE ALL ON public.event_media_album_settings FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_media_album_settings TO authenticated;
GRANT ALL ON public.event_media_album_settings TO service_role;
