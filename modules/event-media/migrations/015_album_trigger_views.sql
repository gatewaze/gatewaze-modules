-- The album-joining trigger never heard about the two new albums.
--
-- Migration 014 widened the view list in two places -- the CHECK on
-- event_media_view_albums and event_media_view_album(), which makes an
-- album on demand -- but not in the third: the AFTER INSERT trigger on
-- host_media, which reads metadata->>'album' and joins the photograph to
-- that view's album. Its list was still the four from 007, so a
-- photograph tagged 'night' or 'elsewhere' quietly joined nothing, and
-- because the albums are made on demand, they were never made at all:
-- "the new albums haven't been added" (reported 2026-09-27).
--
-- The tag was right, so the projector and the portal put those
-- photographs in the right stream all along; only the Media tab, which
-- reads real albums, could not show them.

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
  IF v_view IS NULL OR v_view NOT IN ('seed', 'night', 'ready', 'day', 'booth', 'elsewhere') THEN
    RETURN NEW;
  END IF;

  -- Never allowed to fail the upload: a guest's photo matters more than
  -- its album, and the feed falls back to the tag for a photo in no view
  -- album, so a missed join shows up in the same place regardless.
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

-- Catch up the photographs the trigger turned away: any row tagged with
-- a view but in none of that event's view albums joins the one its tag
-- names. Photographs an organiser has already moved by hand are left
-- alone -- membership of any view album counts as a decision -- so this
-- is safe to run again.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT m.id, m.host_id, m.metadata ->> 'album' AS view
      FROM public.host_media m
     WHERE m.host_kind = 'event'
       AND m.metadata ->> 'album' IN ('seed', 'night', 'ready', 'day', 'booth', 'elsewhere')
       AND NOT EXISTS (
         SELECT 1
           FROM public.host_media_album_items i
           JOIN public.event_media_view_albums v ON v.album_id = i.album_id
          WHERE i.media_id = m.id
       )
  LOOP
    BEGIN
      INSERT INTO public.host_media_album_items (album_id, media_id, sort_order)
      VALUES (public.event_media_view_album(r.host_id, r.view), r.id, 0)
      ON CONFLICT (album_id, media_id) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'event-media: could not catch up % (%): %', r.id, r.view, SQLERRM;
    END;
  END LOOP;
END $$;

-- And put back a grant 014 widened by accident.
--
-- 006 and 007 both kept event_media_view_album() to the service role:
-- it makes an album row for whatever event id it is handed, with no
-- check that the caller administers that event. 014 granted it to
-- `authenticated` as well, which let any signed-in user create albums on
-- anybody's event. Nothing calls it as the caller -- the module's own
-- routes use the service client, and the trigger is SECURITY DEFINER --
-- so this takes nothing away.
REVOKE ALL ON FUNCTION public.event_media_view_album(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_media_view_album(uuid, text) TO service_role;
