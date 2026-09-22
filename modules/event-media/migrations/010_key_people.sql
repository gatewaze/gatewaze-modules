-- An event's key people: the couple, the birthday girl, the band.
--
-- One to five per event, each with up to five reference photos. The
-- photo booth uses them to make its example pictures -- every look's
-- sample and every decade card shows these people, in likeness, rather
-- than strangers. Photos live in storage under
-- event/<event uuid>/key-people/; the paths are checked again by the
-- server before any of them is handed to the image model.

CREATE TABLE IF NOT EXISTS public.events_media_key_people (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  photos     text[] NOT NULL DEFAULT '{}' CHECK (cardinality(photos) <= 5),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_media_key_people_event
  ON public.events_media_key_people (event_id, sort_order);

COMMENT ON TABLE public.events_media_key_people IS
  'Up to five people per event whose photos the photo booth uses for its example pictures.';

-- At most five per event.
CREATE OR REPLACE FUNCTION public.events_media_key_people_limit()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('events_media_key_people:' || NEW.event_id::text, 0));
  IF (SELECT count(*) FROM public.events_media_key_people WHERE event_id = NEW.event_id) >= 5 THEN
    RAISE EXCEPTION 'an event can have at most five key people' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS events_media_key_people_limit ON public.events_media_key_people;
CREATE TRIGGER events_media_key_people_limit
  BEFORE INSERT ON public.events_media_key_people
  FOR EACH ROW EXECUTE FUNCTION public.events_media_key_people_limit();

ALTER TABLE public.events_media_key_people ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_all ON public.events_media_key_people;
CREATE POLICY admin_all ON public.events_media_key_people
  FOR ALL TO authenticated
  USING (public.can_admin_host_media('event', event_id))
  WITH CHECK (public.can_admin_host_media('event', event_id));

REVOKE ALL ON public.events_media_key_people FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.events_media_key_people TO authenticated;
GRANT ALL ON public.events_media_key_people TO service_role;
