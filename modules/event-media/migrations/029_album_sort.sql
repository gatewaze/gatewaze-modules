-- Which end of the day an album starts at.
--
-- Everything has shown newest first, which is right while an event is
-- happening: a guest opens the gallery to see what has just been put in
-- it. It is wrong for a professional's delivery. Those arrive weeks
-- later as a finished set, and reading a wedding backwards -- last dance
-- first, arrivals at the end -- is not how anybody wants to look at
-- them (asked 2026-10-17).
--
--   newest   latest first. The default, and what every album did before
--   oldest   earliest first, so the day reads forwards
--
-- Per album rather than per event, because one event wants both: the
-- guests' photographs still make more sense newest first while the
-- party is on.
--
-- It sets the DEFAULT only. The gallery takes a `sort` of its own from
-- the viewer, so somebody can turn any album round without this
-- changing.

ALTER TABLE public.event_media_album_settings
  ADD COLUMN IF NOT EXISTS sort text NOT NULL DEFAULT 'newest';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'event_media_album_settings_sort_check'
  ) THEN
    ALTER TABLE public.event_media_album_settings
      ADD CONSTRAINT event_media_album_settings_sort_check
      CHECK (sort IN ('newest', 'oldest'));
  END IF;
END $$;

COMMENT ON COLUMN public.event_media_album_settings.sort IS
  'Which end this album starts at by default: newest or oldest first. The viewer can override it.';

-- A photographer's album reads forwards. Both for the albums that exist
-- now and, below, for any made later.
UPDATE public.event_media_album_settings s
   SET sort = 'oldest'
  FROM public.event_media_view_albums v
 WHERE v.album_id = s.album_id
   AND v.view = 'photographer'
   AND s.sort = 'newest';

-- `event_media_view_album` creates the photographer album with
-- show_on_portal = false (migration 021). The same insert now says which
-- way round it reads, so an event whose photographer album does not
-- exist yet gets it too. Only that one branch of the function changes;
-- everything else here is migration 021 unchanged.
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
  -- from the Media tab when they are ready. It also reads forwards,
  -- because a delivered set is a day in order, not a feed.
  IF p_view = 'photographer' THEN
    INSERT INTO public.event_media_album_settings (album_id, event_id, show_on_portal, sort)
    VALUES (v_album, p_event_id, false, 'oldest')
    ON CONFLICT (album_id) DO NOTHING;
  END IF;

  RETURN v_album;
END $$;

REVOKE ALL ON FUNCTION public.event_media_view_album(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_media_view_album(uuid, text) TO service_role;
