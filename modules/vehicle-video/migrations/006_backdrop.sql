-- ============================================================================
-- Module: vehicle-video
-- Migration: 006_backdrop
-- Description: Configurable backdrop — re-place the car in front of a chosen
--              regional landmark (Nano Banana composite) for exterior shots.
--              backdrop on the run holds the choice; backdrop_image_path on a
--              shot holds the composited source (null = use the dealer photo).
--              Idempotent.
-- ============================================================================

ALTER TABLE public.vehicle_videos
  ADD COLUMN IF NOT EXISTS backdrop        jsonb,
  ADD COLUMN IF NOT EXISTS backdrop_status text NOT NULL DEFAULT 'idle';

ALTER TABLE public.vehicle_video_shots
  ADD COLUMN IF NOT EXISTS backdrop_image_path text;
