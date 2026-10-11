-- The evening reception.
--
-- The day ran from the ceremony at half past one to the small hours, and
-- all of it landed in one album. The party is its own thing -- different
-- light, different clothes, different people -- so photographs taken from
-- half past six belong to it (asked 2026-09-28).
--
-- Which album an upload lands in is decided in lib/view-albums.ts, from
-- the photograph's own capture time where it has one.

ALTER TABLE public.event_media_view_albums
  DROP CONSTRAINT IF EXISTS event_media_view_albums_view_check;
ALTER TABLE public.event_media_view_albums
  ADD CONSTRAINT event_media_view_albums_view_check
  CHECK (view IN ('seed', 'night', 'ready', 'day', 'evening', 'booth', 'elsewhere'));

CREATE OR REPLACE FUNCTION public.event_media_view_album(p_event_id uuid, p_view text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_album uuid;
BEGIN
  IF p_view NOT IN ('seed', 'night', 'ready', 'day', 'evening', 'booth', 'elsewhere') THEN
    RAISE EXCEPTION 'unknown view %', p_view;
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
    CASE p_view
      WHEN 'seed'      THEN 'Preload'
      WHEN 'night'     THEN 'The night before'
      WHEN 'ready'     THEN 'Getting ready'
      WHEN 'day'       THEN 'The day'
      WHEN 'evening'   THEN 'Evening reception'
      WHEN 'elsewhere' THEN 'Photo booth elsewhere'
      ELSE                  'Photo booth'
    END,
    CASE p_view
      WHEN 'seed'      THEN 'Shown on the projector''s Preload view.'
      WHEN 'night'     THEN 'Photographs taken the evening before the event.'
      WHEN 'ready'     THEN 'Shown on the projector''s Getting ready view. Guest uploads from before the event starts land here.'
      WHEN 'day'       THEN 'Shown on the projector''s The day view. Guest uploads land here.'
      WHEN 'evening'   THEN 'The evening reception: photographs taken from half past six.'
      WHEN 'elsewhere' THEN 'Booth pictures made away from the event, by guests using the booth at home.'
      ELSE                  'Shown on the projector''s Photo booth view. Booth posters land here.'
    END,
    CASE p_view
      WHEN 'seed' THEN 0 WHEN 'night' THEN 1 WHEN 'ready' THEN 2
      WHEN 'day' THEN 3 WHEN 'evening' THEN 4 WHEN 'booth' THEN 5 ELSE 6
    END
  )
  RETURNING id INTO v_album;

  INSERT INTO public.event_media_view_albums (album_id, event_id, view)
  VALUES (v_album, p_event_id, p_view);

  RETURN v_album;
END $$;

REVOKE ALL ON FUNCTION public.event_media_view_album(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_media_view_album(uuid, text) TO service_role;

-- And the trigger that joins a new upload to its album, which has its own
-- copy of the list (migration 015 exists because it was forgotten once).
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
  IF v_view IS NULL OR v_view NOT IN ('seed', 'night', 'ready', 'day', 'evening', 'booth', 'elsewhere') THEN
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
