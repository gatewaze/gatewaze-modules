-- Which photo-booth eras an event offers.
--
-- 'all' (the default) shows guests an era picker; naming one era -- an
-- 80s party, say -- skips the picker and opens that era's booth
-- directly. The eras themselves are defined in code (lib/booth-eras.ts);
-- this only records the choice.

CREATE TABLE IF NOT EXISTS public.events_media_booth_settings (
  event_id   uuid PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
  era        text NOT NULL DEFAULT 'all' CHECK (era ~ '^(all|[0-9]{4}s)$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.events_media_booth_settings IS
  'Per-event photo booth settings: era = all, or one era key such as 1980s.';

-- Organisers read and write their own event's row from the admin; the
-- guest page reads it on the service role behind the upload link.
ALTER TABLE public.events_media_booth_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_all ON public.events_media_booth_settings;
CREATE POLICY admin_all ON public.events_media_booth_settings
  FOR ALL TO authenticated
  USING (public.can_admin_host_media('event', event_id))
  WITH CHECK (public.can_admin_host_media('event', event_id));

REVOKE ALL ON public.events_media_booth_settings FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON public.events_media_booth_settings TO authenticated;
GRANT ALL ON public.events_media_booth_settings TO service_role;
