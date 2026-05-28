-- ============================================================================
-- Module: event-invites
-- Migration: 010_invite_open_links
-- Description: Self-serve RSVP links. Admins generate a single shareable link
--              scoped to an event (optionally a specific sub-event). Anyone
--              with the link can register their own party and submit their
--              RSVP + follow-up answers without needing a pre-created invite.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.invite_open_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  -- Optional sub-event scope. NULL = the link applies to all sub-events
  -- (the guest will pick which ones they're attending). Non-null = the link
  -- pre-selects that single sub-event.
  sub_event_id uuid REFERENCES public.invite_sub_events(id) ON DELETE CASCADE,
  -- Short, URL-friendly code (used as /o/{short_code})
  short_code text NOT NULL UNIQUE,
  label text,                              -- admin-facing label, e.g. "Venue flyer"
  is_active boolean NOT NULL DEFAULT true,
  -- Guest limits
  max_members_per_party integer DEFAULT 10,
  -- Aggregate stats for admin visibility
  times_used integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  -- Optional expiry
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invite_open_links_event
  ON public.invite_open_links(event_id);
CREATE INDEX IF NOT EXISTS idx_invite_open_links_short_code
  ON public.invite_open_links(short_code);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invite_open_links_updated_at') THEN
    CREATE TRIGGER invite_open_links_updated_at
      BEFORE UPDATE ON public.invite_open_links
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- Mark the source open link on parties created through it, so admins can
-- trace a party back to the link that spawned it. NULL = party created
-- via the normal admin flow.
ALTER TABLE public.invite_parties
  ADD COLUMN IF NOT EXISTS open_link_id uuid REFERENCES public.invite_open_links(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invite_parties_open_link
  ON public.invite_parties(open_link_id);

-- RLS: authenticated users (admin) can manage links; anonymous reads are
-- done through the edge function using the service role key, so we don't
-- need a public read policy here.
ALTER TABLE public.invite_open_links ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'invite_open_links'
      AND policyname = 'authenticated_all_invite_open_links'
  ) THEN
    CREATE POLICY "authenticated_all_invite_open_links"
      ON public.invite_open_links FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;
