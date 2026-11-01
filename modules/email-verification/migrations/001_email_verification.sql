-- ============================================================================
-- Module: email-verification
-- Migration: 001_email_verification
-- Description: Check every person's email address before outreach sends it
-- mail, and record the result where segments and broadcasts can use it.
--
-- The worker checks addresses in batches: format, domain typos, disposable
-- domains, DNS (does the domain take mail, and who runs its inbox), then any
-- enabled paid provider module (email-verification-<name>) for the mailbox
-- itself. A hard bounce reported by the SendGrid webhook marks the address
-- invalid too.
--
-- Results go to email_verifications and are copied onto the person as
-- attributes.email_check (valid | risky | invalid), email_check_reason,
-- email_check_level (domain | mailbox | delivery) and email_provider (google,
-- microsoft, ...). With suppress_invalid on (the default), an invalid address
-- is added to broadcast_suppressions (topic 'all') so broadcasts skip it.
-- The module never removes a suppression by itself: a suppression row with
-- the same email and topic may also stand for an unsubscribe, so only an admin
-- lifts one, through email_verification_lift_suppression().
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.email_verifications (
  email             text PRIMARY KEY CHECK (email = lower(email)),
  -- NULL until a check reaches a verdict (DNS did not answer yet).
  status            text CHECK (status IN ('valid', 'risky', 'invalid')),
  reason            text,
  level             text CHECK (level IN ('domain', 'mailbox', 'delivery')),
  decided_by        text,
  mailbox_provider  text CHECK (mailbox_provider IN ('google', 'microsoft', 'yahoo', 'apple', 'other', 'unknown')),
  suggestion        text,
  attempts          integer NOT NULL DEFAULT 0,
  checked_at        timestamptz,
  next_check_at     timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_verifications_next_check ON public.email_verifications (next_check_at);
CREATE INDEX IF NOT EXISTS idx_email_verifications_status ON public.email_verifications (status, reason);

-- DNS result per domain, so 1,000 people at one company cost one lookup.
CREATE TABLE IF NOT EXISTS public.email_verification_domains (
  domain            text PRIMARY KEY,
  outcome           text NOT NULL CHECK (outcome IN ('accepts_mail', 'address_only', 'no_mail_host', 'null_mx', 'not_found')),
  mailbox_provider  text NOT NULL,
  mx_host           text,
  error             text,
  checked_at        timestamptz NOT NULL DEFAULT now()
);

-- Every answer (or error) from a paid provider, for the audit trail and for
-- comparing providers. raw never holds an API key.
CREATE TABLE IF NOT EXISTS public.email_verification_provider_results (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       text NOT NULL,
  provider    text NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('primary', 'escalation', 'compare')),
  status      text,
  reason      text,
  error_kind  text,
  error       text,
  raw         jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_verification_provider_results_email ON public.email_verification_provider_results (email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_verification_provider_results_provider ON public.email_verification_provider_results (provider, created_at DESC);

-- Paid checks per provider per day, for the daily limits.
CREATE TABLE IF NOT EXISTS public.email_verification_usage (
  provider  text NOT NULL,
  day       date NOT NULL,
  checks    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, day)
);

-- One worker run at a time. The cron fires every 5 minutes and the jobs
-- queue runs several jobs at once, so a slow run must not overlap the next
-- one and spend the same paid budget twice.
CREATE TABLE IF NOT EXISTS public.email_verification_lease (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  holder        text,
  locked_until  timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO public.email_verification_lease (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Admins read; only the service role (which bypasses RLS) writes.
ALTER TABLE public.email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_verification_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_verification_provider_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_verification_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_verification_lease ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_verifications_admin_read ON public.email_verifications;
CREATE POLICY email_verifications_admin_read ON public.email_verifications
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
DROP POLICY IF EXISTS email_verification_domains_admin_read ON public.email_verification_domains;
CREATE POLICY email_verification_domains_admin_read ON public.email_verification_domains
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
DROP POLICY IF EXISTS email_verification_provider_results_admin_read ON public.email_verification_provider_results;
CREATE POLICY email_verification_provider_results_admin_read ON public.email_verification_provider_results
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
DROP POLICY IF EXISTS email_verification_usage_admin_read ON public.email_verification_usage;
CREATE POLICY email_verification_usage_admin_read ON public.email_verification_usage
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

-- Supabase's default privileges give anon and authenticated ALL on new tables;
-- RLS covers INSERT/UPDATE/DELETE but not TRUNCATE, REFERENCES or TRIGGER.
REVOKE ALL ON public.email_verifications, public.email_verification_domains,
  public.email_verification_provider_results, public.email_verification_usage,
  public.email_verification_lease FROM anon, authenticated;
GRANT SELECT ON public.email_verifications, public.email_verification_domains,
  public.email_verification_provider_results, public.email_verification_usage TO authenticated;
GRANT ALL ON public.email_verifications, public.email_verification_domains,
  public.email_verification_provider_results, public.email_verification_usage,
  public.email_verification_lease TO service_role;

-- ----------------------------------------------------------------------------
-- Addresses due a check: never checked first, then prospects (outreach needs
-- them soonest), then the newest people.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.email_verification_due(p_limit integer)
RETURNS TABLE (email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT d.email
  FROM (
    SELECT lower(p.email) AS email,
           bool_or(v.email IS NULL) AS never_checked,
           bool_or(p.contact_kind = 'prospect') AS prospect,
           max(p.created_at) AS newest
    FROM public.people p
    LEFT JOIN public.email_verifications v ON v.email = lower(p.email)
    WHERE p.email IS NOT NULL AND p.email <> ''
      AND (v.email IS NULL OR v.next_check_at <= now())
    GROUP BY lower(p.email)
  ) d
  ORDER BY d.never_checked DESC, d.prospect DESC, d.newest DESC
  LIMIT GREATEST(1, LEAST(p_limit, 5000));
$$;

-- Take the run lease for p_seconds. False when another run holds it.
CREATE OR REPLACE FUNCTION public.email_verification_try_lease(p_holder text, p_seconds integer)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.email_verification_lease
     SET holder = p_holder, locked_until = now() + make_interval(secs => GREATEST(30, LEAST(p_seconds, 900)))
   WHERE id AND (locked_until < now() OR holder = p_holder);
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.email_verification_release_lease(p_holder text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE public.email_verification_lease SET locked_until = '-infinity', holder = NULL WHERE id AND holder = p_holder;
$$;

-- ----------------------------------------------------------------------------
-- Apply one verdict: the verification row, the person's attributes, and the
-- broadcast suppression. Shared by the worker and the bounce trigger.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.email_verification_apply(
  p_email            text,
  p_status           text,
  p_reason           text,
  p_level            text,
  p_decided_by       text,
  p_mailbox_provider text,
  p_suggestion       text,
  p_next_check_at    timestamptz,
  p_suppress         boolean
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_email text := lower(trim(p_email));
  v_prev  public.email_verifications%ROWTYPE;
BEGIN
  IF v_email IS NULL OR v_email = '' OR p_status NOT IN ('valid', 'risky', 'invalid') THEN
    RETURN;
  END IF;

  SELECT * INTO v_prev FROM public.email_verifications WHERE email = v_email;
  -- A real hard bounce is stronger evidence than any check. Keep it, and just
  -- schedule the next look.
  IF FOUND AND v_prev.level = 'delivery' AND v_prev.status = 'invalid' AND p_level <> 'delivery' THEN
    UPDATE public.email_verifications
       SET next_check_at = p_next_check_at, attempts = 0, updated_at = now()
     WHERE email = v_email;
    RETURN;
  END IF;

  INSERT INTO public.email_verifications AS v
    (email, status, reason, level, decided_by, mailbox_provider, suggestion, attempts, checked_at, next_check_at, updated_at)
  VALUES
    (v_email, p_status, p_reason, p_level, p_decided_by, COALESCE(p_mailbox_provider, 'unknown'), p_suggestion, 0, now(), p_next_check_at, now())
  ON CONFLICT (email) DO UPDATE SET
    status = EXCLUDED.status,
    reason = EXCLUDED.reason,
    level = EXCLUDED.level,
    decided_by = EXCLUDED.decided_by,
    -- A bounce has no DNS answer to give; keep the provider already known.
    mailbox_provider = CASE WHEN EXCLUDED.mailbox_provider = 'unknown' THEN v.mailbox_provider ELSE EXCLUDED.mailbox_provider END,
    suggestion = EXCLUDED.suggestion,
    attempts = 0,
    checked_at = now(),
    next_check_at = EXCLUDED.next_check_at,
    updated_at = now();

  -- Copy onto the person for segments. Only rows that change are written.
  UPDATE public.people p
     SET attributes = COALESCE(p.attributes, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
           'email_check', p_status,
           'email_check_reason', p_reason,
           'email_check_level', p_level,
           'email_provider', NULLIF(COALESCE(p_mailbox_provider, 'unknown'), 'unknown')))
   WHERE lower(p.email) = v_email
     AND (p.attributes->>'email_check' IS DISTINCT FROM p_status
       OR p.attributes->>'email_check_reason' IS DISTINCT FROM p_reason
       OR p.attributes->>'email_check_level' IS DISTINCT FROM p_level
       OR (COALESCE(p_mailbox_provider, 'unknown') <> 'unknown' AND p.attributes->>'email_provider' IS DISTINCT FROM p_mailbox_provider));

  -- Broadcasts skip suppressed addresses. Add one for an invalid address and
  -- leave any existing row (an unsubscribe, a manual suppression) as it is.
  IF p_status = 'invalid' AND p_suppress AND to_regclass('public.broadcast_suppressions') IS NOT NULL THEN
    EXECUTE 'INSERT INTO public.broadcast_suppressions (email, topic, reason, source)
             VALUES ($1, ''all'', $2, ''email-verification'') ON CONFLICT DO NOTHING'
      USING v_email, 'email_check:' || COALESCE(p_reason, 'invalid');
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- The worker's write for one batch. p_rows is a JSON array of
--   { email, status, reason, level, decided_by, mailbox_provider, suggestion, next_check_at }
-- or { email, retry: true } when DNS did not answer (try again with backoff).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.email_verification_record(p_rows jsonb, p_suppress boolean)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  r jsonb;
  n integer := 0;
  v_email text;
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' THEN RETURN 0; END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_email := lower(trim(r->>'email'));
    CONTINUE WHEN v_email IS NULL OR v_email = '';
    IF r->>'retry' = 'true' THEN
      INSERT INTO public.email_verifications AS v (email, attempts, next_check_at)
      VALUES (v_email, 1, now() + interval '1 hour')
      ON CONFLICT (email) DO UPDATE SET
        attempts = v.attempts + 1,
        -- 1h, 2h, 4h ... up to a day.
        next_check_at = now() + LEAST(interval '1 hour' * power(2, LEAST(v.attempts, 10)), interval '1 day'),
        updated_at = now();
    ELSE
      PERFORM public.email_verification_apply(
        v_email, r->>'status', r->>'reason', r->>'level', r->>'decided_by',
        r->>'mailbox_provider', NULLIF(r->>'suggestion', ''),
        COALESCE((r->>'next_check_at')::timestamptz, now() + interval '180 days'),
        COALESCE(p_suppress, true));
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- Add paid checks to today's usage and return the new total for that provider.
CREATE OR REPLACE FUNCTION public.email_verification_add_usage(p_provider text, p_checks integer)
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  INSERT INTO public.email_verification_usage AS u (provider, day, checks)
  VALUES (p_provider, (now() AT TIME ZONE 'utc')::date, GREATEST(0, p_checks))
  ON CONFLICT (provider, day) DO UPDATE SET checks = u.checks + GREATEST(0, p_checks)
  RETURNING checks;
$$;

-- ----------------------------------------------------------------------------
-- Hard bounces, from the SendGrid webhook only.
--
-- The bulk-emailing webhook sets status 'bounced' with bounce_type (SendGrid's
-- event type: 'bounce' for a hard bounce, 'blocked' for a block) and
-- bounce_reason, or status 'dropped' with bounce_reason. The older core
-- webhook sets status 'bounced' with the reason in failure_error, and
-- 'permanently_failed' for a drop.
--
-- A bounce counts only with an SMTP status that says the mailbox does not
-- exist: 5.1.0, 5.1.1 or 5.1.10, or a 550 to 553 reply with a phrase such as
-- "user unknown". A drop counts only when SendGrid's reason is exactly
-- "Bounced Address" or "Invalid". Free text alone never counts: a send-path
-- failure ("template does not exist") is also stored as permanently_failed,
-- and must not mark a whole batch invalid. Blocks for spam or reputation are
-- about the sender, so they never count.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.email_verification_is_hard_bounce(p_status text, p_bounce_type text, p_reason text)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN p_reason IS NULL THEN false
    WHEN p_status IN ('dropped', 'permanently_failed') THEN
      p_reason ~* '^\s*(bounced address|invalid)\s*$'
    WHEN p_status = 'bounced' THEN
      COALESCE(lower(p_bounce_type), 'bounce') = 'bounce'
      AND p_reason !~* '(5\.7\.|spam|block|policy|reputation|blacklist|denylist|rate limit|quota|throttl)'
      AND (
        p_reason ~* '\m5\.1\.(0|1|10)\M'
        OR (p_reason ~* '\m55[0-3]\M'
            AND p_reason ~* '(user unknown|unknown user|no such user|does not exist|mailbox not found|no mailbox|mailbox unavailable|invalid recipient|recipient address rejected|address rejected|account (is )?disabled)')
      )
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.email_verification_on_bounce()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_suppress boolean := true;
  v_type     text;
  v_reason   text;
BEGIN
  -- Never let this break the webhook's own update.
  BEGIN
    v_type := to_jsonb(NEW)->>'bounce_type';
    v_reason := COALESCE(to_jsonb(NEW)->>'bounce_reason', NEW.failure_error);
    IF NOT public.email_verification_is_hard_bounce(NEW.status, v_type, v_reason) THEN
      RETURN NEW;
    END IF;
    SELECT CASE WHEN m.config->>'suppress_invalid' IN ('false', 'true') THEN (m.config->>'suppress_invalid')::boolean ELSE true END
      INTO v_suppress
      FROM public.installed_modules m
     WHERE m.id = 'email-verification' AND m.status = 'enabled';
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
    PERFORM public.email_verification_apply(
      NEW.recipient_email, 'invalid', 'hard_bounce', 'delivery', 'bounce', 'unknown', NULL,
      now() + interval '365 days', COALESCE(v_suppress, true));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[email-verification] bounce handling failed: %', SQLERRM;
  END;
  RETURN NEW;
END $$;

DO $$ BEGIN
  IF to_regclass('public.email_send_log') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_email_verification_on_bounce ON public.email_send_log;
    CREATE TRIGGER trg_email_verification_on_bounce
      AFTER UPDATE OF status ON public.email_send_log
      FOR EACH ROW
      WHEN (NEW.status IN ('bounced', 'dropped', 'permanently_failed') AND OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE FUNCTION public.email_verification_on_bounce();
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Admin actions.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.email_verification_summary()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT jsonb_build_object(
    'people', (SELECT count(DISTINCT lower(email)) FROM public.people WHERE email IS NOT NULL AND email <> ''),
    'checked', (SELECT count(*) FROM public.email_verifications WHERE status IS NOT NULL),
    'waiting_for_dns', (SELECT count(*) FROM public.email_verifications WHERE status IS NULL),
    'by_status', COALESCE((SELECT jsonb_object_agg(s, c) FROM (
        SELECT status AS s, count(*) AS c FROM public.email_verifications WHERE status IS NOT NULL GROUP BY status) x), '{}'::jsonb),
    'by_reason', COALESCE((SELECT jsonb_agg(jsonb_build_object('status', s, 'reason', r, 'count', c) ORDER BY c DESC) FROM (
        SELECT status AS s, reason AS r, count(*) AS c FROM public.email_verifications WHERE status IS NOT NULL GROUP BY status, reason) x), '[]'::jsonb),
    'by_level', COALESCE((SELECT jsonb_object_agg(l, c) FROM (
        SELECT level AS l, count(*) AS c FROM public.email_verifications WHERE level IS NOT NULL GROUP BY level) x), '{}'::jsonb),
    'by_mailbox_provider', COALESCE((SELECT jsonb_object_agg(m, c) FROM (
        SELECT mailbox_provider AS m, count(*) AS c FROM public.email_verifications WHERE status IS NOT NULL GROUP BY mailbox_provider) x), '{}'::jsonb),
    'prospects', jsonb_build_object(
      'total', (SELECT count(*) FROM public.people WHERE contact_kind = 'prospect'),
      'by_status', COALESCE((SELECT jsonb_object_agg(s, c) FROM (
          SELECT COALESCE(v.status, 'unchecked') AS s, count(*) AS c
          FROM public.people p LEFT JOIN public.email_verifications v ON v.email = lower(p.email)
          WHERE p.contact_kind = 'prospect' GROUP BY 1) x), '{}'::jsonb))
  ) INTO v;
  RETURN v;
END $$;

-- Check one address again on the next run.
CREATE OR REPLACE FUNCTION public.email_verification_request_recheck(p_email text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.email_verifications SET next_check_at = now(), updated_at = now() WHERE email = lower(trim(p_email));
  RETURN FOUND;
END $$;

-- After a paid provider is turned on: check every domain-level result again
-- so it gets a mailbox check, prospects first (the due order handles that).
CREATE OR REPLACE FUNCTION public.email_verification_requeue_domain_level()
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.email_verifications
     SET next_check_at = now(), updated_at = now()
   WHERE level = 'domain' AND status IN ('valid', 'risky') AND next_check_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Lift this module's broadcast suppression for one address, e.g. after
-- confirming it works. Only rows this module added, and only on an admin's
-- say-so: the same row may also be standing in for an unsubscribe that was
-- ignored as a duplicate, so this is never done automatically.
CREATE OR REPLACE FUNCTION public.email_verification_lift_suppression(p_email text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  n integer := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF to_regclass('public.broadcast_suppressions') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.broadcast_suppressions
              WHERE lower(email) = $1 AND topic = ''all'' AND source = ''email-verification'''
      USING lower(trim(p_email));
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;
  RETURN n;
END $$;

-- ----------------------------------------------------------------------------
-- Privileges. New functions are executable by PUBLIC by default. Revoke that
-- first, in plain statements, so a later failure cannot roll it back.
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.email_verification_due(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_verification_try_lease(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_verification_release_lease(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_verification_apply(text, text, text, text, text, text, text, timestamptz, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_verification_record(jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_verification_add_usage(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_verification_on_bounce() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_verification_summary() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_verification_request_recheck(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_verification_requeue_domain_level() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_verification_lift_suppression(text) FROM PUBLIC;

-- Supabase grants anon and authenticated directly as well. Each role is
-- handled on its own, so a database without one of them still gets the rest.
DO $$
DECLARE
  f text;
  service_only text[] := ARRAY[
    'public.email_verification_due(integer)',
    'public.email_verification_try_lease(text, integer)',
    'public.email_verification_release_lease(text)',
    'public.email_verification_apply(text, text, text, text, text, text, text, timestamptz, boolean)',
    'public.email_verification_record(jsonb, boolean)',
    'public.email_verification_add_usage(text, integer)',
    'public.email_verification_on_bounce()'];
  admin_rpcs text[] := ARRAY[
    'public.email_verification_summary()',
    'public.email_verification_request_recheck(text)',
    'public.email_verification_requeue_domain_level()',
    'public.email_verification_lift_suppression(text)'];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    FOREACH f IN ARRAY service_only || admin_rpcs LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f); END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH f IN ARRAY service_only LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f); END LOOP;
    FOREACH f IN ARRAY admin_rpcs LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f); END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    FOREACH f IN ARRAY service_only LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f); END LOOP;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Erasure: both tables hold the address and nothing else about the person.
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  IF to_regproc('public.compliance_register_personal_data') IS NOT NULL THEN
    PERFORM public.compliance_register_personal_data(
      '{"table":"email_verifications","owner":"email-verification","action":"delete","email":["email"],"note":"Verification result per address."}');
    PERFORM public.compliance_register_personal_data(
      '{"table":"email_verification_provider_results","owner":"email-verification","action":"delete","email":["email"],"note":"Answers from paid verification providers."}');
  END IF;
END $$;
