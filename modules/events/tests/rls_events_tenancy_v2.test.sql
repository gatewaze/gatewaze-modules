-- pgTAP test for the events module's tenancy_v2 dual-track RLS
-- (010_tenancy_v2.sql). Sets up two accounts, one event per account,
-- one registration per event. Verifies:
--   * with the flag off, the legacy "all authenticated see all events"
--     behaviour is preserved;
--   * with the flag on, members of account A see only A's event;
--   * super-admins see everything regardless;
--   * registrations follow their parent event's account scoping.

BEGIN;

SELECT plan(8);

-- ==========================================================================
-- Setup
-- ==========================================================================

INSERT INTO auth.users (id, email, role, aud, instance_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice@a.example', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('22222222-2222-2222-2222-222222222222', 'bob@b.example',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('33333333-3333-3333-3333-333333333333', 'super@example',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

INSERT INTO public.accounts (id, name) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Account A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Account B');

INSERT INTO public.accounts_users (account_id, user_id, role) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'member'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'member');

INSERT INTO public.admin_profiles (id, user_id, email, name, role, is_active) VALUES
  ('99999999-9999-9999-9999-999999999999', '33333333-3333-3333-3333-333333333333', 'super@example', 'Super', 'super_admin', true);

INSERT INTO public.events (id, event_id, event_title, account_id) VALUES
  ('eeeeeeee-aaaa-aaaa-aaaa-eeeeeeeeeeee', 'evt-aaa', 'Account A Event', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('eeeeeeee-bbbb-bbbb-bbbb-eeeeeeeeeeee', 'evt-bbb', 'Account B Event', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

-- One person per account so we have a person_id for the registrations.
INSERT INTO public.people (id, auth_user_id, email, account_id) VALUES
  ('cccccccc-1111-1111-1111-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'alice@a.example', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('cccccccc-2222-2222-2222-cccccccccccc', '22222222-2222-2222-2222-222222222222', 'bob@b.example',   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

INSERT INTO public.events_registrations (id, event_id, person_id, status) VALUES
  ('11111111-aaaa-aaaa-aaaa-111111111111', 'eeeeeeee-aaaa-aaaa-aaaa-eeeeeeeeeeee', 'cccccccc-1111-1111-1111-cccccccccccc', 'confirmed'),
  ('22222222-bbbb-bbbb-bbbb-222222222222', 'eeeeeeee-bbbb-bbbb-bbbb-eeeeeeeeeeee', 'cccccccc-2222-2222-2222-cccccccccccc', 'confirmed');

-- ==========================================================================
-- Flag-OFF path (legacy v1 — every authenticated sees all events)
-- ==========================================================================
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","email":"alice@a.example"}';

SELECT is(
  (SELECT count(*)::int FROM public.events),
  2,
  'flag-off: alice sees all events (legacy behaviour)'
);

-- ==========================================================================
-- Flip the flag to TRUE for the rest of this test
-- ==========================================================================
RESET ROLE;
UPDATE public.platform_settings SET value = 'true' WHERE key = 'tenancy_v2_enforced';

SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","email":"alice@a.example"}';

SELECT is(
  (SELECT count(*)::int FROM public.events WHERE id = 'eeeeeeee-aaaa-aaaa-aaaa-eeeeeeeeeeee'),
  1,
  'flag-on: alice sees account-A event'
);

SELECT is(
  (SELECT count(*)::int FROM public.events WHERE id = 'eeeeeeee-bbbb-bbbb-bbbb-eeeeeeeeeeee'),
  0,
  'flag-on: alice does NOT see account-B event'
);

-- Registrations follow parent event scoping
SELECT is(
  (SELECT count(*)::int FROM public.events_registrations WHERE id = '11111111-aaaa-aaaa-aaaa-111111111111'),
  1,
  'flag-on: alice sees the A-event registration'
);

SELECT is(
  (SELECT count(*)::int FROM public.events_registrations WHERE id = '22222222-bbbb-bbbb-bbbb-222222222222'),
  0,
  'flag-on: alice does NOT see the B-event registration'
);

-- ==========================================================================
-- Bob (account B)
-- ==========================================================================
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","email":"bob@b.example"}';

SELECT is(
  (SELECT count(*)::int FROM public.events WHERE id = 'eeeeeeee-bbbb-bbbb-bbbb-eeeeeeeeeeee'),
  1,
  'flag-on: bob sees account-B event'
);

SELECT is(
  (SELECT count(*)::int FROM public.events WHERE id = 'eeeeeeee-aaaa-aaaa-aaaa-eeeeeeeeeeee'),
  0,
  'flag-on: bob does NOT see account-A event'
);

-- ==========================================================================
-- Super-admin sees both
-- ==========================================================================
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","email":"super@example"}';

SELECT is(
  (SELECT count(*)::int FROM public.events),
  2,
  'flag-on: super-admin sees all events'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
