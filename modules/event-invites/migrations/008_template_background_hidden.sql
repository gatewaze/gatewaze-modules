-- ============================================================================
-- Module: event-invites
-- Migration: 008_template_background_hidden
-- Description: Adds pdf_background_hidden flag to invite_templates so a
--              background PDF can be used as a positioning guide in the editor
--              but omitted from the final generated PDF (same page size).
-- ============================================================================

ALTER TABLE public.invite_templates
  ADD COLUMN IF NOT EXISTS pdf_background_hidden boolean NOT NULL DEFAULT false;
