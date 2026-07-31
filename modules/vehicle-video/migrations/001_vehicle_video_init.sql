-- ============================================================================
-- Module: vehicle-video
-- Migration: 001_vehicle_video_init
-- Description: Core tables for the Vehicle Video pipeline — vehicle_videos (one
--              run) and vehicle_video_shots (one clip from one chosen image),
--              plus RLS, indexes, and updated_at triggers.
-- Spec: gatewaze-environments/specs/spec-vehicle-video-module.md §5
-- Idempotent; safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.vehicle_videos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  input_mode        text NOT NULL CHECK (input_mode IN ('url','upload')),
  source_url        text CHECK (source_url IS NULL OR length(source_url) <= 2048),
  -- resolved market; FREE-FORM string for AI interpretation (not a controlled vocab)
  market            text,
  -- identification / details (from the Auto Trader listing or the AI). Shape §5.1.
  vehicle           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- ALL normalised gallery images (uncapped); storage keys relative to the media bucket
  photo_paths       text[] NOT NULL DEFAULT '{}',
  -- style step (inferred, operator-overridable). Shapes §5.3 / §5.4.
  style_profile     jsonb,
  shot_plan         jsonb,
  -- script recipe final_output. Shape §5.2.
  storyboard        jsonb,
  script_status     text NOT NULL DEFAULT 'pending'
                      CHECK (script_status IN (
                        'pending','uploading','scraping','styling','scripting',
                        'ready_for_review','plan_approved','failed')),
  -- approval gate
  approved_by       uuid,
  plan_approved_at  timestamptz,
  -- video build
  video_status      text NOT NULL DEFAULT 'idle'
                      CHECK (video_status IN (
                        'idle','clips_in_progress','ready_to_finalize','finalizing',
                        'complete','failed')),
  -- resolved { veo_model, voice, pacing, camera_energy } snapshot (immutable for the run)
  video_config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  voiceover_text    text,
  video_path        text,
  cost_micro_usd    bigint NOT NULL DEFAULT 0,
  -- structured error { code, phase, message, at } — never a bare string (§11)
  error             jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.vehicle_videos IS
  'One Vehicle Video run: an Auto Trader listing (or uploaded photos) → styled, curated, per-shot AI video → final MP4.';

CREATE INDEX IF NOT EXISTS idx_vehicle_videos_script_status ON public.vehicle_videos (script_status);
CREATE INDEX IF NOT EXISTS idx_vehicle_videos_video_status  ON public.vehicle_videos (video_status);
CREATE INDEX IF NOT EXISTS idx_vehicle_videos_created_at    ON public.vehicle_videos (created_at DESC);

CREATE TABLE IF NOT EXISTS public.vehicle_video_shots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_video_id  uuid NOT NULL REFERENCES public.vehicle_videos(id) ON DELETE CASCADE,
  seq               integer NOT NULL CHECK (seq >= 0),          -- playback order
  beat              text NOT NULL,                              -- plan beat this shot fulfils
  part              text,                                       -- coarse part-of-car (controlled vocab)
  photo_path        text NOT NULL,                             -- chosen source image
  alt_photo_paths   text[] NOT NULL DEFAULT '{}',              -- other good images of the same beat
  scene_title       text CHECK (scene_title IS NULL OR length(scene_title) <= 120),
  narration         text CHECK (narration IS NULL OR length(narration) <= 600),
  camera_prompt     text CHECK (camera_prompt IS NULL OR length(camera_prompt) <= 400),
  kept              boolean NOT NULL DEFAULT true,             -- operator can drop a shot pre-spend
  -- Veo clip lifecycle (resumable)
  veo_prompt        text,
  veo_operation     text,
  clip_path         text,
  clip_duration_s   numeric,
  clip_status       text NOT NULL DEFAULT 'planned'
                      CHECK (clip_status IN ('planned','prompting','submitted','polling','generated','failed')),
  approval_status   text NOT NULL DEFAULT 'pending'
                      CHECK (approval_status IN ('pending','approved','rejected')),
  regen_count       integer NOT NULL DEFAULT 0,
  current_alt_index integer NOT NULL DEFAULT 0,                -- next alt_photo_paths index for regen cycling
  error             jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_video_id, seq)
);

COMMENT ON TABLE public.vehicle_video_shots IS
  'One shot of a Vehicle Video run: one ~8s AI clip built from one chosen source image, approved individually.';

CREATE INDEX IF NOT EXISTS idx_vehicle_video_shots_run ON public.vehicle_video_shots (vehicle_video_id, seq);

-- updated_at triggers (shared platform helper, as videos/daily-briefing use).
DROP TRIGGER IF EXISTS vehicle_videos_updated_at ON public.vehicle_videos;
CREATE TRIGGER vehicle_videos_updated_at
  BEFORE UPDATE ON public.vehicle_videos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS vehicle_video_shots_updated_at ON public.vehicle_video_shots;
CREATE TRIGGER vehicle_video_shots_updated_at
  BEFORE UPDATE ON public.vehicle_video_shots
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: writes are service-role only (the module drives everything through the
-- service-role client from the API/worker). Admin reads are gated by the
-- vehicle-video feature at the route layer.
ALTER TABLE public.vehicle_videos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_video_shots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vehicle_videos_service ON public.vehicle_videos;
CREATE POLICY vehicle_videos_service ON public.vehicle_videos
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS vehicle_video_shots_service ON public.vehicle_video_shots;
CREATE POLICY vehicle_video_shots_service ON public.vehicle_video_shots
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
