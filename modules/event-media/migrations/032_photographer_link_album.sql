-- A photographer's link can deliver into an album of its own.
--
-- Migration 021 sent everything a photographer's link receives to the
-- one Photographer album. A wedding's photographer delivered twice
-- (asked 2026-10-28): first a chosen set of 849, then the whole day of
-- 4,600 or so. The chosen set stays where it is, and the second delivery
-- wants an album of its own, "Photographer Stream", so the two are not
-- mixed together.
--
-- So a photographer's link may name an album. The album is a registered
-- gallery album (migration 026): a host_media_albums row, a row in the
-- register under its own slug, and settings that keep it off the portal
-- until the organiser turns it on, the same as the Photographer album.
-- A link without one delivers to the Photographer album, as before.

ALTER TABLE public.events_media_upload_links
  ADD COLUMN IF NOT EXISTS album_id uuid
    REFERENCES public.host_media_albums(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.events_media_upload_links.album_id IS
  'Photographer links only: the registered album this link delivers into. NULL = the Photographer album. Set by the API through event_media_link_album(), never from a request body.';

-- Find or make the event's registered album with this name, and return
-- its id. Called by the admin API with the organiser's own session, so
-- the caller must be able to administer the event; the register itself
-- is written only here and by the service role.
CREATE OR REPLACE FUNCTION public.event_media_link_album(p_event_id uuid, p_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name  text;
  v_base  text;
  v_slug  text;
  v_album uuid;
  v_n     integer := 1;
BEGIN
  IF NOT public.can_admin_event(p_event_id) THEN
    RAISE EXCEPTION 'not authorised for this event' USING ERRCODE = '42501';
  END IF;

  v_name := left(btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', '', 'g')), 80);
  IF v_name = '' THEN
    RAISE EXCEPTION 'album name is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('event_media_link_album:' || p_event_id::text, 0));

  -- A standing album's name (Photographer, The day...) is refused: its
  -- slug is a projector view, which a link may not deliver into, so
  -- every upload would fail without saying why.
  IF EXISTS (
    SELECT 1
      FROM public.event_media_view_albums v
      JOIN public.host_media_albums a ON a.id = v.album_id
     WHERE v.event_id = p_event_id
       AND lower(a.name) = lower(v_name)
       AND v.view IN ('seed', 'night', 'ready', 'day', 'evening', 'booth', 'elsewhere', 'photographer')
  ) THEN
    RAISE EXCEPTION 'that name belongs to one of the standard albums' USING ERRCODE = '22023';
  END IF;

  -- The same name again is the same album: a second link for the same
  -- delivery, or the organiser making the link twice.
  SELECT v.album_id INTO v_album
    FROM public.event_media_view_albums v
    JOIN public.host_media_albums a ON a.id = v.album_id
   WHERE v.event_id = p_event_id
     AND lower(a.name) = lower(v_name)
   LIMIT 1;
  IF v_album IS NOT NULL THEN
    RETURN v_album;
  END IF;

  -- The slug the gallery files photographs under (metadata.album). The
  -- shape is migration 026's CHECK. It may not be a projector view's
  -- word, or the photographs would be read as that view's.
  v_base := left(btrim(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), '-'), 50);
  IF v_base = '' THEN
    v_base := 'album';
  END IF;
  v_slug := v_base;
  WHILE v_slug IN ('seed', 'night', 'ready', 'day', 'evening', 'booth', 'elsewhere', 'photographer')
     OR EXISTS (SELECT 1 FROM public.event_media_view_albums
                 WHERE event_id = p_event_id AND view = v_slug) LOOP
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  END LOOP;

  INSERT INTO public.host_media_albums (host_kind, host_id, name, description, sort_order)
  VALUES (
    'event', p_event_id, v_name,
    'Delivered by the photographer. Not shown to guests until you say so.',
    8
  )
  RETURNING id INTO v_album;

  INSERT INTO public.event_media_view_albums (album_id, event_id, view)
  VALUES (v_album, p_event_id, v_slug);

  -- Off the portal until the organiser has been through it, and read
  -- forwards, like the Photographer album (migrations 021 and 029).
  INSERT INTO public.event_media_album_settings (album_id, event_id, show_on_portal, sort)
  VALUES (v_album, p_event_id, false, 'oldest')
  ON CONFLICT (album_id) DO NOTHING;

  RETURN v_album;
END $$;

REVOKE ALL ON FUNCTION public.event_media_link_album(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.event_media_link_album(uuid, text) TO authenticated, service_role;

-- Upload rows join their album on insert. Until now that was the
-- projector views only; a registered album's slug now joins it too, so
-- the organiser's Media tab shows the photographs in the album they
-- were delivered to. Views behave exactly as before.
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
  IF v_view IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    IF v_view IN ('seed', 'night', 'ready', 'day', 'evening', 'booth', 'elsewhere', 'photographer') THEN
      v_album := public.event_media_view_album(NEW.host_id, v_view);
    ELSE
      SELECT album_id INTO v_album
        FROM public.event_media_view_albums
       WHERE event_id = NEW.host_id AND view = v_view;
      IF v_album IS NULL THEN
        RETURN NEW;
      END IF;
    END IF;
    INSERT INTO public.host_media_album_items (album_id, media_id, sort_order)
    VALUES (v_album, NEW.id, 0)
    ON CONFLICT (album_id, media_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'event-media: could not add % to its % album: %', NEW.id, v_view, SQLERRM;
  END;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.event_media_join_view_album() FROM PUBLIC, anon, authenticated;
