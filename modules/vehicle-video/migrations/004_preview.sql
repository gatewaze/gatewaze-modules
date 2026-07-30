-- ============================================================================
-- Module: vehicle-video
-- Migration: 004_preview
-- Description: Free (no-Veo) Ken Burns motion preview — store the preview MP4
--              path + its status on the run. Idempotent.
-- ============================================================================

ALTER TABLE public.vehicle_videos
  ADD COLUMN IF NOT EXISTS preview_path   text,
  ADD COLUMN IF NOT EXISTS preview_status text NOT NULL DEFAULT 'idle';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vehicle_videos_preview_status_check'
  ) THEN
    ALTER TABLE public.vehicle_videos
      ADD CONSTRAINT vehicle_videos_preview_status_check
      CHECK (preview_status IN ('idle','generating','ready','failed'));
  END IF;
END $$;
