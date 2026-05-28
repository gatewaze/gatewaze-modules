-- ============================================================================
-- Module: conversations
-- Migration: 003_username_column
-- Description: Adds the per-brand-unique username column to people_profiles,
--              owned by the conversations module. Used for @-mentions.
--              Per spec-conversations-module.md §4.1.
-- ============================================================================

ALTER TABLE public.people_profiles
  ADD COLUMN IF NOT EXISTS username text;

-- Per-brand uniqueness (decision Q2 in spec). people_profiles.brand_id is
-- expected to exist on the core platform schema.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='people_profiles' AND column_name='brand_id'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_people_profiles_username_unique
      ON public.people_profiles (brand_id, lower(username))
      WHERE username IS NOT NULL;
  ELSE
    -- Fallback: global uniqueness if brand_id isn't on people_profiles
    -- (single-brand deployments)
    CREATE UNIQUE INDEX IF NOT EXISTS idx_people_profiles_username_unique
      ON public.people_profiles (lower(username))
      WHERE username IS NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_people_profiles_username_lookup
  ON public.people_profiles (lower(username))
  WHERE username IS NOT NULL;

-- Validation trigger: enforce 3-32 chars, alphanumeric + underscore,
-- not starting with a digit, against a reserved-word block list.
CREATE OR REPLACE FUNCTION public.validate_username()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_lower text;
  v_reserved text[] := ARRAY[
    'admin','administrator','system','moderator','mod','everyone','here',
    'channel','bot','support','help','staff','team','official','root',
    'api','www','mail','ftp','test','null','undefined'
  ];
BEGIN
  IF NEW.username IS NULL THEN
    RETURN NEW;
  END IF;

  v_lower := lower(NEW.username);

  IF length(NEW.username) < 3 OR length(NEW.username) > 32 THEN
    RAISE EXCEPTION 'Username must be 3-32 characters';
  END IF;

  IF NEW.username !~ '^[a-zA-Z][a-zA-Z0-9_]+$' THEN
    RAISE EXCEPTION 'Username must contain only letters, digits, and underscores, and start with a letter';
  END IF;

  IF v_lower = ANY(v_reserved) THEN
    RAISE EXCEPTION 'Username "%" is reserved', NEW.username;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS people_profiles_validate_username ON public.people_profiles;
CREATE TRIGGER people_profiles_validate_username
  BEFORE INSERT OR UPDATE OF username ON public.people_profiles
  FOR EACH ROW
  WHEN (NEW.username IS NOT NULL)
  EXECUTE FUNCTION public.validate_username();

-- DM policy column (per spec §4.7)
ALTER TABLE public.people_profiles
  ADD COLUMN IF NOT EXISTS dm_policy text NOT NULL DEFAULT 'shared_calendars'
  CHECK (dm_policy IN ('shared_calendars','nobody','mods_only','everyone'));

COMMENT ON COLUMN public.people_profiles.username IS
  'Per-brand unique handle used for @-mentions in conversations. Owned by the conversations module.';

COMMENT ON COLUMN public.people_profiles.dm_policy IS
  'Who can DM this person: shared_calendars (default), nobody, mods_only, everyone';
