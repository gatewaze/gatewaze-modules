-- ============================================================================
-- Module: videos
-- Migration: 013_podcast_subject
-- Description: Let a video belong to a whole podcast, which the assign
--              function has claimed to allow since 010 and the table has
--              refused the whole time.
-- ============================================================================
--
-- video_subjects.subject_type has allowed 'agenda_entry', 'event',
-- 'podcast_episode', 'talk' and 'person' since 007. It has never allowed
-- 'podcast'. assign_video_subject(), added in 010, validates its argument
-- against a list that DOES include 'podcast', so the two disagreed: the
-- function accepted the value, built the row, and the table's CHECK rejected
-- it. The caller got a raw constraint violation from the last statement of a
-- function that had already told them the value was fine.
--
-- Nothing had hit it yet because no podcast existed to assign to. The triage
-- screen offers "the whole podcast" as a choice, so it would have been the
-- first thing an operator tried.
--
-- Widening the table rather than narrowing the function, because a video that
-- belongs to a show rather than to one episode is a real thing: a trailer or
-- a show-level promo. videos.kind already allows 'trailer' for exactly that.
-- The rollups in 011 group by (subject_type, subject_id) without naming the
-- types, so they need no change.

SET statement_timeout = '60s';

ALTER TABLE public.video_subjects
  DROP CONSTRAINT IF EXISTS video_subjects_subject_type_check;

ALTER TABLE public.video_subjects
  ADD CONSTRAINT video_subjects_subject_type_check
  CHECK (subject_type IN (
    'event',
    'agenda_entry',
    'talk',
    'person',
    'podcast',
    'podcast_episode'
  ));

COMMENT ON COLUMN public.video_subjects.subject_type IS
  'What the video is about. An episode or an agenda entry is the usual answer and the one the rollups are most useful at. The coarser ''podcast'' and ''event'' are for material that belongs to the whole thing rather than one item of it, such as a trailer or a highlights reel. Keep this list in step with assign_video_subject(); they disagreed between migrations 010 and 013, and the function was the one telling the truth.';
