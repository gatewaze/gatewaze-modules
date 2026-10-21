-- ============================================================================
-- Module: videos
-- Migration: 016_studio
-- Description: the studio pass over one uploaded video.
--
-- After a master is uploaded, a worker samples it, scores frames with a
-- vision model, cuts the speaker out, picks slide panels, drafts headlines,
-- and the editor then chooses, trims, adds the pre-roll card and approves.
-- One row per video holds the whole conversation between the worker and the
-- editor: what the worker found (analysis), what the model drafted
-- (headlines), what the editor chose (selection), and what the approval
-- produced (outputs). Keeping it as one row with jsonb columns rather than
-- five tables is deliberate: the shape is still moving, every read wants all
-- of it, and nothing joins to the inside of it.
--
-- Additive.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.video_studio (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL UNIQUE REFERENCES public.videos(id) ON DELETE CASCADE,
  -- The master the analysis was run on. A re-upload after analysis makes
  -- the analysis stale; the UI compares this to the current ready master.
  master_asset_id uuid REFERENCES public.video_assets(id) ON DELETE SET NULL,

  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'analysing', 'ready', 'finalising', 'approved', 'failed')),
  -- A short line of progress for the UI while the worker runs.
  progress text,
  error text,

  -- What the worker found: frames, cut-outs, panels, layout, duration.
  analysis jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Headline drafts: [{lead, emph}].
  headlines jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The editor's choices. Allowlisted by the API; never req.body.
  selection jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What approval produced: asset ids and URLs.
  outputs jsonb NOT NULL DEFAULT '{}'::jsonb,

  requested_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS video_studio_state ON public.video_studio (state)
  WHERE state IN ('queued', 'analysing', 'finalising');

COMMENT ON TABLE public.video_studio IS
  'One studio pass per video: the analysis the worker made, the headlines drafted, the editor''s selection, and what approval produced.';

-- The studio writes a cut master and a thumbnail; both are assets of a new
-- provenance. The thumbnail lives in the public media bucket like every
-- other thumbnail; the cut master goes wherever masters go.
ALTER TABLE public.video_assets DROP CONSTRAINT IF EXISTS video_assets_source_check;
ALTER TABLE public.video_assets
  ADD CONSTRAINT video_assets_source_check
  CHECK (source IN ('upload', 'youtube_import', 'recap', 'drive_import', 'bucket_import', 'studio'));

-- updated_at, same trigger function as the other tables in this module.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'video_studio_touch_updated_at') THEN
    CREATE TRIGGER video_studio_touch_updated_at
      BEFORE UPDATE ON public.video_studio
      FOR EACH ROW EXECUTE FUNCTION public.videos_touch_updated_at();
  END IF;
END $$;

-- RLS: read scoped to the video's owning subject, the same predicate every
-- other table here uses. Writes are service-role only, through the module
-- API, which authorises as the caller first.
ALTER TABLE public.video_studio ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='video_studio' AND policyname='video_studio_select') THEN
    CREATE POLICY video_studio_select ON public.video_studio
      FOR SELECT TO authenticated
      USING (public.can_edit_video(video_id));
  END IF;
END $$;
