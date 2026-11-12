-- ============================================================================
-- Module: videos
-- Migration: 023_unassigned_view_speed
-- Description: videos_unassigned without the per-row scan of every metric.
--
--   010 (restated in 022) found each video's view count with a LATERAL
--   subquery joined to video_metrics_latest. That view is a DISTINCT ON over
--   the whole of video_metrics, and Postgres cannot push a join condition into
--   a DISTINCT ON view, so the view was rebuilt in full for every video. With
--   about 2,800 videos and 2,800 metric rows on AAIF that is millions of rows
--   per query: the triage list hit the statement timeout and the Unassigned
--   page showed "0 waiting".
--
--   The replacement reads the newest successful row for each publication
--   straight from video_metrics, by the (publication_id, collected_for DESC)
--   index from 009, and finds a video's publications by a new plain index on
--   video_publications (video_id): 007's index on that column is partial
--   (connection_id IS NOT NULL), so a lookup by video_id alone could not use
--   it and scanned the table once per video.
--
--   The view means exactly what the old one meant (newest status 'ok'
--   collection per publication, as video_metrics_latest defines it; the
--   publication with the most views wins), so the columns and their values
--   do not change. Measured on AAIF-sized data: about 1 s down to 4 ms, with
--   identical rows.
-- Idempotent.
-- ============================================================================

CREATE INDEX IF NOT EXISTS video_publications_video
  ON public.video_publications (video_id);

CREATE OR REPLACE VIEW public.videos_unassigned AS
SELECT
  v.id,
  v.provider,
  v.provider_video_id,
  v.url,
  v.title,
  v.description,
  v.thumbnail_url,
  v.duration_seconds,
  v.published_at,
  v.channel_id,
  v.channel_title,
  v.kind,
  v.discovered_via_connection_id,
  c.label AS connection_label,
  v.created_at,
  m.views AS latest_views,
  m.collected_for AS views_as_of,
  v.status,
  v.visibility
FROM public.videos v
LEFT JOIN public.video_platform_connections c ON c.id = v.discovered_via_connection_id
LEFT JOIN LATERAL (
  SELECT lm.views, lm.collected_for
  FROM public.video_publications p
  CROSS JOIN LATERAL (
    SELECT vm.views, vm.collected_for
    FROM public.video_metrics vm
    WHERE vm.publication_id = p.id
      AND vm.status = 'ok'
    ORDER BY vm.collected_for DESC
    LIMIT 1
  ) lm
  WHERE p.video_id = v.id
  ORDER BY lm.views DESC NULLS LAST
  LIMIT 1
) m ON true
WHERE NOT EXISTS (
  SELECT 1 FROM public.video_subjects s WHERE s.video_id = v.id
);

-- Restated, not assumed: a replaced view must keep 010's protections.
ALTER VIEW public.videos_unassigned SET (security_invoker = true);
REVOKE ALL ON public.videos_unassigned FROM anon;
