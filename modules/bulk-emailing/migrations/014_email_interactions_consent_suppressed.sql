-- ============================================================================
-- Module: bulk-emailing
-- Migration: 014_email_interactions_consent_suppressed
-- Description: Add the consent_suppressed flag to email_interactions that
-- newsletter geo engagement RPCs (newsletters 050-053) reference but no
-- prior migration ever created. The column was present on dev/localhost
-- (hand-applied during iteration) so the geo migrations passed locally;
-- on AAIF prod 2026-06-23 the 051 materialised view + 050/052/053 RPCs all
-- threw "column ei.consent_suppressed does not exist".
--
-- Semantics: when true, this event still aggregates into total/anonymised
-- block + edition metrics, but is NEVER attributed to the individual
-- (per-persona reporting filters it out). Mirrors the opt-in posture of
-- personalization_consent added by 007.
-- ============================================================================

ALTER TABLE public.email_interactions
  ADD COLUMN IF NOT EXISTS consent_suppressed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.email_interactions.consent_suppressed IS
  'When true, this interaction is excluded from per-persona reports but still counts toward aggregate block/edition metrics. Default false (no suppression).';
