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

  IF (SELECT execute_status FROM public.compliance_privacy_requests WHERE id = v_req) <> 'erased' THEN
    RAISE EXCEPTION 'request not marked erased';
  END IF;
END $$;

-- 4. A suppressed address can't be re-subscribed.
DO $$
DECLARE
  v_list uuid;
  v_sub  boolean;
BEGIN
  IF to_regclass('public.list_subscriptions') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'SELECT id FROM public.lists LIMIT 1' INTO v_list;
  IF v_list IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.list_subscriptions (list_id, email, subscribed)
  VALUES (v_list, 'erasure-test@example.invalid', true)
  RETURNING subscribed INTO v_sub;
  IF v_sub THEN
    RAISE EXCEPTION 'suppressed address was re-subscribed';
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
  IF r.subject_email NOT LIKE 'sha256:%' OR r.subject_emails IS NOT NULL OR r.identifiers::text LIKE '%example.invalid%' THEN
    RAISE EXCEPTION 'request still holds plain identifiers: %', row_to_json(r);
  END IF;
END $$;

\echo 'erasure engine: all assertions passed'
ROLLBACK;
