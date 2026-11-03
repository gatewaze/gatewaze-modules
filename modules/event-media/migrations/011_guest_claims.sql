-- Which phone has chosen which name.
--
-- A guest picks themselves from the invitation list; the first phone to
-- pick a name holds it, and the name no longer appears for anyone else.
-- The phone that holds a name sees and manages that guest's photos under
-- "Your photos", so switching names and back brings them all back.
-- Releasing a name ("not you?") frees it; organisers can release one
-- from the Media tab if a guest picked the wrong person.

CREATE TABLE IF NOT EXISTS public.events_media_guest_claims (
  event_id   uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  member_id  uuid NOT NULL,
  client_id  uuid NOT NULL,
  guest_name text,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_events_media_guest_claims_client
  ON public.events_media_guest_claims (event_id, client_id);

COMMENT ON TABLE public.events_media_guest_claims IS
  'Invitation guests claimed by a device on the guest photo page; one device per name.';

ALTER TABLE public.events_media_guest_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_all ON public.events_media_guest_claims;
CREATE POLICY admin_all ON public.events_media_guest_claims
  FOR ALL TO authenticated
  USING (public.can_admin_host_media('event', event_id))
  WITH CHECK (public.can_admin_host_media('event', event_id));

REVOKE ALL ON public.events_media_guest_claims FROM PUBLIC, anon;
GRANT SELECT, DELETE ON public.events_media_guest_claims TO authenticated;
GRANT ALL ON public.events_media_guest_claims TO service_role;
