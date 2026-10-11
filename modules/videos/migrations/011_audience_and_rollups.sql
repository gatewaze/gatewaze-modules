-- ============================================================================
-- Module: videos
-- Migration: 011_audience_and_rollups
-- Description: Followers per account over time, and cross-platform totals per
--              episode, per talk and per event.
-- ============================================================================
--
-- Two things video_metrics cannot answer, because it is keyed per
-- publication:
--
--   "how many people follow this channel" is a property of the ACCOUNT, not
--   of any video on it. Stored per connection per day so growth is a series
--   rather than a number that overwrites itself.
--
--   "how did this event do" spans platforms. A talk's recording is on
--   YouTube, its clip is on TikTok and Instagram, and the episode is on
--   Spotify. The question an organiser asks is about the talk, not about
--   YouTube.
--
-- The honesty problem in the second one is real and is handled rather than
-- hidden. A YouTube view, a TikTok view and a Spotify stream are not the same
-- event: TikTok counts a view almost immediately, YouTube needs meaningful
-- watch time, and a podcast stream is a different act entirely. Summing them
-- produces a number that looks authoritative and compares nothing.
--
-- So the rollups below always carry the per-platform breakdown alongside the
-- total, and the total column is named `reach` rather than `views` to stop it
-- being read as a like-for-like count. Anything that shows the total must be
-- able to show the split.

SET statement_timeout = '300s';

-- ==========================================================================
-- 1. Followers, per account, over time
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.video_channel_metrics (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.video_platform_connections(id) ON DELETE CASCADE,
  collected_for date NOT NULL,

  -- Same convention as video_metrics: a failed scrape is no_data, never 0.
  -- A channel showing 0 followers after a markup change is the single most
  -- alarming-looking false alarm this system could produce.
  status text NOT NULL DEFAULT 'ok'
    CHECK (status IN ('ok', 'no_data', 'auth', 'error')),
  status_detail text,

  -- Each platform's own word for the same idea. Kept as one column because
  -- the question "how many people follow us" is the same question.
  followers     bigint,
  -- Where a platform separates them: YouTube subscribers vs channel views.
  total_views   bigint,
  total_videos  bigint,
  raw           jsonb NOT NULL DEFAULT '{}'::jsonb,

  collected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, collected_for)
);

COMMENT ON TABLE public.video_channel_metrics IS
  'Followers and channel totals per account per day. Account-level, because a follower belongs to the channel rather than to any video on it. status=no_data records that we asked and were not told, and is never written as zero.';

CREATE INDEX IF NOT EXISTS video_channel_metrics_connection_day
  ON public.video_channel_metrics (connection_id, collected_for DESC);

ALTER TABLE public.video_channel_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS video_channel_metrics_read ON public.video_channel_metrics;
CREATE POLICY video_channel_metrics_read
  ON public.video_channel_metrics FOR SELECT
  USING (public.can_edit_any_videos());

REVOKE ALL ON public.video_channel_metrics FROM anon;

-- Latest real figure per account, so a failed collection shows yesterday's
-- number rather than a blank.
CREATE OR REPLACE VIEW public.video_channel_metrics_latest AS
SELECT DISTINCT ON (m.connection_id)
  m.connection_id, c.platform, c.label, c.external_account_id,
  m.collected_for, m.followers, m.total_views, m.total_videos, m.collected_at
FROM public.video_channel_metrics m
JOIN public.video_platform_connections c ON c.id = m.connection_id
WHERE m.status = 'ok'
ORDER BY m.connection_id, m.collected_for DESC;

ALTER VIEW public.video_channel_metrics_latest SET (security_invoker = true);
REVOKE ALL ON public.video_channel_metrics_latest FROM anon;

-- ==========================================================================
-- 2. Per video, across every platform it is on
-- ==========================================================================
--
-- One video can have several publications: the master on YouTube, the clip
-- on TikTok and Instagram. This is the first level of rollup.
CREATE OR REPLACE VIEW public.video_reach AS
SELECT
  v.id AS video_id,
  v.title,
  v.kind,
  count(DISTINCT p.id) FILTER (WHERE ml.publication_id IS NOT NULL) AS platforms_measured,
  count(DISTINCT p.id)                                              AS platforms_published,
  -- `reach`, not `views`: see the header. The breakdown is beside it so a
  -- caller can always show what it is made of.
  sum(ml.views)    AS reach,
  sum(ml.likes)    AS likes,
  sum(ml.comments) AS comments,
  jsonb_object_agg(
    p.platform,
    jsonb_build_object('views', ml.views, 'likes', ml.likes, 'as_of', ml.collected_for)
  ) FILTER (WHERE ml.publication_id IS NOT NULL) AS by_platform,
  max(ml.collected_for) AS as_of
FROM public.videos v
JOIN public.video_publications p ON p.video_id = v.id
LEFT JOIN public.video_metrics_latest ml ON ml.publication_id = p.id
GROUP BY v.id, v.title, v.kind;

ALTER VIEW public.video_reach SET (security_invoker = true);

COMMENT ON VIEW public.video_reach IS
  'One video across every platform it is published on. `reach` is a SUM of counts that different platforms define differently — a TikTok view, a YouTube view and a podcast stream are not the same act — so by_platform is carried alongside and anything showing the total must be able to show the split.';

REVOKE ALL ON public.video_reach FROM anon;

-- ==========================================================================
-- 3. Per subject: an episode, a talk, a whole event
-- ==========================================================================
--
-- video_subjects already links a video to an event, a podcast, an agenda
-- entry or an episode, so the subject rollup is that join plus video_reach.
CREATE OR REPLACE VIEW public.video_subject_reach AS
SELECT
  s.subject_type,
  s.subject_id,
  count(DISTINCT s.video_id)                                   AS videos,
  count(DISTINCT s.video_id) FILTER (WHERE r.reach IS NOT NULL) AS videos_measured,
  sum(r.reach)    AS reach,
  sum(r.likes)    AS likes,
  sum(r.comments) AS comments,
  max(r.as_of)    AS as_of
FROM public.video_subjects s
LEFT JOIN public.video_reach r ON r.video_id = s.video_id
GROUP BY s.subject_type, s.subject_id;

ALTER VIEW public.video_subject_reach SET (security_invoker = true);

COMMENT ON VIEW public.video_subject_reach IS
  'Totals for one podcast episode, one talk, one podcast or one event. videos_measured is deliberately beside videos: a total covering 3 of 11 videos must not be presented as the event''s performance.';

REVOKE ALL ON public.video_subject_reach FROM anon;

-- ==========================================================================
-- 4. A whole event, including its talks
-- ==========================================================================
--
-- An event's videos arrive two ways: attached to the event directly, or
-- attached to one of its agenda entries. A rollup that only counted the
-- former would report nearly nothing, since the editor workflow attaches a
-- talk recording to the agenda entry.
CREATE OR REPLACE FUNCTION public.event_video_reach(p_event_uuid uuid)
RETURNS TABLE (
  videos bigint,
  videos_measured bigint,
  reach bigint,
  likes bigint,
  comments bigint,
  by_platform jsonb,
  as_of date
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH mine AS (
    SELECT DISTINCT s.video_id
    FROM public.video_subjects s
    WHERE (s.subject_type = 'event' AND s.subject_id = p_event_uuid)
       OR (s.subject_type = 'agenda_entry' AND s.subject_id IN (
             SELECT a.id FROM public.events_agenda_entries a WHERE a.event_uuid = p_event_uuid))
  ),
  per_platform AS (
    SELECT p.platform, sum(ml.views) AS views
    FROM mine m
    JOIN public.video_publications p ON p.video_id = m.video_id
    JOIN public.video_metrics_latest ml ON ml.publication_id = p.id
    GROUP BY p.platform
  )
  SELECT
    (SELECT count(*) FROM mine),
    (SELECT count(*) FROM mine m JOIN public.video_reach r ON r.video_id = m.video_id WHERE r.reach IS NOT NULL),
    (SELECT coalesce(sum(r.reach), 0) FROM mine m JOIN public.video_reach r ON r.video_id = m.video_id),
    (SELECT coalesce(sum(r.likes), 0) FROM mine m JOIN public.video_reach r ON r.video_id = m.video_id),
    (SELECT coalesce(sum(r.comments), 0) FROM mine m JOIN public.video_reach r ON r.video_id = m.video_id),
    (SELECT coalesce(jsonb_object_agg(platform, views), '{}'::jsonb) FROM per_platform),
    (SELECT max(r.as_of) FROM mine m JOIN public.video_reach r ON r.video_id = m.video_id);
$$;

REVOKE ALL ON FUNCTION public.event_video_reach(uuid) FROM PUBLIC, anon;

COMMENT ON FUNCTION public.event_video_reach(uuid) IS
  'Video reach for a whole event, counting videos attached to the event AND to any of its agenda entries. The editor workflow attaches a talk recording to the agenda entry, so a rollup that only looked at direct event links would report almost nothing.';
