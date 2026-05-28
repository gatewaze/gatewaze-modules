-- ============================================================================
-- Module: event-invites
-- Migration: 005_invite_sub_events
-- Description: Add lightweight sub-events (Day Ceremony, Evening Reception,
--              Workshop A etc.) scoped to a parent event. Sub-events are NOT
--              full event records — just labels with optional times/deadlines.
--              Adds sub_event_id to invite_party_member_events and
--              invite_questions for per-sub-event assignment and questions.
-- ============================================================================

-- ==========================================================================
-- 1. invite_sub_events — lightweight sub-events per event
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.invite_sub_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  starts_at timestamptz,
  ends_at timestamptz,
  rsvp_deadline timestamptz,
  sort_order integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invite_sub_events_event ON public.invite_sub_events(event_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invite_sub_events_updated_at') THEN
    CREATE TRIGGER invite_sub_events_updated_at
      BEFORE UPDATE ON public.invite_sub_events
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

ALTER TABLE public.invite_sub_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'invite_sub_events' AND policyname = 'authenticated_all_invite_sub_events') THEN
    CREATE POLICY "authenticated_all_invite_sub_events"
      ON public.invite_sub_events FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ==========================================================================
-- 2. Add sub_event_id to invite_party_member_events
-- ==========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invite_party_member_events' AND column_name = 'sub_event_id'
  ) THEN
    ALTER TABLE public.invite_party_member_events
      ADD COLUMN sub_event_id uuid REFERENCES public.invite_sub_events(id) ON DELETE CASCADE;
    CREATE INDEX idx_invite_party_member_events_sub_event
      ON public.invite_party_member_events(sub_event_id);

    -- Update unique constraint to include sub_event_id
    ALTER TABLE public.invite_party_member_events
      DROP CONSTRAINT IF EXISTS invite_party_member_events_party_member_id_event_id_key;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_party_member_events_unique
      ON public.invite_party_member_events (party_member_id, event_id, COALESCE(sub_event_id, '00000000-0000-0000-0000-000000000000'));
  END IF;
END $$;

-- ==========================================================================
-- 3. Add sub_event_id to invite_questions
-- ==========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invite_questions' AND column_name = 'sub_event_id'
  ) THEN
    ALTER TABLE public.invite_questions
      ADD COLUMN sub_event_id uuid REFERENCES public.invite_sub_events(id) ON DELETE CASCADE;
    CREATE INDEX idx_invite_questions_sub_event
      ON public.invite_questions(sub_event_id);
  END IF;
END $$;

-- ==========================================================================
-- 4. Update views to include sub-event info
-- ==========================================================================
DROP VIEW IF EXISTS public.invite_party_detail;
CREATE OR REPLACE VIEW public.invite_party_detail AS
SELECT
  pm.id AS member_id,
  pm.party_id,
  pm.first_name,
  pm.last_name,
  pm.email,
  pm.is_lead_booker,
  pm.is_plus_one,
  pm.sort_order,
  pme.id AS member_event_id,
  pme.event_id,
  pme.sub_event_id,
  pme.rsvp_status,
  pme.rsvp_deadline,
  pme.rsvp_responded_at,
  e.event_title,
  e.event_start,
  e.event_end,
  e.event_location,
  se.name AS sub_event_name,
  se.description AS sub_event_description,
  se.starts_at AS sub_event_starts_at,
  se.ends_at AS sub_event_ends_at,
  COALESCE(pme.rsvp_deadline, se.rsvp_deadline) AS effective_deadline,
  p.token AS party_token,
  p.short_code AS party_short_code,
  p.name AS party_name,
  p.status AS party_status,
  p.max_plus_ones,
  p.plus_ones_added,
  p.version AS party_version
FROM public.invite_party_members pm
JOIN public.invite_parties p ON p.id = pm.party_id
LEFT JOIN public.invite_party_member_events pme ON pme.party_member_id = pm.id
LEFT JOIN public.events e ON e.id = pme.event_id
LEFT JOIN public.invite_sub_events se ON se.id = pme.sub_event_id;
