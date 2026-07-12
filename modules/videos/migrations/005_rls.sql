-- ============================================================================
-- Module: videos
-- Migration: 005_rls
-- Description: Enable row-level security on videos + event_videos, mirroring the
--              established content-table pattern (see blog_posts). The broad
--              table grants are gated by these policies: anon reads only
--              published/public rows; authenticated reads all; writes are
--              admin-only. service_role (scraper / manage-api) bypasses RLS.
-- ============================================================================

-- ── videos ──────────────────────────────────────────────────────────────────
ALTER TABLE public.videos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS videos_anon_select ON public.videos;
CREATE POLICY videos_anon_select ON public.videos
  FOR SELECT TO anon
  USING (status = 'published' AND visibility = 'public');

DROP POLICY IF EXISTS videos_select ON public.videos;
CREATE POLICY videos_select ON public.videos
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS videos_insert ON public.videos;
CREATE POLICY videos_insert ON public.videos
  FOR INSERT TO authenticated
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS videos_update ON public.videos;
CREATE POLICY videos_update ON public.videos
  FOR UPDATE TO authenticated
  USING (is_admin());

DROP POLICY IF EXISTS videos_delete ON public.videos;
CREATE POLICY videos_delete ON public.videos
  FOR DELETE TO authenticated
  USING (is_admin());

-- ── event_videos (link table) ───────────────────────────────────────────────
ALTER TABLE public.event_videos ENABLE ROW LEVEL SECURITY;

-- anon may read a link only when its target video is publicly visible
DROP POLICY IF EXISTS event_videos_anon_select ON public.event_videos;
CREATE POLICY event_videos_anon_select ON public.event_videos
  FOR SELECT TO anon
  USING (EXISTS (
    SELECT 1 FROM public.videos v
    WHERE v.id = event_videos.video_id
      AND v.status = 'published' AND v.visibility = 'public'
  ));

DROP POLICY IF EXISTS event_videos_select ON public.event_videos;
CREATE POLICY event_videos_select ON public.event_videos
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS event_videos_insert ON public.event_videos;
CREATE POLICY event_videos_insert ON public.event_videos
  FOR INSERT TO authenticated
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS event_videos_update ON public.event_videos;
CREATE POLICY event_videos_update ON public.event_videos
  FOR UPDATE TO authenticated
  USING (is_admin());

DROP POLICY IF EXISTS event_videos_delete ON public.event_videos;
CREATE POLICY event_videos_delete ON public.event_videos
  FOR DELETE TO authenticated
  USING (is_admin());
