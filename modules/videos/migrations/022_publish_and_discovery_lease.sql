-- ============================================================================
-- Module: videos
-- Migration: 022_publish_and_discovery_lease
-- Description:
--   1. A discovery lease and last-run record per platform connection. The
--      jobs queue runs two handlers at a time and does not honour a module's
--      per-worker concurrency, so a "Sync now" during the nightly run would
--      otherwise walk the same channel twice. claim_video_discovery() takes
--      the lease atomically; a lease older than the stale window is taken
--      over, so a crashed run cannot block a channel for ever.
--   2. videos_unassigned gains status and visibility, so the Unassigned page
--      can show what is published and offer Publish / Unpublish. Columns are
--      appended, as CREATE OR REPLACE VIEW requires.
-- Idempotent.
-- ============================================================================

ALTER TABLE public.video_platform_connections
  ADD COLUMN IF NOT EXISTS discovery_started_at  timestamptz,
  ADD COLUMN IF NOT EXISTS discovery_finished_at timestamptz,
  -- What the last run did, for the operator. Never a credential.
  ADD COLUMN IF NOT EXISTS discovery_detail      text;

CREATE OR REPLACE FUNCTION public.claim_video_discovery(
  p_connection uuid,
  p_stale_minutes integer DEFAULT 120
) RETURNS boolean
LANGUAGE sql VOLATILE
SET search_path = public, pg_temp
AS $fn$
  WITH claimed AS (
    UPDATE public.video_platform_connections
       SET discovery_started_at = now()
     WHERE id = p_connection
       AND (
         discovery_started_at IS NULL
         OR (discovery_finished_at IS NOT NULL AND discovery_finished_at >= discovery_started_at)
         OR discovery_started_at < now() - make_interval(mins => GREATEST(p_stale_minutes, 1))
       )
    RETURNING id
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$fn$;
REVOKE ALL ON FUNCTION public.claim_video_discovery(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_video_discovery(uuid, integer) TO service_role;

COMMENT ON FUNCTION public.claim_video_discovery(uuid, integer) IS
  'Take the discovery lease on one connection. True when taken; false while another run holds a lease younger than p_stale_minutes.';

-- Same definition as 010, with status and visibility appended.
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
  SELECT ml.views, ml.collected_for
  FROM public.video_publications p
  JOIN public.video_metrics_latest ml ON ml.publication_id = p.id
  WHERE p.video_id = v.id
  ORDER BY ml.views DESC NULLS LAST
  LIMIT 1
) m ON true
WHERE NOT EXISTS (
  SELECT 1 FROM public.video_subjects s WHERE s.video_id = v.id
);

-- Restated, not assumed: a replaced view must keep 010's protections.
ALTER VIEW public.videos_unassigned SET (security_invoker = true);
REVOKE ALL ON public.videos_unassigned FROM anon;
