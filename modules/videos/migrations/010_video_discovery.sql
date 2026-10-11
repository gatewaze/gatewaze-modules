-- ============================================================================
-- Module: videos
-- Migration: 010_video_discovery
-- Description: Adopt every video that already exists on a connected account,
--              not just the ones Gatewaze published, and give the ones that
--              belong to no event or podcast somewhere to wait.
-- ============================================================================
--
-- Until now a metric could only exist for something Gatewaze had published:
-- the collector walks video_publications, and a publication row was only ever
-- written by our own publish path. That is backwards for an account like
-- @AgenticAI-Foundation, which has years of video nobody here uploaded.
--
-- Connecting an account should therefore ADOPT its back catalogue. Each
-- discovered video becomes a `videos` row (the table already carries every
-- platform in its provider CHECK and is already the FK target for assets,
-- subjects and publications) plus a publication row against the connection,
-- which is what makes the existing collector pick it up with no change.
--
-- A video with no video_subjects row is unassigned. That is not a new state
-- to track, it is the absence of a link, which means it cannot drift out of
-- sync with reality.

SET statement_timeout = '300s';

-- ==========================================================================
-- 1. Where a publication came from
-- ==========================================================================
ALTER TABLE public.video_publications
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'gatewaze'
    CHECK (origin IN ('gatewaze', 'discovered')),
  ADD COLUMN IF NOT EXISTS discovered_at timestamptz;

COMMENT ON COLUMN public.video_publications.origin IS
  '"gatewaze" when our publish path put the video there, "discovered" when it was already on the account and we adopted it. The distinction matters for anything that would RE-publish or edit: a discovered video is somebody else''s work and must not be overwritten.';

-- One publication per video per account. Without this, re-running discovery
-- creates a second row for the same video and the metrics collector writes
-- two rows a day for one video, each claiming to be the whole picture.
CREATE UNIQUE INDEX IF NOT EXISTS video_publications_one_per_connection
  ON public.video_publications (connection_id, external_id)
  WHERE connection_id IS NOT NULL AND external_id IS NOT NULL;

-- ==========================================================================
-- 2. Where a video came from
-- ==========================================================================
ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS discovered_via_connection_id uuid
    REFERENCES public.video_platform_connections(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.videos.discovered_via_connection_id IS
  'The connection whose back catalogue this video was adopted from. NULL for anything created in Gatewaze. Kept so a disconnected account''s adopted videos can be found and reviewed rather than silently orphaned.';

CREATE INDEX IF NOT EXISTS videos_discovered_via
  ON public.videos (discovered_via_connection_id)
  WHERE discovered_via_connection_id IS NOT NULL;

-- ==========================================================================
-- 3. Unassigned videos
-- ==========================================================================
--
-- Unassigned is the ABSENCE of a video_subjects row, not a status column.
-- A status would need maintaining in three places (assign, unassign, delete
-- the event) and would be wrong the first time one of them was missed.
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
  -- The most recent real figure, so the list can be sorted by what is worth
  -- assigning first rather than alphabetically.
  m.views AS latest_views,
  m.collected_for AS views_as_of
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

ALTER VIEW public.videos_unassigned SET (security_invoker = true);

COMMENT ON VIEW public.videos_unassigned IS
  'Videos belonging to no event and no podcast. "Unassigned" is the absence of a video_subjects row rather than a status column, so it cannot drift out of step with the links themselves. Ordered by the caller; latest_views is carried so the biggest unassigned videos can be dealt with first.';

REVOKE ALL ON public.videos_unassigned FROM anon;

-- ==========================================================================
-- 4. Assigning one
-- ==========================================================================
--
-- A function rather than a plain INSERT so the two rules live in one place:
-- a video belongs to at most one subject, and the subject must exist.
CREATE OR REPLACE FUNCTION public.assign_video_subject(
  p_video_id     uuid,
  p_subject_type text,
  p_subject_id   uuid,
  p_source       text DEFAULT 'manual'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exists boolean;
BEGIN
  IF p_subject_type NOT IN ('event', 'podcast', 'agenda_entry', 'podcast_episode') THEN
    RAISE EXCEPTION 'subject_type must be event, podcast, agenda_entry or podcast_episode';
  END IF;

  PERFORM 1 FROM public.videos WHERE id = p_video_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'video % does not exist', p_video_id; END IF;

  -- The subject has to be real. Assigning to a deleted event would leave a
  -- video attached to nothing and invisible in both lists.
  v_exists := CASE p_subject_type
    WHEN 'event'           THEN EXISTS (SELECT 1 FROM public.events WHERE id = p_subject_id)
    WHEN 'agenda_entry'    THEN EXISTS (SELECT 1 FROM public.events_agenda_entries WHERE id = p_subject_id)
    WHEN 'podcast'         THEN to_regclass('public.podcasts') IS NOT NULL
                                AND EXISTS (SELECT 1 FROM public.podcasts WHERE id = p_subject_id)
    WHEN 'podcast_episode' THEN to_regclass('public.podcast_episodes') IS NOT NULL
                                AND EXISTS (SELECT 1 FROM public.podcast_episodes WHERE id = p_subject_id)
  END;
  IF NOT COALESCE(v_exists, false) THEN
    RAISE EXCEPTION '% % does not exist', p_subject_type, p_subject_id;
  END IF;

  -- One subject per video. Re-assigning MOVES it rather than adding a second
  -- link, which is what an operator means by "actually it belongs to this".
  DELETE FROM public.video_subjects WHERE video_id = p_video_id;
  INSERT INTO public.video_subjects (video_id, subject_type, subject_id, source, confidence)
  VALUES (p_video_id, p_subject_type, p_subject_id, p_source, 1.0);

  RETURN jsonb_build_object('video_id', p_video_id, 'subject_type', p_subject_type, 'subject_id', p_subject_id);
END $$;

REVOKE ALL ON FUNCTION public.assign_video_subject(uuid, text, uuid, text) FROM PUBLIC, anon;

COMMENT ON FUNCTION public.assign_video_subject(uuid, text, uuid, text) IS
  'Attach an unassigned video to an event, podcast, agenda entry or episode. Replaces any existing link rather than adding a second, and refuses a subject that does not exist.';

-- ==========================================================================
-- 5. How much is waiting
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.videos_unassigned_count()
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT count(*) FROM public.videos_unassigned $$;

REVOKE ALL ON FUNCTION public.videos_unassigned_count() FROM PUBLIC, anon;
