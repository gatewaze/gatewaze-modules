-- The projector's three views as real albums.
--
-- The display shows one of three streams -- Preload (the selfies shown
-- before the day), The day (guest uploads) and Photo booth (the booth's
-- posters). Which stream a photo belonged to was a hidden tag,
-- metadata.album ('seed' | 'day' | 'booth'), invisible in the admin and
-- impossible to change there.
--
-- Each event now gets one host-media album per view, and album
-- membership is what the feed reads. Moving a photo between these albums
-- in the Media tab moves it between views on the projector. The tag is
-- kept as the fallback for a photo in none of them, and as the record of
-- where an upload first landed.
--
--   event_media_view_albums         which album is which view, per event
--   event_media_view_album(ev, v)   the album for a view, created on demand
--   host_media insert trigger       new uploads join their view's album
--   backfill                        existing photos join theirs

CREATE TABLE IF NOT EXISTS public.event_media_view_albums (
  album_id   uuid PRIMARY KEY REFERENCES public.host_media_albums(id) ON DELETE CASCADE,
  event_id   uuid NOT NULL,
  view       text NOT NULL CHECK (view IN ('seed', 'day', 'booth')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, view)
);

COMMENT ON TABLE public.event_media_view_albums IS
  'Maps each event''s Preload / The day / Photo booth albums to the projector view they feed.';

-- Read by the admin to label the albums; written only by the functions
-- below and the service role.
ALTER TABLE public.event_media_view_albums ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_read ON public.event_media_view_albums;
CREATE POLICY admin_read ON public.event_media_view_albums
  FOR SELECT TO authenticated
  USING (public.can_admin_host_media('event', event_id));

REVOKE ALL ON public.event_media_view_albums FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.event_media_view_albums TO authenticated;
GRANT ALL ON public.event_media_view_albums TO service_role;

-- The album for one view of one event, creating it the first time.
-- Serialised per event and view, so two uploads arriving together for a
-- fresh event cannot create two "The day" albums.
CREATE OR REPLACE FUNCTION public.event_media_view_album(p_event_id uuid, p_view text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_album uuid;
BEGIN
  IF p_view NOT IN ('seed', 'day', 'booth') THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('event_media_view_album:' || p_event_id::text || ':' || p_view, 0));

  SELECT album_id INTO v_album
    FROM public.event_media_view_albums
   WHERE event_id = p_event_id AND view = p_view;
  IF v_album IS NOT NULL THEN
    RETURN v_album;
  END IF;

  INSERT INTO public.host_media_albums (host_kind, host_id, name, description, sort_order)
  VALUES (
    'event', p_event_id,
    CASE p_view WHEN 'seed' THEN 'Preload' WHEN 'day' THEN 'The day' ELSE 'Photo booth' END,
    CASE p_view
      WHEN 'seed' THEN 'Shown on the projector''s Preload view.'
      WHEN 'day'  THEN 'Shown on the projector''s The day view. Guest uploads land here.'
      ELSE             'Shown on the projector''s Photo booth view. Booth posters land here.'
    END,
    CASE p_view WHEN 'seed' THEN 0 WHEN 'day' THEN 1 ELSE 2 END
  )
  RETURNING id INTO v_album;

  INSERT INTO public.event_media_view_albums (album_id, event_id, view)
  VALUES (v_album, p_event_id, p_view);

  RETURN v_album;
END $$;

REVOKE ALL ON FUNCTION public.event_media_view_album(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_media_view_album(uuid, text) TO service_role;

-- A new upload joins the album for the view it was tagged with.
--
-- Never allowed to fail the upload: a guest's photo matters more than
-- its album, and the feed falls back to the tag for a photo in no view
-- album, so a missed join shows up in the same place regardless.
CREATE OR REPLACE FUNCTION public.event_media_join_view_album()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_view  text;
  v_album uuid;
BEGIN
  IF NEW.host_kind <> 'event' THEN
    RETURN NEW;
  END IF;
  v_view := NEW.metadata ->> 'album';
  IF v_view IS NULL OR v_view NOT IN ('seed', 'day', 'booth') THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_album := public.event_media_view_album(NEW.host_id, v_view);
    INSERT INTO public.host_media_album_items (album_id, media_id, sort_order)
    VALUES (v_album, NEW.id, 0)
    ON CONFLICT (album_id, media_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'event-media: could not add % to its % album: %', NEW.id, v_view, SQLERRM;
  END;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.event_media_join_view_album() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS event_media_join_view_album ON public.host_media;
CREATE TRIGGER event_media_join_view_album
  AFTER INSERT ON public.host_media
  FOR EACH ROW EXECUTE FUNCTION public.event_media_join_view_album();

-- Backfill: every event that already uses the views (any photo carrying
-- the tag) gets its three albums, and each of its photos joins one --
-- untagged photos predate the tag and are Preload, as the feed has
-- always read them. Photos already in a view album are left where an
-- organiser put them, so re-running this is harmless.
DO $$
DECLARE
  r record;
  v_seed uuid; v_day uuid; v_booth uuid;
BEGIN
  FOR r IN
    SELECT DISTINCT host_id AS event_id
      FROM public.host_media
     WHERE host_kind = 'event' AND metadata ? 'album'
  LOOP
    v_seed  := public.event_media_view_album(r.event_id, 'seed');
    v_day   := public.event_media_view_album(r.event_id, 'day');
    v_booth := public.event_media_view_album(r.event_id, 'booth');

    INSERT INTO public.host_media_album_items (album_id, media_id, sort_order)
    SELECT CASE coalesce(m.metadata ->> 'album', 'seed')
             WHEN 'day' THEN v_day
             WHEN 'booth' THEN v_booth
             ELSE v_seed
           END,
           m.id, 0
      FROM public.host_media m
     WHERE m.host_kind = 'event'
       AND m.host_id = r.event_id
       AND NOT EXISTS (
         SELECT 1
           FROM public.host_media_album_items i
           JOIN public.event_media_view_albums v ON v.album_id = i.album_id
          WHERE i.media_id = m.id
       )
    ON CONFLICT (album_id, media_id) DO NOTHING;
  END LOOP;
END $$;
