-- A fourth projector view: Getting ready.
--
-- Photos guests take before they arrive -- dressing, travelling, the
-- morning of. They reach it through an upload link whose destination is
-- 'ready' (sent ahead of the day), where the venue's QR stays 'day'. The
-- booth's posters still go to the booth whichever link made them.
--
--   events_media_upload_links.album   where a link's uploads land
--   event_media_view_albums            now accepts 'ready'
--   event_media_view_album()           names and orders the new album
--   the insert trigger                 joins 'ready' uploads to it

ALTER TABLE public.events_media_upload_links
  ADD COLUMN IF NOT EXISTS album text NOT NULL DEFAULT 'day';

ALTER TABLE public.events_media_upload_links
  DROP CONSTRAINT IF EXISTS events_media_upload_links_album_check;
ALTER TABLE public.events_media_upload_links
  ADD CONSTRAINT events_media_upload_links_album_check CHECK (album IN ('day', 'ready'));

ALTER TABLE public.event_media_view_albums
  DROP CONSTRAINT IF EXISTS event_media_view_albums_view_check;
ALTER TABLE public.event_media_view_albums
  ADD CONSTRAINT event_media_view_albums_view_check CHECK (view IN ('seed', 'ready', 'day', 'booth'));

CREATE OR REPLACE FUNCTION public.event_media_view_album(p_event_id uuid, p_view text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_album uuid;
BEGIN
  IF p_view NOT IN ('seed', 'ready', 'day', 'booth') THEN
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
    CASE p_view
      WHEN 'seed'  THEN 'Preload'
      WHEN 'ready' THEN 'Getting ready'
      WHEN 'day'   THEN 'The day'
      ELSE              'Photo booth'
    END,
    CASE p_view
      WHEN 'seed'  THEN 'Shown on the projector''s Preload view.'
      WHEN 'ready' THEN 'Shown on the projector''s Getting ready view. Uploads through a Getting ready link land here.'
      WHEN 'day'   THEN 'Shown on the projector''s The day view. Guest uploads land here.'
      ELSE              'Shown on the projector''s Photo booth view. Booth posters land here.'
    END,
    CASE p_view WHEN 'seed' THEN 0 WHEN 'ready' THEN 1 WHEN 'day' THEN 2 ELSE 3 END
  )
  RETURNING id INTO v_album;

  INSERT INTO public.event_media_view_albums (album_id, event_id, view)
  VALUES (v_album, p_event_id, p_view);

  RETURN v_album;
END $$;

REVOKE ALL ON FUNCTION public.event_media_view_album(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_media_view_album(uuid, text) TO service_role;

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
  IF v_view IS NULL OR v_view NOT IN ('seed', 'ready', 'day', 'booth') THEN
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

-- Existing events keep Preload first; the day and the booth move along
-- one to make room for Getting ready, and every event that already has
-- the views gets the new album now rather than on its first upload.
UPDATE public.host_media_albums a
   SET sort_order = CASE v.view WHEN 'day' THEN 2 WHEN 'booth' THEN 3 ELSE a.sort_order END
  FROM public.event_media_view_albums v
 WHERE v.album_id = a.id AND v.view IN ('day', 'booth');

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT event_id FROM public.event_media_view_albums LOOP
    PERFORM public.event_media_view_album(r.event_id, 'ready');
  END LOOP;
END $$;
