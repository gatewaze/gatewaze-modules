-- ============================================================================
-- Module: competitions
-- Migration: 008_legacy_parity
-- Description: Bring competitions and entries up to what this module's own
--              entry edge function, admin pages and the portal already read and
--              write (the original gatewaze-admin shape), and stop entrant and
--              winner details being readable or writable by any signed-in
--              member.
--
-- Context: the entry function inserts email, member_profile_id, referrer and
-- entry_metadata with status 'entered' and no person_id. None of those columns
-- existed, person_id was NOT NULL, and 'entered' failed the status check, so
-- every visitor entry failed. The admin tab and the portal read entries by
-- email too.
--
-- Every table touched here is empty on every brand at the time of writing.
-- ============================================================================

-- ==========================================================================
-- 1. events_competitions
-- ==========================================================================

-- The original app allowed a competition with no event; most historical
-- techtickets competitions have none.
ALTER TABLE public.events_competitions
  ALTER COLUMN event_id DROP NOT NULL;

ALTER TABLE public.events_competitions
  DROP CONSTRAINT IF EXISTS events_competitions_status_check;
ALTER TABLE public.events_competitions
  ADD CONSTRAINT events_competitions_status_check
    CHECK (status IN ('draft', 'active', 'closed', 'completed', 'cancelled'));

-- Was FOR ALL TO authenticated USING (true): any signed-in member could create,
-- rewrite or delete a competition. Reads stay open, writes are admin only.
DROP POLICY IF EXISTS "authenticated_all_events_competitions" ON public.events_competitions;

DROP POLICY IF EXISTS "auth_select_events_competitions" ON public.events_competitions;
CREATE POLICY "auth_select_events_competitions"
  ON public.events_competitions FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "admin_write_events_competitions" ON public.events_competitions;
CREATE POLICY "admin_write_events_competitions"
  ON public.events_competitions FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ==========================================================================
-- 2. events_competition_entries: entries are keyed by email
-- ==========================================================================
-- The original app identified an entrant by email, with an optional link to
-- their profile. person_id stays for new relational code but is no longer
-- required, so an entrant with no people row is still representable (about
-- 1,600 historical techtickets entrants have none).

ALTER TABLE public.events_competition_entries
  ALTER COLUMN person_id DROP NOT NULL,
  ALTER COLUMN status SET DEFAULT 'entered',
  ADD COLUMN IF NOT EXISTS email             text,
  ADD COLUMN IF NOT EXISTS member_profile_id uuid,
  ADD COLUMN IF NOT EXISTS referrer          text,
  ADD COLUMN IF NOT EXISTS viewed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at        timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS entry_metadata    jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.events_competition_entries.email IS
  'Entrant email, lowercased. The original identity of an entry.';
COMMENT ON COLUMN public.events_competition_entries.referrer IS
  'Where the entry came from (the request source)';
COMMENT ON COLUMN public.events_competition_entries.entry_metadata IS
  'Free-form metadata supplied with the entry';

ALTER TABLE public.events_competition_entries
  DROP CONSTRAINT IF EXISTS events_competition_entries_status_check;
ALTER TABLE public.events_competition_entries
  ADD CONSTRAINT events_competition_entries_status_check
    CHECK (status IN ('active', 'winner', 'disqualified', 'viewed', 'entered', 'won'));

ALTER TABLE public.events_competition_entries
  DROP CONSTRAINT IF EXISTS events_competition_entries_identity_check;
ALTER TABLE public.events_competition_entries
  ADD CONSTRAINT events_competition_entries_identity_check
    CHECK (person_id IS NOT NULL OR email IS NOT NULL);

-- One entry per address per competition. The entry function checks first,
-- this makes the check race-safe.
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_competition_entries_comp_email
  ON public.events_competition_entries (competition_id, lower(email))
  WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_competition_entries_email
  ON public.events_competition_entries (lower(email)) WHERE email IS NOT NULL;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'people_profiles')
     AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'events_competition_entries_member_profile_id_fkey') THEN
    ALTER TABLE public.events_competition_entries
      ADD CONSTRAINT events_competition_entries_member_profile_id_fkey
      FOREIGN KEY (member_profile_id) REFERENCES public.people_profiles(id) ON DELETE SET NULL;
  END IF;
END $$;

DROP TRIGGER IF EXISTS events_competition_entries_updated_at ON public.events_competition_entries;
CREATE TRIGGER events_competition_entries_updated_at
  BEFORE UPDATE ON public.events_competition_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Entries were readable by ANY anonymous visitor (anon USING (true)) and
-- readable and writable by every signed-in member. With the email column that
-- would publish every entrant's address. Admins see everything; a member sees
-- only their own entries, which is all the portal asks for ("have I entered").
-- New entries arrive through the entry edge function on the service role.
DROP POLICY IF EXISTS "anon_select_events_competition_entries"       ON public.events_competition_entries;
DROP POLICY IF EXISTS "authenticated_all_events_competition_entries" ON public.events_competition_entries;

DROP POLICY IF EXISTS "events_competition_entries_admin_all" ON public.events_competition_entries;
CREATE POLICY "events_competition_entries_admin_all"
  ON public.events_competition_entries FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "events_competition_entries_select_own" ON public.events_competition_entries;
CREATE POLICY "events_competition_entries_select_own"
  ON public.events_competition_entries FOR SELECT TO authenticated
  USING (email IS NOT NULL
         AND lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

REVOKE ALL ON public.events_competition_entries FROM anon;

-- ==========================================================================
-- 3. events_competition_winners
-- ==========================================================================
-- Was FOR ALL TO authenticated USING (true). Winners hold names, emails and
-- photos; nothing outside the admin reads them directly
-- (events_get_total_competition_value is SECURITY DEFINER).
DROP POLICY IF EXISTS "authenticated_all_events_competition_winners" ON public.events_competition_winners;

DROP POLICY IF EXISTS "events_competition_winners_admin_all" ON public.events_competition_winners;
CREATE POLICY "events_competition_winners_admin_all"
  ON public.events_competition_winners FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

REVOKE ALL ON public.events_competition_winners FROM anon;
