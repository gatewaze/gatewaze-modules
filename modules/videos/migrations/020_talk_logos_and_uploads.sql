-- ============================================================================
-- Module: videos
-- Migration: 020_talk_logos_and_uploads
-- Description: a company logo per talk, and the studio's own uploads.
--
-- The logo on a thumbnail is the company the talk was given for, which is
-- not a property of the person: the same speaker talks for different
-- companies at different events. So the uploaded logo hangs off the unit
-- the video is attached to (an agenda entry, an episode), not off the
-- speaker or the person, and a later upload for the same talk replaces it.
--
-- pending_uploads on the studio row is the short list of signed uploads
-- minted for it that have not been completed yet, so `complete` only
-- accepts a path this row asked for.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.video_talk_logos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('agenda_entry', 'podcast_episode', 'talk')),
  subject_id uuid NOT NULL,
  storage_bucket text NOT NULL DEFAULT 'media',
  storage_path text NOT NULL,
  filename text,
  mime_type text,
  bytes integer,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id)
);

COMMENT ON TABLE public.video_talk_logos IS
  'The company logo shown on a talk''s thumbnail. Per talk, not per speaker: a person speaks for different companies.';

ALTER TABLE public.video_studio
  ADD COLUMN IF NOT EXISTS pending_uploads jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'video_talk_logos_touch_updated_at') THEN
    CREATE TRIGGER video_talk_logos_touch_updated_at
      BEFORE UPDATE ON public.video_talk_logos
      FOR EACH ROW EXECUTE FUNCTION public.videos_touch_updated_at();
  END IF;
END $$;

-- Readable by whoever may edit videos for the talk's event or podcast;
-- written by the module API as the service role.
ALTER TABLE public.video_talk_logos ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='video_talk_logos' AND policyname='video_talk_logos_select') THEN
    CREATE POLICY video_talk_logos_select ON public.video_talk_logos
      FOR SELECT TO authenticated
      USING (
        public.is_admin()
        OR (subject_type = 'agenda_entry' AND public.can_edit_videos_for_unit('event', subject_id))
        OR (subject_type = 'podcast_episode' AND public.can_edit_videos_for_unit('podcast', subject_id))
      );
  END IF;
END $$;
