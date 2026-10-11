-- Two more albums.
--
-- night     photographs taken the evening before -- the meal, the drinks,
--           whoever arrived early. They were landing in The day.
-- elsewhere booth pictures made away from the event: guests carried on
--           using the booth at home with their families afterwards, and
--           those pictures should not sit in the wedding's own list.
--
-- Which album an upload lands in is decided in lib/view-albums.ts, from
-- the photograph's EXIF capture time where it has one.

ALTER TABLE public.event_media_view_albums
  DROP CONSTRAINT IF EXISTS event_media_view_albums_view_check;
ALTER TABLE public.event_media_view_albums
  ADD CONSTRAINT event_media_view_albums_view_check
  CHECK (view IN ('seed', 'night', 'ready', 'day', 'booth', 'elsewhere'));

CREATE OR REPLACE FUNCTION public.event_media_view_album(p_event_id uuid, p_view text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_album uuid;
BEGIN
  IF p_view NOT IN ('seed', 'night', 'ready', 'day', 'booth', 'elsewhere') THEN
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
      WHEN 'elsewhere' THEN 'Photo booth elsewhere'
      ELSE                  'Photo booth'
    END,
    CASE p_view
      WHEN 'seed'      THEN 'Shown on the projector''s Preload view.'
      WHEN 'night'     THEN 'Photographs taken the evening before the event.'
      WHEN 'ready'     THEN 'Shown on the projector''s Getting ready view. Guest uploads from before the event starts land here.'
      WHEN 'day'       THEN 'Shown on the projector''s The day view. Guest uploads land here.'
      WHEN 'elsewhere' THEN 'Booth pictures made away from the event, by guests using the booth at home.'
      ELSE                  'Shown on the projector''s Photo booth view. Booth posters land here.'
    END,
    CASE p_view
      WHEN 'seed' THEN 0 WHEN 'night' THEN 1 WHEN 'ready' THEN 2
      WHEN 'day' THEN 3 WHEN 'booth' THEN 4 ELSE 5
    END
  )
  RETURNING id INTO v_album;

  INSERT INTO public.event_media_view_albums (album_id, event_id, view)
  VALUES (v_album, p_event_id, p_view);

  RETURN v_album;
END $$;

REVOKE ALL ON FUNCTION public.event_media_view_album(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.event_media_view_album(uuid, text) TO authenticated, service_role;
