-- Per-event media settings.
--
-- One row per event, written by an organiser from the guest-uploads
-- panel and read by the guest page on the service role behind the upload
-- link. An event with no row gets the defaults below, so nothing changes
-- for an event that never sets one.
--
--   ready_hours            How long before an event the "getting ready"
--                          section opens. Default a day and a half,
--                          which covers the night before and the morning
--                          itself. Adjustable so an organiser can open it
--                          earlier -- for guests travelling, or to try it
--                          out before the day. 0 turns it off.
--
--   evening_from_minutes   When the evening reception starts, in minutes
--                          past midnight, in the same clock everything
--                          else here uses -- the one on the camera and
--                          the one the event's start is stored in. Half
--                          past six is a good default but not every event
--                          is the same shape, so the organiser says.
--                          Null means half past six.
--
-- Idempotent: every statement can run again on a database that already
-- has the table.

CREATE TABLE IF NOT EXISTS public.events_media_settings (
  event_id             uuid PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
  ready_hours          integer NOT NULL DEFAULT 36,
  evening_from_minutes integer,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.events_media_settings IS
  'Per-event media settings: when the getting-ready prompts open and when the evening reception starts.';
COMMENT ON COLUMN public.events_media_settings.ready_hours IS
  'Hours before the event start that the getting-ready prompts appear; 0 turns them off.';
COMMENT ON COLUMN public.events_media_settings.evening_from_minutes IS
  'When the evening reception starts, minutes past midnight. Null = 18:30.';

ALTER TABLE public.events_media_settings
  DROP CONSTRAINT IF EXISTS events_media_settings_ready_hours_check;
ALTER TABLE public.events_media_settings
  ADD CONSTRAINT events_media_settings_ready_hours_check
  CHECK (ready_hours BETWEEN 0 AND 336);

ALTER TABLE public.events_media_settings
  DROP CONSTRAINT IF EXISTS events_media_settings_evening_from_check;
ALTER TABLE public.events_media_settings
  ADD CONSTRAINT events_media_settings_evening_from_check
  CHECK (evening_from_minutes IS NULL OR (evening_from_minutes >= 0 AND evening_from_minutes < 1440));

-- Organisers read and write their own event's row from the admin; the
-- guest page reads it on the service role behind the upload link.
ALTER TABLE public.events_media_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_all ON public.events_media_settings;
CREATE POLICY admin_all ON public.events_media_settings
  FOR ALL TO authenticated
  USING (public.can_admin_host_media('event', event_id))
  WITH CHECK (public.can_admin_host_media('event', event_id));

REVOKE ALL ON public.events_media_settings FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON public.events_media_settings TO authenticated;
GRANT ALL ON public.events_media_settings TO service_role;
