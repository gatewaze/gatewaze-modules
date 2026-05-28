-- ============================================================================
-- Module: event-invites
-- Migration: 002_event_invite_tables
-- Description: Create the event_invites, event_invite_batches,
--              event_invite_interactions tables and the
--              event_invites_with_details view.
-- ============================================================================

-- ==========================================================================
-- 1. Invite batches
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.event_invite_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  name text,
  total_invites integer DEFAULT 0,
  sent_count integer DEFAULT 0,
  accepted_count integer DEFAULT 0,
  declined_count integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_invite_batches_event
  ON public.event_invite_batches(event_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'event_invite_batches_updated_at') THEN
    CREATE TRIGGER event_invite_batches_updated_at
      BEFORE UPDATE ON public.event_invite_batches
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ==========================================================================
-- 2. Event invites
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.event_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  email text NOT NULL,
  first_name text,
  last_name text,
  people_profile_id uuid REFERENCES public.people_profiles(id),
  registration_id uuid REFERENCES public.events_registrations(id) ON DELETE SET NULL,
  token varchar(64) UNIQUE NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'opened', 'accepted', 'declined', 'expired', 'cancelled')),
  rsvp_response text CHECK (rsvp_response IN ('yes', 'no', 'maybe')),
  rsvp_message text,
  rsvp_responded_at timestamptz,
  sent_at timestamptz,
  opened_at timestamptz,
  expires_at timestamptz,
  total_clicks integer DEFAULT 0,
  last_clicked_at timestamptz,
  batch_id uuid REFERENCES public.event_invite_batches(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, email)
);

CREATE INDEX IF NOT EXISTS idx_event_invites_event
  ON public.event_invites(event_id);
CREATE INDEX IF NOT EXISTS idx_event_invites_token
  ON public.event_invites(token);
CREATE INDEX IF NOT EXISTS idx_event_invites_email
  ON public.event_invites(email);
CREATE INDEX IF NOT EXISTS idx_event_invites_batch
  ON public.event_invites(batch_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'event_invites_updated_at') THEN
    CREATE TRIGGER event_invites_updated_at
      BEFORE UPDATE ON public.event_invites
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- ==========================================================================
-- 3. Invite interactions (click/open tracking)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.event_invite_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id uuid NOT NULL REFERENCES public.event_invites(id) ON DELETE CASCADE,
  interaction_type text NOT NULL,
  ip_address inet,
  user_agent text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_invite_interactions_invite
  ON public.event_invite_interactions(invite_id, created_at DESC);

-- ==========================================================================
-- 4. Details view (joins event + profile + batch info)
-- ==========================================================================
CREATE OR REPLACE VIEW public.event_invites_with_details AS
SELECT
  i.*,
  e.event_title,
  e.event_start,
  e.event_end,
  e.event_location,
  pp.first_name AS profile_first_name,
  pp.last_name AS profile_last_name,
  pp.company AS profile_company,
  pp.job_title AS profile_job_title,
  b.name AS batch_name
FROM public.event_invites i
LEFT JOIN public.events e ON e.id = i.event_id
LEFT JOIN public.people_profiles_with_people pp ON pp.id = i.people_profile_id
LEFT JOIN public.event_invite_batches b ON b.id = i.batch_id;

-- ==========================================================================
-- 5. RLS
-- ==========================================================================
ALTER TABLE public.event_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_invite_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_invite_interactions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_invites' AND policyname = 'auth_all_event_invites') THEN
    CREATE POLICY "auth_all_event_invites"
      ON public.event_invites FOR ALL TO authenticated
      USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_invite_batches' AND policyname = 'auth_all_event_invite_batches') THEN
    CREATE POLICY "auth_all_event_invite_batches"
      ON public.event_invite_batches FOR ALL TO authenticated
      USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_invite_interactions' AND policyname = 'auth_all_event_invite_interactions') THEN
    CREATE POLICY "auth_all_event_invite_interactions"
      ON public.event_invite_interactions FOR ALL TO authenticated
      USING (true) WITH CHECK (true);
  END IF;

  -- Allow anon access for the RSVP edge function (token-based, no auth)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_invites' AND policyname = 'anon_select_event_invites') THEN
    CREATE POLICY "anon_select_event_invites"
      ON public.event_invites FOR SELECT TO anon
      USING (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_invites' AND policyname = 'anon_update_event_invites') THEN
    CREATE POLICY "anon_update_event_invites"
      ON public.event_invites FOR UPDATE TO anon
      USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'event_invite_interactions' AND policyname = 'anon_insert_event_invite_interactions') THEN
    CREATE POLICY "anon_insert_event_invite_interactions"
      ON public.event_invite_interactions FOR INSERT TO anon
      WITH CHECK (true);
  END IF;
END $$;
