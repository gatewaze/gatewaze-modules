-- 003: Cvent sync ledger and the read helpers behind the worker and admin tab.
--
-- Replaces the never-declared 002 (a pg_net trigger on the pre-rename
-- `customers` table that needed a service-role key in Vault). Sync now runs
-- from the worker on a schedule, so the database holds no credentials and no
-- outbound HTTP. Idempotent: safe to re-run.

-- One row per registration that has been attempted against Cvent.
CREATE TABLE IF NOT EXISTS public.cvent_registration_sync (
  registration_id    uuid PRIMARY KEY REFERENCES public.events_registrations(id) ON DELETE CASCADE,
  event_id           uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  person_id          uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  status             text NOT NULL CHECK (status IN ('synced', 'failed')),
  cvent_contact_id   text,
  cvent_attendee_id  text,
  -- sha256 of the badge fields last pushed (email, first, last, title, company).
  badge_hash         text,
  attempts           integer NOT NULL DEFAULT 0,
  last_error         text,
  synced_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cvent_registration_sync_event_status
  ON public.cvent_registration_sync (event_id, status);
CREATE INDEX IF NOT EXISTS idx_cvent_registration_sync_person
  ON public.cvent_registration_sync (person_id);

DROP TRIGGER IF EXISTS cvent_registration_sync_updated_at ON public.cvent_registration_sync;
CREATE TRIGGER cvent_registration_sync_updated_at
  BEFORE UPDATE ON public.cvent_registration_sync
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Written only by the worker and the module's API routes (service role).
-- Admins may read it; nobody else sees it.
ALTER TABLE public.cvent_registration_sync ENABLE ROW LEVEL SECURITY;
-- Supabase's default privileges hand every table right to anon and
-- authenticated; keep only SELECT for authenticated (the admin read policy).
REVOKE ALL ON public.cvent_registration_sync FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cvent_registration_sync TO authenticated;
DROP POLICY IF EXISTS cvent_registration_sync_admin_read ON public.cvent_registration_sync;
CREATE POLICY cvent_registration_sync_admin_read ON public.cvent_registration_sync
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- Active registrations that still need a push: never attempted, or failed and
-- due for a retry (backoff doubles per attempt, capped at a day).
DROP FUNCTION IF EXISTS public.cvent_pending_registrations(uuid, integer, integer);
CREATE OR REPLACE FUNCTION public.cvent_pending_registrations(
  p_event_id uuid,
  p_limit integer DEFAULT 100,
  p_max_attempts integer DEFAULT 5
)
RETURNS TABLE (
  registration_id uuid,
  person_id uuid,
  email text,
  attributes jsonb,
  attempts integer
)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT r.id, r.person_id, p.email, p.attributes, COALESCE(s.attempts, 0)
  FROM public.events_registrations r
  JOIN public.people p ON p.id = r.person_id
  LEFT JOIN public.cvent_registration_sync s ON s.registration_id = r.id
  WHERE r.event_id = p_event_id
    AND r.status IN ('confirmed', 'pending', 'waitlist', 'waitlisted', 'attended')
    AND p.email IS NOT NULL AND p.email <> ''
    AND (
      s.registration_id IS NULL
      OR (
        s.status = 'failed'
        AND s.attempts < p_max_attempts
        AND s.updated_at < now() - make_interval(mins => LEAST(power(2, s.attempts), 1440)::integer)
      )
    )
  ORDER BY r.registered_at ASC, r.id ASC
  LIMIT GREATEST(COALESCE(p_limit, 100), 1)
$$;

-- Synced registrations whose person row changed after the last push.
DROP FUNCTION IF EXISTS public.cvent_changed_contacts(uuid, integer);
CREATE OR REPLACE FUNCTION public.cvent_changed_contacts(
  p_event_id uuid,
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  registration_id uuid,
  person_id uuid,
  email text,
  attributes jsonb,
  badge_hash text,
  cvent_contact_id text
)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT s.registration_id, s.person_id, p.email, p.attributes, s.badge_hash, s.cvent_contact_id
  FROM public.cvent_registration_sync s
  JOIN public.people p ON p.id = s.person_id
  WHERE s.event_id = p_event_id
    AND s.status = 'synced'
    AND s.synced_at IS NOT NULL
    AND p.updated_at > s.synced_at
  ORDER BY p.updated_at ASC
  LIMIT GREATEST(COALESCE(p_limit, 100), 1)
$$;

-- Counts for the admin tab.
DROP FUNCTION IF EXISTS public.cvent_event_sync_status(uuid);
CREATE OR REPLACE FUNCTION public.cvent_event_sync_status(p_event_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  WITH active AS (
    SELECT r.id
    FROM public.events_registrations r
    WHERE r.event_id = p_event_id
      AND r.status IN ('confirmed', 'pending', 'waitlist', 'waitlisted', 'attended')
  ),
  ledger AS (
    SELECT s.status, count(*) AS c
    FROM public.cvent_registration_sync s
    JOIN active a ON a.id = s.registration_id
    GROUP BY s.status
  )
  SELECT jsonb_build_object(
    'active',  (SELECT count(*) FROM active),
    'synced',  COALESCE((SELECT c FROM ledger WHERE status = 'synced'), 0),
    'failed',  COALESCE((SELECT c FROM ledger WHERE status = 'failed'), 0),
    'pending', (SELECT count(*) FROM active) - COALESCE((SELECT sum(c) FROM ledger), 0),
    'last_synced_at', (SELECT max(synced_at) FROM public.cvent_registration_sync WHERE event_id = p_event_id),
    'last_error', (
      SELECT last_error FROM public.cvent_registration_sync
      WHERE event_id = p_event_id AND last_error IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1
    )
  )
$$;

-- Only the service role (worker + module API routes) calls these. Supabase's
-- default privileges would otherwise hand EXECUTE to anon and authenticated.
REVOKE ALL ON FUNCTION public.cvent_pending_registrations(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cvent_changed_contacts(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cvent_event_sync_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cvent_pending_registrations(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cvent_changed_contacts(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cvent_event_sync_status(uuid) TO service_role;

-- Legacy: the pre-rename pg_net trigger function (and its trigger, where one
-- was ever created). It referenced tables that no longer exist.
DROP FUNCTION IF EXISTS public.sync_customer_to_cvent() CASCADE;

COMMENT ON TABLE public.cvent_registration_sync IS
  'Cvent module: one row per registration pushed to Cvent, with the badge fields last sent and the retry state.';
