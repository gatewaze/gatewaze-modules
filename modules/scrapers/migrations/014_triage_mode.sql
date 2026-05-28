-- Add triage_mode column to scrapers. Value NULL means "use module-level
-- default" (see content-triage module config). When content-triage isn't
-- installed, producers treat NULL as auto_publish.
ALTER TABLE public.scrapers
  ADD COLUMN IF NOT EXISTS triage_mode text
  CHECK (triage_mode IS NULL OR triage_mode IN ('auto_publish','auto_approve','review'));

COMMENT ON COLUMN public.scrapers.triage_mode IS
  'Per-scraper override for content-triage mode. NULL = use module default. Values: auto_publish | auto_approve | review.';
