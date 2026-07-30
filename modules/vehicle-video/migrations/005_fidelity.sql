-- ============================================================================
-- Module: vehicle-video
-- Migration: 005_fidelity
-- Description: Strict-fidelity signals per shot — when a clip's camera move had
--              to be reduced to a safe minimal one (a single photo can't support
--              the fuller shot without inventing detail), flag it so the operator
--              knows to add more angles. Idempotent.
-- ============================================================================

ALTER TABLE public.vehicle_video_shots
  ADD COLUMN IF NOT EXISTS fidelity_note     text,
  ADD COLUMN IF NOT EXISTS needs_more_images boolean NOT NULL DEFAULT false;
