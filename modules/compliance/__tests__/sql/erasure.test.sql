-- ============================================================================
-- Erasure engine test. Run against a database with the compliance migrations
-- applied (and as many other modules as possible). Everything happens inside
-- one transaction that is rolled back, so it is safe on a dev database.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f modules/compliance/__tests__/sql/erasure.test.sql
--
-- Any failed assertion raises and stops the script.
-- ============================================================================
BEGIN;

-- Seed one person with rows across the tables most likely to exist, plus an
-- alias email that is only known through attributes.other_emails.
DO $$
DECLARE
  v_person  uuid;
  v_profile uuid;
  v_event   uuid;
  v_list    uuid;
  v_reg     uuid;
  v_log     uuid;
BEGIN
  INSERT INTO public.people (email, phone, attributes)
  VALUES ('Erasure-Test@Example.invalid', '+44 7700 900123',
          jsonb_build_object('first_name', 'Erasure', 'last_name', 'Test',
                             'other_emails', jsonb_build_array('erasure-alias@example.invalid')))
  RETURNING id INTO v_person;

  INSERT INTO public.people_profiles (person_id, qr_code_id) VALUES (v_person, 'ERASETEST01') RETURNING id INTO v_profile;

  IF to_regclass('public.people_events') IS NOT NULL THEN
    EXECUTE 'INSERT INTO public.people_events (person_id, email, event_name, event_data) VALUES ($1, $2, ''test'', ''{}'')'
      USING v_person, 'erasure-test@example.invalid';
  END IF;

  IF to_regclass('public.events_registrations') IS NOT NULL THEN
    SELECT id INTO v_event FROM public.events LIMIT 1;
    IF v_event IS NOT NULL THEN
      INSERT INTO public.events_registrations (event_id, person_id, people_profile_id, status)
      VALUES (v_event, v_person, v_profile, 'confirmed') RETURNING id INTO v_reg;
    END IF;
  END IF;

  IF to_regclass('public.list_subscriptions') IS NOT NULL THEN
    EXECUTE 'SELECT id FROM public.lists LIMIT 1' INTO v_list;
    IF v_list IS NOT NULL THEN
      INSERT INTO public.list_subscriptions (list_id, person_id, email, subscribed)
      VALUES (v_list, v_person, 'erasure-test@example.invalid', true);
    END IF;
  END IF;

  IF to_regclass('public.email_send_log') IS NOT NULL THEN
    INSERT INTO public.email_send_log (recipient_email, status, content_html)
    VALUES ('erasure-alias@example.invalid', 'sent', '<p>Hello Erasure</p>')
    RETURNING id INTO v_log;
    IF to_regclass('public.email_interactions') IS NOT NULL THEN
      INSERT INTO public.email_interactions (email_send_log_id, event_type, event_timestamp, ip_address, user_agent)
      VALUES (v_log, 'open', now(), '203.0.113.7', 'TestAgent/1.0');
    END IF;
  END IF;

  INSERT INTO public.compliance_consent_records (person_id, email, consent_type, consented, ip_address)
  VALUES (v_person, 'erasure-test@example.invalid', 'cookies', true, '203.0.113.7');

  IF to_regclass('public.broadcast_suppressions') IS NOT NULL THEN
    INSERT INTO public.broadcast_suppressions (email, topic) VALUES ('erasure-test@example.invalid', 'all');
  END IF;

  INSERT INTO public.compliance_privacy_requests (subject_email, subject_emails, request_type, requester_email, submitted_via)
  VALUES ('erasure-test@example.invalid', ARRAY['erasure-test@example.invalid'], 'data_deletion', 'privacy@example.invalid', 'admin');
  INSERT INTO public.compliance_privacy_requests (subject_email, subject_emails, request_type, requester_email, notes, submitted_via)
  VALUES ('Erasure-Alias@example.invalid', ARRAY['erasure-alias@example.invalid'], 'data_export', 'erasure-alias@example.invalid', 'asked by phone', 'admin');
END $$;

-- 1. Identify finds the alias and the profile.
DO $$
DECLARE
  v_ident jsonb := public.compliance_erasure_identify(ARRAY['erasure-test@example.invalid']);
BEGIN
  IF NOT (v_ident -> 'emails') ? 'erasure-alias@example.invalid' THEN
    RAISE EXCEPTION 'identify missed the alias email: %', v_ident;
  END IF;
  IF jsonb_array_length(v_ident -> 'person_ids') <> 1 OR jsonb_array_length(v_ident -> 'profile_ids') <> 1 THEN
    RAISE EXCEPTION 'identify found the wrong people or profiles: %', v_ident;
  END IF;
  IF NOT (v_ident -> 'phones') ? '447700900123' THEN
    RAISE EXCEPTION 'identify missed the phone: %', v_ident;
  END IF;
END $$;

-- 2. Preview counts rows and changes nothing.
DO $$
DECLARE
  v_req  uuid := (SELECT id FROM public.compliance_privacy_requests WHERE subject_email = 'erasure-test@example.invalid');
  v_plan jsonb := public.compliance_erasure_preview(v_req, 'test');
BEGIN
  RAISE NOTICE 'plan summary: %', v_plan -> 'summary';
  RAISE NOTICE 'plan blockers: %', v_plan -> 'blockers';
  RAISE NOTICE 'plan warnings: %', v_plan -> 'warnings';
  IF NOT EXISTS (SELECT 1 FROM public.people WHERE lower(email) = 'erasure-test@example.invalid') THEN
    RAISE EXCEPTION 'preview modified data';
  END IF;
  IF (v_plan -> 'summary' ->> 'rows')::int < 3 THEN
    RAISE EXCEPTION 'preview found too few rows: %', v_plan;
  END IF;
END $$;

-- 3. Execute removes everything and records the suppression.
DO $$
DECLARE
  v_req    uuid := (SELECT id FROM public.compliance_privacy_requests WHERE subject_email = 'erasure-test@example.invalid');
  v_result jsonb;
  v_n      int;
BEGIN
  -- Executing without the worker's claim is refused.
  BEGIN
    PERFORM public.compliance_erasure_execute(v_req, 'test');
    RAISE EXCEPTION 'unclaimed execute should have been refused';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%has not been claimed%' THEN RAISE; END IF;
  END;
  UPDATE public.compliance_privacy_requests SET execute_status = 'running' WHERE id = v_req;
  v_result := public.compliance_erasure_execute(v_req, 'test');
  RAISE NOTICE 'erased: %', v_result -> 'database';

  SELECT count(*) INTO v_n FROM public.people WHERE lower(email) IN ('erasure-test@example.invalid', 'erasure-alias@example.invalid');
  IF v_n <> 0 THEN RAISE EXCEPTION 'people row survived'; END IF;

  SELECT count(*) INTO v_n FROM public.compliance_consent_records WHERE lower(email) = 'erasure-test@example.invalid' OR ip_address = '203.0.113.7';
  IF v_n <> 0 THEN RAISE EXCEPTION 'consent record kept identifiers'; END IF;

  IF to_regclass('public.email_send_log') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM public.email_send_log WHERE content_html = '<p>Hello Erasure</p>' OR lower(recipient_email) = 'erasure-alias@example.invalid';
    IF v_n <> 0 THEN RAISE EXCEPTION 'send log kept identifiers or body'; END IF;
    SELECT count(*) INTO v_n FROM public.email_send_log WHERE recipient_email LIKE 'erased+%@erased.invalid';
    IF v_n < 1 THEN RAISE EXCEPTION 'send log row should be kept, anonymised'; END IF;
  END IF;
  IF to_regclass('public.email_interactions') IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM public.email_interactions WHERE user_agent = 'TestAgent/1.0';
    IF v_n <> 0 THEN RAISE EXCEPTION 'interaction kept IP or user agent'; END IF;
  END IF;

  IF NOT public.compliance_is_suppressed('ERASURE-ALIAS@example.invalid ') THEN
    RAISE EXCEPTION 'alias email was not suppressed';
  END IF;

  SELECT count(*) INTO v_n FROM public.compliance_privacy_requests
   WHERE request_type = 'data_export' AND (subject_email NOT LIKE 'hmac:%' OR requester_email NOT LIKE 'hmac:%' OR notes IS NOT NULL);
  IF v_n <> 0 THEN RAISE EXCEPTION 'earlier request for the same person kept plain identifiers'; END IF;

  IF (SELECT execute_status FROM public.compliance_privacy_requests WHERE id = v_req) <> 'erased' THEN
    RAISE EXCEPTION 'request not marked erased';
  END IF;
END $$;

-- 4. Nothing written to a subscription table can re-add a suppressed
--    address or lift its suppression, whatever source or metadata it claims,
--    including a signed-in user. Only the explicit lift (called after a
--    confirmed double opt-in) does.
DO $$
DECLARE
  v_list uuid;
  v_sub  boolean;
  v_src  text;
BEGIN
  IF to_regclass('public.list_subscriptions') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'SELECT id FROM public.lists LIMIT 1' INTO v_list;
  IF v_list IS NULL THEN
    RETURN;
  END IF;

  FOREACH v_src IN ARRAY ARRAY['import:partner-list', 'subscription-centre', 'newsletter-signup', 'portal'] LOOP
    INSERT INTO public.list_subscriptions (list_id, email, subscribed, source, metadata)
    VALUES (v_list, 'erasure-test@example.invalid', true, v_src, '{"consent":{"method":"double_opt_in"}}')
    RETURNING subscribed INTO v_sub;
    IF v_sub THEN RAISE EXCEPTION 'a % write re-subscribed a suppressed address', v_src; END IF;
    DELETE FROM public.list_subscriptions WHERE email = 'erasure-test@example.invalid';
  END LOOP;

  -- As a signed-in portal user claiming to be the person, through RLS.
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated","email":"erasure-test@example.invalid"}', true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.list_subscriptions (list_id, email, subscribed, source, metadata)
  VALUES (v_list, 'erasure-test@example.invalid', true, 'portal', '{"consent":{"method":"double_opt_in"}}');
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT subscribed INTO v_sub FROM public.list_subscriptions WHERE email = 'erasure-test@example.invalid';
  IF v_sub THEN RAISE EXCEPTION 'a signed-in user re-subscribed a suppressed address'; END IF;
  -- An UPDATE flipping the existing row back on is blocked too.
  UPDATE public.list_subscriptions SET subscribed = true, source = 'subscription-centre'
   WHERE email = 'erasure-test@example.invalid';
  SELECT subscribed INTO v_sub FROM public.list_subscriptions WHERE email = 'erasure-test@example.invalid';
  IF v_sub THEN RAISE EXCEPTION 'an UPDATE re-subscribed a suppressed address'; END IF;
  DELETE FROM public.list_subscriptions WHERE email = 'erasure-test@example.invalid';
  IF NOT public.compliance_is_suppressed('erasure-test@example.invalid') THEN
    RAISE EXCEPTION 'a subscription write lifted the suppression';
  END IF;

  -- The confirmed double opt-in path: lift, then subscribe.
  BEGIN
    PERFORM public.compliance_lift_suppression('erasure-test@example.invalid', 'admin');
    RAISE EXCEPTION 'lift accepted an unsupported reason';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%unsupported reason%' THEN RAISE; END IF;
  END;
  IF NOT public.compliance_lift_suppression('Erasure-Test@example.invalid ', 'double_opt_in') THEN
    RAISE EXCEPTION 'lift found nothing to remove';
  END IF;
  INSERT INTO public.list_subscriptions (list_id, email, subscribed, source)
  VALUES (v_list, 'erasure-test@example.invalid', true, 'newsletter-signup')
  RETURNING subscribed INTO v_sub;
  IF NOT v_sub THEN RAISE EXCEPTION 'the person could not sign up after confirming'; END IF;
  IF NOT public.compliance_is_suppressed('erasure-alias@example.invalid') THEN
    RAISE EXCEPTION 'the alias suppression was lifted too';
  END IF;
END $$;

-- 4b. Suppressions are keyed hashes, not plain sha256.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.compliance_suppressions
             WHERE email_hmac = encode(sha256(convert_to('erasure-alias@example.invalid', 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION 'suppression stored a plain sha256';
  END IF;
END $$;

-- 5. Running it twice is refused.
DO $$
DECLARE
  v_req uuid := (SELECT id FROM public.compliance_privacy_requests WHERE subject_email = 'erasure-test@example.invalid');
BEGIN
  BEGIN
    PERFORM public.compliance_erasure_execute(v_req, 'test');
    RAISE EXCEPTION 'second execute should have been refused';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%already been carried out%' THEN
      RAISE;
    END IF;
  END;
END $$;

-- 6. Redaction leaves only hashes on the request.
DO $$
DECLARE
  v_req uuid := (SELECT id FROM public.compliance_privacy_requests WHERE subject_email = 'erasure-test@example.invalid');
  r     public.compliance_privacy_requests;
BEGIN
  PERFORM public.compliance_privacy_request_redact(v_req);
  SELECT * INTO r FROM public.compliance_privacy_requests WHERE id = v_req;
  IF r.subject_email NOT LIKE 'hmac:%' OR r.subject_emails IS NOT NULL OR r.identifiers::text LIKE '%example.invalid%' THEN
    RAISE EXCEPTION 'request still holds plain identifiers: %', row_to_json(r);
  END IF;
END $$;

-- 7. Retention deletes requests that closed more than 30 days ago.
DO $$
DECLARE
  v_req uuid := (SELECT id FROM public.compliance_privacy_requests WHERE subject_email LIKE 'hmac:%' AND request_type = 'data_deletion' LIMIT 1);
BEGIN
  UPDATE public.compliance_privacy_requests
     SET status = 'completed', processing_completed_at = now() - interval '31 days'
   WHERE id = v_req;
  PERFORM public.compliance_purge_requests(30);
  IF EXISTS (SELECT 1 FROM public.compliance_privacy_requests WHERE id = v_req) THEN
    RAISE EXCEPTION 'retention did not delete a closed request';
  END IF;
  IF NOT public.compliance_is_suppressed('erasure-alias@example.invalid') THEN
    RAISE EXCEPTION 'retention removed a suppression';
  END IF;
END $$;

\echo 'erasure engine: all assertions passed'
ROLLBACK;
