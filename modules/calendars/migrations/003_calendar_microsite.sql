-- ============================================================================
-- Module: calendars
-- Migration: 003_calendar_microsite
-- Description: Adds microsite + member signup fields. Per spec
--              spec-calendars-microsites.md §7.1, §7.2.
-- ============================================================================

-- ==========================================================================
-- 1. calendars: long_description for the About sub-page
-- ==========================================================================
ALTER TABLE public.calendars
  ADD COLUMN IF NOT EXISTS long_description text;

COMMENT ON COLUMN public.calendars.long_description IS
  'Long-form markdown description for the /about microsite sub-page. '
  'Falls back to description if NULL.';

-- ==========================================================================
-- 2. calendars_members: portal signup + double opt-in + unsubscribe fields
-- ==========================================================================
ALTER TABLE public.calendars_members
  ADD COLUMN IF NOT EXISTS signup_source text,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmation_token text,
  ADD COLUMN IF NOT EXISTS confirmation_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz,
  ADD COLUMN IF NOT EXISTS marketing_consent_at timestamptz;

-- Unsubscribe token: required, defaults to a random base64-ish string.
-- Adding as nullable first, backfilling, then making NOT NULL avoids
-- breaking existing rows.
--
-- Uses gen_random_uuid() twice for ~256 bits of entropy. This avoids the
-- pgcrypto dependency (gen_random_bytes) which isn't enabled on all
-- deployments; gen_random_uuid() is a core function since PG 13.
ALTER TABLE public.calendars_members
  ADD COLUMN IF NOT EXISTS unsubscribe_token text;

UPDATE public.calendars_members
SET unsubscribe_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
WHERE unsubscribe_token IS NULL;

ALTER TABLE public.calendars_members
  ALTER COLUMN unsubscribe_token SET NOT NULL,
  ALTER COLUMN unsubscribe_token SET DEFAULT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

CREATE UNIQUE INDEX IF NOT EXISTS idx_calendars_members_unsubscribe_token
  ON public.calendars_members (unsubscribe_token);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calendars_members_confirmation_token
  ON public.calendars_members (confirmation_token)
  WHERE confirmation_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calendars_members_signup_source
  ON public.calendars_members (signup_source)
  WHERE signup_source IS NOT NULL;

COMMENT ON COLUMN public.calendars_members.signup_source IS
  'How this member was added: portal_form, admin, csv, luma, invite';
COMMENT ON COLUMN public.calendars_members.confirmation_token IS
  'Cryptographically random token sent in the confirmation email. '
  'Cleared on successful confirm. NULL after confirm.';
COMMENT ON COLUMN public.calendars_members.unsubscribe_token IS
  'Permanent token for one-click unsubscribe links. Never expires.';

-- ==========================================================================
-- 3. signup_source check constraint
-- ==========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'calendars_members_signup_source_check'
  ) THEN
    ALTER TABLE public.calendars_members
      ADD CONSTRAINT calendars_members_signup_source_check
      CHECK (signup_source IS NULL OR signup_source IN ('portal_form','admin','csv','luma','invite'));
  END IF;
END $$;
