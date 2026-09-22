-- Guests an organiser has blocked from an event's photos.
--
-- When an event has an invitation list, every guest upload and booth
-- picture records which invitation member made it (metadata.member_id).
-- A row here stops that guest uploading or using the booth, and takes
-- every photo of theirs off the projector and the gallery. Deleting the
-- row brings them back. No foreign key to the invitation tables: those
-- belong to another module, which an event may not have installed.

CREATE TABLE IF NOT EXISTS public.events_media_guest_blocks (
  event_id   uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  member_id  uuid NOT NULL,
  guest_name text,
  blocked_at timestamptz NOT NULL DEFAULT now(),
  blocked_by uuid,
  PRIMARY KEY (event_id, member_id)
);

COMMENT ON TABLE public.events_media_guest_blocks IS
  'Invitation guests blocked from uploading to an event; their photos are hidden from the projector and gallery.';

ALTER TABLE public.events_media_guest_blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_all ON public.events_media_guest_blocks;
CREATE POLICY admin_all ON public.events_media_guest_blocks
  FOR ALL TO authenticated
  USING (public.can_admin_host_media('event', event_id))
  WITH CHECK (public.can_admin_host_media('event', event_id));

REVOKE ALL ON public.events_media_guest_blocks FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.events_media_guest_blocks TO authenticated;
GRANT ALL ON public.events_media_guest_blocks TO service_role;
