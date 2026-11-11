-- ============================================================================
-- Module: videos
-- Migration: 021_public_api
-- Description: videos_api_public, the read model behind /api/v1/videos and the
--   unified /api/v1/content feed.
--
--   It applies exactly the rule every other public read of videos applies
--   (the anon RLS policy in 005, videos_public_list/get in 003, the event
--   RPCs in 006): status 'published', visibility 'public', and not hidden by
--   content-keywords. So an API key sees what the public site shows and
--   nothing more. In particular a video discovered from a connected channel
--   is a draft until someone publishes it, and a private or unlisted upload
--   (visibility 'private') never appears.
--
--   security_invoker, granted to service_role only: the API reads it with
--   the service role, and anon/authenticated keep their existing RLS paths.
-- Idempotent.
-- ============================================================================

-- Keyword suppression, checked when the row is read rather than when this
-- migration runs, so installing content-keywords later takes effect at once.
-- PL/pgSQL plans the SELECT only when reached, so the function is valid while
-- the content-keywords tables are absent.
CREATE OR REPLACE FUNCTION public.video_keyword_visible(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v boolean;
BEGIN
  IF to_regclass('public.content_keyword_item_state') IS NULL
     OR to_regclass('public.content_keyword_adapters') IS NULL THEN
    RETURN true;
  END IF;
  SELECT COALESCE(
           (SELECT s.is_visible FROM public.content_keyword_item_state s
             WHERE s.content_type = 'video' AND s.content_id = p_id),
           (SELECT a.default_visible_when_no_rules FROM public.content_keyword_adapters a
             WHERE a.content_type = 'video'),
           true)
    INTO v;
  RETURN v;
END $fn$;
REVOKE ALL ON FUNCTION public.video_keyword_visible(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.video_keyword_visible(uuid) TO service_role;

DROP VIEW IF EXISTS public.videos_api_public;
CREATE VIEW public.videos_api_public WITH (security_invoker = true) AS
SELECT
  v.id,
  v.provider,
  v.provider_video_id,
  -- URLs are passed through only when they are http(s): an API consumer may
  -- render them as links, and a row can be written by an editor.
  CASE WHEN v.url ~* '^https?://' THEN v.url END AS url,
  v.title,
  v.description,
  CASE WHEN v.thumbnail_url ~* '^https?://' THEN v.thumbnail_url END AS thumbnail_url,
  v.duration_seconds,
  v.published_at,
  -- Never null, for feeds that sort by date.
  COALESCE(v.published_at, v.created_at) AS sort_date,
  v.channel_id,
  v.channel_title,
  v.kind,
  v.topics,
  v.content_category,
  v.created_at,
  v.updated_at
FROM public.videos v
WHERE v.status = 'published'
  AND v.visibility = 'public'
  AND public.video_keyword_visible(v.id);

REVOKE ALL ON public.videos_api_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.videos_api_public TO service_role;

COMMENT ON VIEW public.videos_api_public IS
  'Published, public videos: the same rule as the anon RLS policy and videos_public_list. Read model for /api/v1/videos and /api/v1/content. service_role only.';
