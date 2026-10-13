-- pgTAP test for google-sheets migration 002
-- (002_event_admin_rls_and_token_privileges.sql). Run by hand against a
-- database with core, the events module and this module applied, for
-- example with pg_prove; CI does not run it. Everything is rolled back.
-- Both request.jwt.claims and request.jwt.claim.sub are set, so auth.uid()
-- resolves whether it is GoTrue's current version or the older one a bare
-- supabase/postgres image ships.
--
-- Verifies:
--   * client roles hold no privilege on the OAuth token columns;
--   * client roles cannot TRUNCATE either table (TRUNCATE ignores RLS) or
--     write the logs table;
--   * a signed-in user who is not an event admin sees no rows;
--   * an admin with a permission on one event sees only that event;
--   * a super-admin sees every event, and google_connected reflects a
--     stored refresh token.

BEGIN;

SELECT plan(14);

-- ==========================================================================
-- Privileges (no data needed)
-- ==========================================================================
SELECT ok(
  NOT has_column_privilege('authenticated', 'public.event_google_sheets_notifications', 'google_refresh_token', 'SELECT'),
  'authenticated cannot SELECT google_refresh_token'
);
SELECT ok(
  NOT has_column_privilege('authenticated', 'public.event_google_sheets_notifications', 'google_access_token', 'SELECT'),
  'authenticated cannot SELECT google_access_token'
);
SELECT ok(
  NOT has_column_privilege('authenticated', 'public.event_google_sheets_notifications', 'google_refresh_token', 'UPDATE'),
  'authenticated cannot UPDATE google_refresh_token'
);
SELECT ok(
  NOT has_column_privilege('authenticated', 'public.event_google_sheets_notifications', 'google_refresh_token', 'REFERENCES'),
  'authenticated cannot REFERENCE google_refresh_token'
);
SELECT ok(
  NOT has_column_privilege('anon', 'public.event_google_sheets_notifications', 'google_refresh_token', 'SELECT'),
  'anon cannot SELECT google_refresh_token'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.event_google_sheets_notifications', 'TRUNCATE'),
  'authenticated cannot TRUNCATE the notifications table'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.google_sheets_notification_logs', 'TRUNCATE'),
  'authenticated cannot TRUNCATE the logs table'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.google_sheets_notification_logs', 'INSERT'),
  'authenticated cannot INSERT into the logs table'
);

-- ==========================================================================
-- Setup
-- ==========================================================================
INSERT INTO auth.users (id, email, role, aud, instance_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 'portal@example',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('22222222-2222-2222-2222-222222222222', 'e1admin@example', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('33333333-3333-3333-3333-333333333333', 'super@example',   'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

INSERT INTO public.admin_profiles (id, user_id, email, name, role, is_active) VALUES
  ('99999999-9999-9999-9999-999999999992', '22222222-2222-2222-2222-222222222222', 'e1admin@example', 'E1 admin', 'admin', true),
  ('99999999-9999-9999-9999-999999999993', '33333333-3333-3333-3333-333333333333', 'super@example', 'Super', 'super_admin', true);

INSERT INTO public.events (id, event_id, event_title) VALUES
  ('eeeeeeee-1111-1111-1111-eeeeeeeeeeee', 'gst-e1', 'Sheets test event 1'),
  ('eeeeeeee-2222-2222-2222-eeeeeeeeeeee', 'gst-e2', 'Sheets test event 2');

INSERT INTO public.admin_event_permissions (admin_id, event_id) VALUES
  ('99999999-9999-9999-9999-999999999992', 'gst-e1');

-- Placeholder values, not real tokens.
INSERT INTO public.event_google_sheets_notifications (event_id, notification_type, google_access_token, google_refresh_token) VALUES
  ('gst-e1', 'registration', 'test-access-1', 'test-refresh-1'),
  ('gst-e2', 'registration', 'test-access-2', 'test-refresh-2');

INSERT INTO public.google_sheets_notification_logs (event_id, notification_type, status) VALUES
  ('gst-e1', 'registration', 'sent');

-- ==========================================================================
-- Non-admin signed-in user (a portal user)
-- ==========================================================================
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SET request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

SELECT is(
  (SELECT count(*)::int FROM (SELECT id FROM public.event_google_sheets_notifications WHERE event_id LIKE 'gst-%') s),
  0,
  'non-admin sees no notification rows'
);
SELECT throws_ok(
  'TRUNCATE public.google_sheets_notification_logs',
  '42501',
  NULL,
  'non-admin cannot TRUNCATE the logs table'
);

-- ==========================================================================
-- Admin with a permission on gst-e1 only
-- ==========================================================================
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
SET request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

SELECT is(
  (SELECT array_agg(event_id::text ORDER BY event_id) FROM public.event_google_sheets_notifications WHERE event_id LIKE 'gst-%'),
  ARRAY['gst-e1'],
  'event admin sees only their event'
);
SELECT throws_ok(
  $$INSERT INTO public.google_sheets_notification_logs (event_id, notification_type) VALUES ('gst-e1', 'registration')$$,
  '42501',
  NULL,
  'event admin cannot write the logs table'
);

-- ==========================================================================
-- Super-admin
-- ==========================================================================
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
SET request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';

SELECT is(
  (SELECT count(*)::int FROM public.event_google_sheets_notifications WHERE event_id LIKE 'gst-%'),
  2,
  'super-admin sees every event'
);
SELECT ok(
  (SELECT bool_and(google_connected) FROM public.event_google_sheets_notifications WHERE event_id LIKE 'gst-%'),
  'google_connected is true where a refresh token is stored'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
