-- Sponsor tags on event media — the organizer's "Tag Sponsors" action.
--
-- Restores the legacy gatewaze-admin event_media_sponsor_tags junction
-- (many sponsors per photo) on top of host_media, where event media now
-- lives. host_media.sponsor_id holds at most one sponsor, which is why
-- the junction is back rather than reusing that column.
--
-- The legacy table let ANY authenticated user read and write every tag
-- (USING (true)). Here both sides must belong to the same event and the
-- caller must be able to administer it.

CREATE TABLE IF NOT EXISTS public.events_media_sponsor_tags (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id          uuid NOT NULL REFERENCES public.host_media(id) ON DELETE CASCADE,
  event_sponsor_id  uuid NOT NULL REFERENCES public.events_sponsors(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (media_id, event_sponsor_id)
);

CREATE INDEX IF NOT EXISTS idx_events_media_sponsor_tags_sponsor
  ON public.events_media_sponsor_tags(event_sponsor_id);

ALTER TABLE public.events_media_sponsor_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_all ON public.events_media_sponsor_tags;
CREATE POLICY admin_all ON public.events_media_sponsor_tags
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM public.events_sponsors s
        JOIN public.host_media m
          ON m.id = events_media_sponsor_tags.media_id
         AND m.host_kind = 'event'
         AND m.host_id = s.event_id
       WHERE s.id = events_media_sponsor_tags.event_sponsor_id
         AND public.can_admin_event(s.event_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM public.events_sponsors s
        JOIN public.host_media m
          ON m.id = events_media_sponsor_tags.media_id
         AND m.host_kind = 'event'
         AND m.host_id = s.event_id
       WHERE s.id = events_media_sponsor_tags.event_sponsor_id
         AND public.can_admin_event(s.event_id)
    )
  );
