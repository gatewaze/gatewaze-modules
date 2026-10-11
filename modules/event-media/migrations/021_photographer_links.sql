-- The photographer.
--
-- A wedding's professional photographs arrive weeks later, in the
-- thousands, from one person or one company rather than from the guests
-- (asked 2026-09-28). They are not guest uploads: they are not filed by
-- the hour they were taken, they are not capped like a phone's, and they
-- are nobody's to see until the organiser has been through them.
--
-- So an upload link gets a role. A photographer's link puts everything
-- it receives into one album, credits it to whoever the organiser named,
-- and keeps the originals at the size they arrived.

ALTER TABLE public.events_media_upload_links
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'guest',
  -- Who to credit: an invitation of this event's where the photographer
  -- is one of the people there, or a name where it is a company.
  ADD COLUMN IF NOT EXISTS credit_member_id uuid,
  ADD COLUMN IF NOT EXISTS credit_name text;

ALTER TABLE public.events_media_upload_links
  DROP CONSTRAINT IF EXISTS events_media_upload_links_role_check;
ALTER TABLE public.events_media_upload_links
  ADD CONSTRAINT events_media_upload_links_role_check
  CHECK (role IN ('guest', 'photographer'));

COMMENT ON COLUMN public.events_media_upload_links.role IS
  'guest = the QR everyone scans; photographer = one professional, their own album, originals kept.';

-- The album itself, alongside the others.
ALTER TABLE public.event_media_view_albums
  DROP CONSTRAINT IF EXISTS event_media_view_albums_view_check;
ALTER TABLE public.event_media_view_albums
  ADD CONSTRAINT event_media_view_albums_view_check
  CHECK (view IN ('seed', 'night', 'ready', 'day', 'evening', 'booth', 'elsewhere', 'photographer'));

CREATE OR REPLACE FUNCTION public.event_media_view_album(p_event_id uuid, p_view text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_album uuid;
BEGIN
  IF p_view NOT IN ('seed', 'night', 'ready', 'day', 'evening', 'booth', 'elsewhere', 'photographer') THEN
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
      WHEN 'seed'         THEN 'Preload'
      WHEN 'night'        THEN 'The night before'
      WHEN 'ready'        THEN 'Getting ready'
      WHEN 'day'          THEN 'The day'
      WHEN 'evening'      THEN 'Evening reception'
      WHEN 'elsewhere'    THEN 'Photo booth elsewhere'
      WHEN 'photographer' THEN 'Photographer'
      ELSE                     'Photo booth'
    END,
    CASE p_view
      WHEN 'seed'         THEN 'Shown on the projector''s Preload view.'
      WHEN 'night'        THEN 'Photographs taken the evening before the event.'
      WHEN 'ready'        THEN 'Shown on the projector''s Getting ready view. Guest uploads from before the event starts land here.'
      WHEN 'day'          THEN 'Shown on the projector''s The day view. Guest uploads land here.'
      WHEN 'evening'      THEN 'The evening reception: photographs taken from half past six.'
      WHEN 'elsewhere'    THEN 'Booth pictures made away from the event, by guests using the booth at home.'
      WHEN 'photographer' THEN 'The professional photographs, as they were delivered. Not shown to guests until you say so.'
      ELSE                     'Shown on the projector''s Photo booth view. Booth posters land here.'
    END,
    CASE p_view
      WHEN 'seed' THEN 0 WHEN 'night' THEN 1 WHEN 'ready' THEN 2
      WHEN 'day' THEN 3 WHEN 'evening' THEN 4 WHEN 'booth' THEN 5
      WHEN 'elsewhere' THEN 6 ELSE 7
    END
  )
  RETURNING id INTO v_album;

  INSERT INTO public.event_media_view_albums (album_id, event_id, view)
  VALUES (v_album, p_event_id, p_view);

  -- The photographer's album is the organiser's to look through first:
  -- thousands of photographs nobody has chosen yet, some of which will
  -- be somebody blinking. It starts off the portal, and is turned on
  -- from the Media tab when they are ready.
  IF p_view = 'photographer' THEN
    INSERT INTO public.event_media_album_settings (album_id, event_id, show_on_portal)
    VALUES (v_album, p_event_id, false)
    ON CONFLICT (album_id) DO NOTHING;
  END IF;

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
  IF v_view IS NULL OR v_view NOT IN ('seed', 'night', 'ready', 'day', 'evening', 'booth', 'elsewhere', 'photographer') THEN
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
