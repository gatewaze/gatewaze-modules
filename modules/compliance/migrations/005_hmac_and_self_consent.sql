-- ============================================================================
-- Module: compliance
-- Migration: 005_hmac_and_self_consent
-- Description: Keyed suppression hashes, self sign-up after erasure, and
-- request record retention. Changes agreed with the LF DPO on 14 Oct 2026.
--
-- 1. Suppression uses HMAC-SHA256 with a key held in Supabase Vault (or a
--    locked table where Vault isn't installed), not plain sha256. A plain
--    hash of an email address can be confirmed by anyone who guesses the
--    address; the keyed hash can't be checked without the key, which isn't
--    sent to application code (a database owner can still read it). Request redaction uses the same keyed hash.
-- 2. A person who signs up again THEMSELVES lifts their suppression, and only
--    by confirming a double opt-in link emailed to that address, which
--    proves they control the mailbox. The newsletter-signup function calls
--    compliance_lift_suppression() (service role only) after verifying the
--    link. The subscription trigger itself never lifts anything: it reads
--    only the row being written, and signed-in users and several
--    service-role endpoints can put any source or metadata on a row. So
--    imports, partner and event lists, syncs, admin, API and portal writes
--    all stay blocked while the suppression exists.
-- 3. Completed or rejected requests are deleted 30 days after they close.
--    The LF privacy team keeps the master record of each request.
-- ============================================================================

-- ── HMAC key ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.compliance_hmac_key (
  id    boolean PRIMARY KEY DEFAULT true CHECK (id),
  key   bytea NOT NULL
);
ALTER TABLE public.compliance_hmac_key ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.compliance_hmac_key FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.compliance_hmac_key IS
  'Fallback HMAC key for suppression hashes where Supabase Vault is not installed. No policies: only the database owner reads it.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault') THEN
    IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'compliance_suppression_hmac_key') THEN
      PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'),
                                  'compliance_suppression_hmac_key',
                                  'Key for compliance suppression and request hashes. Rotating it un-suppresses every erased address.');
    END IF;
  ELSE
    INSERT INTO public.compliance_hmac_key (id, key)
    VALUES (true, extensions.gen_random_bytes(32))
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.compliance__hmac_key()
RETURNS bytea
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key bytea;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault') THEN
    EXECUTE $q$SELECT decode(decrypted_secret, 'hex') FROM vault.decrypted_secrets
               WHERE name = 'compliance_suppression_hmac_key'$q$ INTO v_key;
  END IF;
  IF v_key IS NULL THEN
    SELECT key INTO v_key FROM public.compliance_hmac_key WHERE id;
  END IF;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'compliance HMAC key is missing';
  END IF;
  RETURN v_key;
END $$;

CREATE OR REPLACE FUNCTION public.compliance_email_hmac(p_email text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_email IS NULL OR btrim(p_email) = '' THEN NULL
    ELSE encode(extensions.hmac(convert_to(lower(btrim(p_email)), 'UTF8'), public.compliance__hmac_key(), 'sha256'), 'hex')
  END
$$;

-- ── Suppressions move to the keyed hash ──────────────────────────────────────
-- Plain sha256 rows can't be converted. The feature shipped the day before
-- this migration and no brand had erased anyone, so there should be none;
-- stop rather than silently un-suppress someone if there are.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'compliance_suppressions' AND column_name = 'email_sha256') THEN
    IF EXISTS (SELECT 1 FROM public.compliance_suppressions) THEN
      RAISE EXCEPTION 'compliance_suppressions holds sha256 rows that cannot be converted to HMAC; handle them before applying 005';
    END IF;
    ALTER TABLE public.compliance_suppressions RENAME COLUMN email_sha256 TO email_hmac;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'compliance_privacy_requests' AND column_name = 'subject_email_sha256') THEN
    ALTER TABLE public.compliance_privacy_requests RENAME COLUMN subject_email_sha256 TO subject_email_hmac;
  END IF;
END $$;

COMMENT ON TABLE public.compliance_suppressions IS
  'HMAC-SHA256 (key in Vault) of addresses that must not be re-added by imports or third parties. Holds no other personal data. A verified self sign-up removes the row.';

-- Old redacted requests used sha256; re-key what can be re-keyed. Redacted
-- rows only hold the hash, so they keep it until retention deletes them.
UPDATE public.compliance_privacy_requests
   SET subject_email_hmac = ARRAY(SELECT DISTINCT public.compliance_email_hmac(x)
                                  FROM unnest(coalesce(subject_emails, ARRAY[subject_email::text])) x)
 WHERE redacted_at IS NULL AND subject_email_hmac IS NOT NULL;

CREATE OR REPLACE FUNCTION public.compliance_is_suppressed(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.compliance_suppressions
    WHERE email_hmac = public.compliance_email_hmac(p_email)
  )
$$;

-- For the send engine: which of these addresses are suppressed. Hashing
-- stays in the database so the key never reaches application code.
CREATE OR REPLACE FUNCTION public.compliance_suppressed_emails(p_emails text[])
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Return the inputs exactly as given, so the caller's own normalisation
  -- decides the match key.
  SELECT coalesce(array_agg(DISTINCT e), '{}')
  FROM unnest(p_emails) AS e
  JOIN public.compliance_suppressions s ON s.email_hmac = public.compliance_email_hmac(e)
$$;

-- ── Subscription guard (blocks only) and the explicit lift ───────────────────
-- Called by a trusted flow that has just proven the person controls the
-- address (double opt-in confirmation). Never derive this from row content.
CREATE OR REPLACE FUNCTION public.compliance_lift_suppression(p_email text, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n int;
BEGIN
  IF coalesce(p_reason, '') NOT IN ('double_opt_in') THEN
    RAISE EXCEPTION 'compliance_lift_suppression: unsupported reason %', p_reason;
  END IF;
  DELETE FROM public.compliance_suppressions WHERE email_hmac = public.compliance_email_hmac(p_email);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END $$;



CREATE OR REPLACE FUNCTION public.compliance_block_suppressed_subscription()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row   jsonb := to_jsonb(NEW);
  v_email text := v_row ->> TG_ARGV[0];
  v_on    boolean;
BEGIN
  IF v_email IS NULL OR NOT public.compliance_is_suppressed(v_email) THEN
    RETURN NEW;
  END IF;

  v_on := CASE TG_ARGV[1]
            WHEN 'subscribed' THEN coalesce((v_row ->> 'subscribed')::boolean, false)
            ELSE (v_row ->> 'unsubscribed_at') IS NULL
          END;
  IF NOT v_on THEN
    RETURN NEW;
  END IF;

  IF TG_ARGV[1] = 'subscribed' THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(
      'subscribed', false,
      'unsubscribed_at', coalesce(v_row ->> 'unsubscribed_at', now()::text)));
  ELSE
    NEW := jsonb_populate_record(NEW, jsonb_build_object('unsubscribed_at', now()::text));
  END IF;
  RETURN NEW;
END $$;

-- ── Erasure and redaction use the keyed hash ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.compliance_erasure_execute(p_request_id uuid, p_actor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r          public.compliance_privacy_requests;
  e          public.compliance_personal_data_registry;
  v_ident    jsonb;
  v_plan     jsonb;
  v_pred     text;
  v_set      text;
  v_n        bigint;
  v_done     jsonb := '{}';
  v_results  jsonb := '[]';
  v_pending  int;
  v_progress boolean;
  v_last_err text;
  v_pass     int;
  v_key      text;
BEGIN
  SELECT * INTO r FROM public.compliance_privacy_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'privacy request % not found', p_request_id;
  END IF;
  IF r.request_type <> 'data_deletion' THEN
    RAISE EXCEPTION 'privacy request % is a % request, not data_deletion', p_request_id, r.request_type;
  END IF;
  IF r.executed_at IS NOT NULL OR r.status IN ('completed', 'rejected') THEN
    RAISE EXCEPTION 'privacy request % has already been carried out or closed', p_request_id;
  END IF;
  -- The API checks these too; enforcing them here means nothing that can
  -- reach the database directly can skip the preview or the claim.
  IF r.execute_status <> 'running' THEN
    RAISE EXCEPTION 'privacy request % has not been claimed for erasure (execute_status=%)', p_request_id, r.execute_status;
  END IF;
  IF r.plan_status <> 'ready' OR r.plan_built_at IS NULL OR r.plan_built_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'privacy request % needs a preview from the last 24 hours', p_request_id;
  END IF;

  -- Rebuild from scratch: data may have changed since the preview.
  v_ident := public.compliance_erasure_identify(coalesce(r.subject_emails, ARRAY[r.subject_email::text]));
  v_plan := public.compliance_erasure_plan(v_ident);
  IF jsonb_array_length(v_plan -> 'blockers') > 0 THEN
    RAISE EXCEPTION 'erasure blocked: %', v_plan -> 'blockers';
  END IF;

  PERFORM public.compliance_install_suppression_triggers();

  -- 1. Anonymise. Child rows matched through a parent run first (lower
  --    sort_order), while the parent still matches.
  FOR e IN
    SELECT * FROM public.compliance_personal_data_registry
    WHERE action = 'anonymise'
    ORDER BY sort_order, table_name, entry
  LOOP
    v_pred := public.compliance__erasure_predicate(e, v_ident);
    v_set := public.compliance__anonymise_set(e);
    IF v_pred IS NULL OR v_set IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('UPDATE public.%I SET %s WHERE %s', e.table_name, v_set, v_pred);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      v_results := v_results || jsonb_build_object(
        'table', e.table_name, 'entry', e.entry, 'action', 'anonymise', 'rows', v_n, 'retain', e.retain);
    END IF;
  END LOOP;

  -- 2. Delete. Tables without ON DELETE rules must go before their parents.
  --    Rather than hand-maintain that order, retry: each pass deletes what it
  --    can and defers anything a foreign key still blocks.
  SELECT count(*) INTO v_pending FROM public.compliance_personal_data_registry WHERE action = 'delete';
  FOR v_pass IN 1..10 LOOP
    v_progress := false;
    FOR e IN
      SELECT * FROM public.compliance_personal_data_registry
      WHERE action = 'delete'
      ORDER BY sort_order, table_name, entry
    LOOP
      v_key := e.table_name || '/' || e.entry;
      IF v_done ? v_key THEN
        CONTINUE;
      END IF;
      v_pred := public.compliance__erasure_predicate(e, v_ident);
      IF v_pred IS NULL THEN
        v_done := v_done || jsonb_build_object(v_key, 0);
        v_progress := true;
        CONTINUE;
      END IF;
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE %s', e.table_name, v_pred);
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_done := v_done || jsonb_build_object(v_key, v_n);
        v_progress := true;
        IF v_n > 0 THEN
          v_results := v_results || jsonb_build_object(
            'table', e.table_name, 'entry', e.entry, 'action', 'delete', 'rows', v_n);
        END IF;
      EXCEPTION WHEN foreign_key_violation THEN
        v_last_err := SQLERRM;
      END;
    END LOOP;
    EXIT WHEN (SELECT count(*) FROM jsonb_object_keys(v_done)) >= v_pending;
    IF NOT v_progress THEN
      RAISE EXCEPTION 'erasure could not complete the deletes: %', v_last_err;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_object_keys(v_done)) < v_pending THEN
    RAISE EXCEPTION 'erasure could not complete the deletes: %', v_last_err;
  END IF;

  -- 3. Verify nothing matching is left.
  FOR e IN
    SELECT * FROM public.compliance_personal_data_registry WHERE action IN ('delete', 'anonymise')
  LOOP
    v_pred := public.compliance__erasure_predicate(e, v_ident);
    IF v_pred IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %s', e.table_name, v_pred) INTO v_n;
    IF v_n > 0 THEN
      RAISE EXCEPTION 'erasure verification failed: %/% still has % matching rows', e.table_name, e.entry, v_n;
    END IF;
  END LOOP;

  -- 4. Earlier or parallel requests about the same person keep only hashes.
  --    This request keeps its addresses until it completes (the processors
  --    need them), then compliance_privacy_request_redact clears them.
  UPDATE public.compliance_privacy_requests o
     SET subject_email_hmac = ARRAY(SELECT DISTINCT public.compliance_email_hmac(x)
                                      FROM unnest(coalesce(o.subject_emails, ARRAY[o.subject_email::text])) x),
         subject_email = 'hmac:' || public.compliance_email_hmac(o.subject_email),
         requester_email = CASE WHEN lower(btrim(o.requester_email)) IN (SELECT jsonb_array_elements_text(v_ident -> 'emails'))
                                THEN 'hmac:' || public.compliance_email_hmac(o.requester_email)
                                ELSE o.requester_email END,
         subject_emails = NULL,
         subject_person_id = NULL,
         notes = NULL,
         identifiers = NULL,
         redacted_at = coalesce(o.redacted_at, now())
   WHERE o.id <> p_request_id
     AND o.redacted_at IS NULL
     AND (lower(btrim(o.subject_email)) IN (SELECT jsonb_array_elements_text(v_ident -> 'emails'))
          OR EXISTS (SELECT 1 FROM unnest(o.subject_emails) x
                     WHERE lower(btrim(x)) IN (SELECT jsonb_array_elements_text(v_ident -> 'emails'))));

  -- 5. Suppress every address so nothing can re-subscribe or email them.
  INSERT INTO public.compliance_suppressions (email_hmac, scope, request_id)
  SELECT DISTINCT public.compliance_email_hmac(x), 'all', p_request_id
  FROM jsonb_array_elements_text(v_ident -> 'emails') AS x
  ON CONFLICT (email_hmac) DO UPDATE
    SET scope = 'all', request_id = EXCLUDED.request_id, updated_at = now();

  UPDATE public.compliance_privacy_requests
     SET identifiers = v_ident,
         plan = v_plan,
         execute_status = 'erased',
         executed_by = p_actor,
         executed_at = now(),
         status = 'in_progress',
         processing_started_at = coalesce(processing_started_at, now()),
         subject_email_hmac = ARRAY(SELECT DISTINCT public.compliance_email_hmac(x)
                                      FROM jsonb_array_elements_text(v_ident -> 'emails') x),
         report = jsonb_build_object(
           'erased_at', now(),
           'database', v_results,
           'suppressed_emails', jsonb_array_length(v_ident -> 'emails'),
           'warnings', v_plan -> 'warnings')
   WHERE id = p_request_id;

  RETURN jsonb_build_object('database', v_results, 'identifiers', v_ident);
END $$;

CREATE OR REPLACE FUNCTION public.compliance_privacy_request_redact(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.compliance_privacy_requests
     SET subject_email_hmac = coalesce(subject_email_hmac, ARRAY(
           SELECT DISTINCT public.compliance_email_hmac(x)
           FROM unnest(coalesce(subject_emails, ARRAY[subject_email::text])) x)),
         subject_email = 'hmac:' || public.compliance_email_hmac(subject_email),
         requester_email = CASE WHEN lower(btrim(requester_email)) = ANY(
                                  SELECT lower(btrim(x)) FROM unnest(coalesce(subject_emails, ARRAY[subject_email::text])) x)
                                THEN 'hmac:' || public.compliance_email_hmac(requester_email)
                                ELSE requester_email END,
         subject_emails = NULL,
         subject_person_id = NULL,
         notes = NULL,
         identifiers = CASE WHEN identifiers IS NULL THEN NULL ELSE jsonb_build_object(
           'emails', jsonb_array_length(coalesce(identifiers -> 'emails', '[]')),
           'people', jsonb_array_length(coalesce(identifiers -> 'person_ids', '[]')),
           'auth_users', jsonb_array_length(coalesce(identifiers -> 'auth_user_ids', '[]'))) END,
         redacted_at = now()
   WHERE id = p_request_id AND redacted_at IS NULL;
END $$;

-- ── Lookups and retention ────────────────────────────────────────────────────
-- Requests about an address, including redacted ones, matched by keyed hash.
CREATE OR REPLACE FUNCTION public.compliance_find_requests_by_email(p_email text)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id FROM public.compliance_privacy_requests
  WHERE lower(btrim(p_email)) = ANY(SELECT lower(btrim(x)) FROM unnest(coalesce(subject_emails, ARRAY[subject_email::text])) x)
     OR public.compliance_email_hmac(p_email) = ANY(coalesce(subject_email_hmac, '{}'))
$$;

-- Delete requests that closed more than p_days ago. Their suppression rows
-- stay (request_id is set null).
CREATE OR REPLACE FUNCTION public.compliance_purge_requests(p_days int DEFAULT 30)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n int;
BEGIN
  IF p_days IS NULL OR p_days < 7 THEN
    RAISE EXCEPTION 'compliance_purge_requests: retention must be at least 7 days';
  END IF;
  DELETE FROM public.compliance_privacy_requests
   WHERE (status = 'completed' AND coalesce(processing_completed_at, redacted_at, updated_at) < now() - make_interval(days => p_days))
      OR (status = 'rejected' AND updated_at < now() - make_interval(days => p_days));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- ── Grants ───────────────────────────────────────────────────────────────────
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.compliance__hmac_key()',
    'public.compliance_email_hmac(text)',
    'public.compliance_is_suppressed(text)',
    'public.compliance_suppressed_emails(text[])',
    'public.compliance_lift_suppression(text, text)',
    'public.compliance_block_suppressed_subscription()',
    'public.compliance_erasure_execute(uuid, text)',
    'public.compliance_privacy_request_redact(uuid)',
    'public.compliance_find_requests_by_email(text)',
    'public.compliance_purge_requests(int)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
  -- The key itself is only for the database owner.
  REVOKE ALL ON FUNCTION public.compliance__hmac_key() FROM service_role;
END $$;

-- The plain sha256 helper is no longer used for anything personal.
DROP FUNCTION IF EXISTS public.compliance_email_sha256(text);
