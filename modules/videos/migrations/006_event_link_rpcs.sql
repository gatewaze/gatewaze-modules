-- ============================================================================
-- Module: videos
-- Migration: 006_event_link_rpcs
-- Description: Admin-gated RPCs to link/unlink canonical videos to events
--              (populates event_videos) plus a public read for an event's
--              linked videos. Writes are SECURITY DEFINER + is_admin() gated so
--              the admin app can manage links without direct table grants; the
--              read returns only published/public videos for anon.
-- ============================================================================

-- Link a video to an event (idempotent on the (event,video) pair; updates
-- role/sort_order/playlist on repeat). Admin-only.
CREATE OR REPLACE FUNCTION public.event_videos_link(
  p_event_uuid uuid,
  p_video_id   uuid,
  p_role       text DEFAULT 'session',
  p_sort_order integer DEFAULT 0,
  p_playlist_id text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  INSERT INTO public.event_videos (event_uuid, video_id, role, sort_order, playlist_id)
  VALUES (p_event_uuid, p_video_id, coalesce(p_role, 'session'), coalesce(p_sort_order, 0), p_playlist_id)
  ON CONFLICT (event_uuid, video_id)
  DO UPDATE SET role = excluded.role, sort_order = excluded.sort_order, playlist_id = excluded.playlist_id
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.event_videos_unlink(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  DELETE FROM public.event_videos WHERE id = p_id;
END $$;

-- Public read: an event's linked, publicly-visible videos in display order.
CREATE OR REPLACE FUNCTION public.event_videos_for_event(p_event_uuid uuid)
RETURNS TABLE (
  link_id     uuid,
  video_id    uuid,
  role        text,
  sort_order  integer,
  url         text,
  title       text,
  description text,
  thumbnail_url text,
  published_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT ev.id, v.id, ev.role, ev.sort_order,
         v.url, v.title, v.description, v.thumbnail_url, v.published_at
  FROM public.event_videos ev
  JOIN public.videos v ON v.id = ev.video_id
  WHERE ev.event_uuid = p_event_uuid
    AND v.status = 'published' AND v.visibility = 'public'
  ORDER BY ev.sort_order, v.published_at DESC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION public.event_videos_link(uuid, uuid, text, integer, text) FROM public;
REVOKE ALL ON FUNCTION public.event_videos_unlink(uuid) FROM public;
REVOKE ALL ON FUNCTION public.event_videos_for_event(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.event_videos_link(uuid, uuid, text, integer, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.event_videos_unlink(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.event_videos_for_event(uuid) TO anon, authenticated, service_role;
