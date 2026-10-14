-- ============================================================================
-- Module: compliance
-- Migration: 002_erasure_engine
-- Description: Data subject erasure (GDPR Art. 17) and marketing suppression.
--
-- Pieces:
--   compliance_personal_data_registry   which tables hold personal data, how to
--                                       match a person's rows, and whether to
--                                       delete or anonymise them. Any module
--                                       can register its own tables through
--                                       compliance_register_personal_data().
--   compliance_suppressions             sha256 of erased / objecting emails.
--                                       Sends skip them and subscription
--                                       triggers refuse to re-subscribe them.
--   compliance_erasure_identify()       resolve every identifier for a person.
--   compliance_erasure_plan()           count what an erasure would touch and
--                                       list anything that blocks it. Changes
--                                       nothing.
--   compliance_erasure_execute()        apply the plan in one transaction,
--                                       verify nothing is left, write the
--                                       suppressions and the report.
--   compliance_erasure_coverage()       personal-looking columns that no
--                                       registry entry covers.
--
-- The engine fails closed. A person row linked from an unregistered table
-- (SET NULL or NO ACTION foreign key), or an unregistered email column that
-- holds one of the person's addresses, blocks the erasure until someone
-- registers it.
--
-- The functions run long scans on large tables (email_send_log is millions
-- of rows), so they are called by the compliance worker over a direct
-- Postgres connection, not through PostgREST and its 8 second timeout.
-- ============================================================================

-- ── Request tracking ─────────────────────────────────────────────────────────
ALTER TABLE public.compliance_privacy_requests
  ADD COLUMN IF NOT EXISTS subject_emails        text[],
  ADD COLUMN IF NOT EXISTS subject_email_sha256  text[],
  ADD COLUMN IF NOT EXISTS source                text,
  ADD COLUMN IF NOT EXISTS due_at                timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_via         text,
  ADD COLUMN IF NOT EXISTS submitted_by          text,
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS identifiers           jsonb,
  ADD COLUMN IF NOT EXISTS plan                  jsonb,
  ADD COLUMN IF NOT EXISTS plan_status           text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS plan_error            text,
  ADD COLUMN IF NOT EXISTS plan_built_at         timestamptz,
  ADD COLUMN IF NOT EXISTS previewed_by          text,
  ADD COLUMN IF NOT EXISTS execute_status        text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS executed_by           text,
  ADD COLUMN IF NOT EXISTS executed_at           timestamptz,
  ADD COLUMN IF NOT EXISTS report                jsonb,
  ADD COLUMN IF NOT EXISTS processors            jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS checklist             jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS redacted_at           timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_privacy_requests_plan_status_check') THEN
    ALTER TABLE public.compliance_privacy_requests
      ADD CONSTRAINT compliance_privacy_requests_plan_status_check
      CHECK (plan_status IN ('none', 'queued', 'running', 'ready', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_privacy_requests_execute_status_check') THEN
    ALTER TABLE public.compliance_privacy_requests
      ADD CONSTRAINT compliance_privacy_requests_execute_status_check
      CHECK (execute_status IN ('none', 'queued', 'running', 'erased', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_privacy_requests_submitted_via_check') THEN
    ALTER TABLE public.compliance_privacy_requests
      ADD CONSTRAINT compliance_privacy_requests_submitted_via_check
      CHECK (submitted_via IS NULL OR submitted_via IN ('admin', 'api', 'mcp'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_compliance_privacy_requests_email_sha256
  ON public.compliance_privacy_requests USING gin (subject_email_sha256);

-- ── Email hashing ────────────────────────────────────────────────────────────
-- Same normalisation as warehouse-sync's email_sha256, so the warehouse can
-- filter on the suppression table directly.
CREATE OR REPLACE FUNCTION public.compliance_email_sha256(p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_email IS NULL OR btrim(p_email) = '' THEN NULL
    ELSE encode(sha256(convert_to(lower(btrim(p_email)), 'UTF8')), 'hex')
  END
$$;

-- ── Suppressions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.compliance_suppressions (
  email_sha256  text PRIMARY KEY CHECK (email_sha256 ~ '^[0-9a-f]{64}$'),
  scope         text NOT NULL CHECK (scope IN ('all', 'marketing')),
  request_id    uuid REFERENCES public.compliance_privacy_requests (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.compliance_suppressions IS
  'sha256 of emails that must never receive marketing again (erasure or Art. 21 objection). Holds no other personal data.';

ALTER TABLE public.compliance_suppressions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "compliance_suppressions_select" ON public.compliance_suppressions;
CREATE POLICY "compliance_suppressions_select" ON public.compliance_suppressions
  FOR SELECT TO authenticated USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.compliance_is_suppressed(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.compliance_suppressions
    WHERE email_sha256 = public.compliance_email_sha256(p_email)
  )
$$;

REVOKE ALL ON FUNCTION public.compliance_is_suppressed(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_is_suppressed(text) TO service_role;

-- Subscription guard. Many code paths write subscription rows (imports,
-- signup forms, the lists API, Customer.io webhooks), so the only single
-- choke point is the table itself: a suppressed address can't be
-- (re-)subscribed by anything.
CREATE OR REPLACE FUNCTION public.compliance_block_suppressed_subscription()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email text := to_jsonb(NEW) ->> TG_ARGV[0];
BEGIN
  IF v_email IS NULL OR NOT public.compliance_is_suppressed(v_email) THEN
    RETURN NEW;
  END IF;
  IF TG_ARGV[1] = 'subscribed' THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(
      'subscribed', false,
      'unsubscribed_at', coalesce(to_jsonb(NEW) ->> 'unsubscribed_at', now()::text)));
  ELSIF TG_ARGV[1] = 'unsubscribed_at' THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(
      'unsubscribed_at', coalesce(to_jsonb(NEW) ->> 'unsubscribed_at', now()::text)));
  END IF;
  RETURN NEW;
END $$;

-- Installs the guard on whichever subscription tables exist. Idempotent. Runs
-- here and again at the start of every erasure, so a module installed after
-- compliance still gets its guard before the first suppression lands.
CREATE OR REPLACE FUNCTION public.compliance_install_suppression_triggers()
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t record;
  v_installed text[] := '{}';
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('list_subscriptions',  'email', 'subscribed'),
      ('email_subscriptions', 'email', 'subscribed'),
      ('calendars_members',   'email', 'unsubscribed_at')
    ) AS v(tbl, email_col, mode)
  LOOP
    IF to_regclass('public.' || quote_ident(t.tbl)) IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'compliance_suppression_guard'
        AND tgrelid = to_regclass('public.' || quote_ident(t.tbl))
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER compliance_suppression_guard BEFORE INSERT OR UPDATE ON public.%I
           FOR EACH ROW EXECUTE FUNCTION public.compliance_block_suppressed_subscription(%L, %L)',
        t.tbl, t.email_col, t.mode);
    END IF;
    v_installed := v_installed || t.tbl;
  END LOOP;
  RETURN v_installed;
END $$;

SELECT public.compliance_install_suppression_triggers();

-- ── Personal data registry ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.compliance_personal_data_registry (
  table_name        text NOT NULL,
  entry             text NOT NULL DEFAULT 'default',
  owner_module      text NOT NULL,
  action            text NOT NULL CHECK (action IN ('delete', 'anonymise', 'ignore')),
  person_cols       text[] NOT NULL DEFAULT '{}',  -- hold people.id
  profile_cols      text[] NOT NULL DEFAULT '{}',  -- hold people_profiles.id
  registration_cols text[] NOT NULL DEFAULT '{}',  -- hold events_registrations.id
  auth_cols         text[] NOT NULL DEFAULT '{}',  -- hold auth.users.id
  cio_cols          text[] NOT NULL DEFAULT '{}',  -- hold a Customer.io id
  email_cols        text[] NOT NULL DEFAULT '{}',  -- hold an email address
  email_array_cols  text[] NOT NULL DEFAULT '{}',  -- text[] of email addresses
  phone_cols        text[] NOT NULL DEFAULT '{}',  -- hold a phone number
  json_email        jsonb  NOT NULL DEFAULT '[]',  -- [{"column": "payload", "path": ["email"]}]
  parent            jsonb,                         -- {"table", "column", "parent_column", "entry"}
  clear_cols        text[] NOT NULL DEFAULT '{}',  -- anonymise: set NULL
  replace_cols      jsonb  NOT NULL DEFAULT '{}',  -- anonymise: {"col": "{erased_email}" | "{erased}" | literal}
  covers_cols       text[] NOT NULL DEFAULT '{}',  -- other personal columns this entry accounts for; '*' = the whole table
  retain            jsonb,                         -- {"reason", "basis", "period"} for legal holds
  note              text,
  sort_order        integer NOT NULL DEFAULT 100,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, entry)
);

COMMENT ON TABLE public.compliance_personal_data_registry IS
  'Where personal data lives and how erasure treats it. Modules register their own tables with compliance_register_personal_data().';

ALTER TABLE public.compliance_personal_data_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "compliance_registry_select" ON public.compliance_personal_data_registry;
CREATE POLICY "compliance_registry_select" ON public.compliance_personal_data_registry
  FOR SELECT TO authenticated USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.compliance__jtext(p jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(array_agg(x), '{}') FROM jsonb_array_elements_text(coalesce(p, '[]'::jsonb)) AS x
$$;

-- Upsert one registry entry. Keys: table, entry, owner, action, person,
-- profile, registration, auth, cio, email, email_array, phone, json_email,
-- parent, clear, replace, covers, retain, note, order.
CREATE OR REPLACE FUNCTION public.compliance_register_personal_data(p jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(p ->> 'table', '') = '' OR coalesce(p ->> 'owner', '') = '' OR coalesce(p ->> 'action', '') = '' THEN
    RAISE EXCEPTION 'compliance_register_personal_data: table, owner and action are required (%)', p;
  END IF;
  INSERT INTO public.compliance_personal_data_registry AS r (
    table_name, entry, owner_module, action,
    person_cols, profile_cols, registration_cols, auth_cols, cio_cols,
    email_cols, email_array_cols, phone_cols, json_email, parent,
    clear_cols, replace_cols, covers_cols, retain, note, sort_order, updated_at
  ) VALUES (
    p ->> 'table', coalesce(p ->> 'entry', 'default'), p ->> 'owner', p ->> 'action',
    compliance__jtext(p -> 'person'), compliance__jtext(p -> 'profile'),
    compliance__jtext(p -> 'registration'), compliance__jtext(p -> 'auth'),
    compliance__jtext(p -> 'cio'), compliance__jtext(p -> 'email'),
    compliance__jtext(p -> 'email_array'), compliance__jtext(p -> 'phone'),
    coalesce(p -> 'json_email', '[]'::jsonb), p -> 'parent',
    compliance__jtext(p -> 'clear'), coalesce(p -> 'replace', '{}'::jsonb),
    compliance__jtext(p -> 'covers'), p -> 'retain', p ->> 'note',
    coalesce((p ->> 'order')::int, 100), now()
  )
  ON CONFLICT (table_name, entry) DO UPDATE SET
    owner_module = EXCLUDED.owner_module, action = EXCLUDED.action,
    person_cols = EXCLUDED.person_cols, profile_cols = EXCLUDED.profile_cols,
    registration_cols = EXCLUDED.registration_cols, auth_cols = EXCLUDED.auth_cols,
    cio_cols = EXCLUDED.cio_cols, email_cols = EXCLUDED.email_cols,
    email_array_cols = EXCLUDED.email_array_cols, phone_cols = EXCLUDED.phone_cols,
    json_email = EXCLUDED.json_email, parent = EXCLUDED.parent,
    clear_cols = EXCLUDED.clear_cols, replace_cols = EXCLUDED.replace_cols,
    covers_cols = EXCLUDED.covers_cols, retain = EXCLUDED.retain, note = EXCLUDED.note,
    sort_order = EXCLUDED.sort_order, updated_at = now();
END $$;

-- ── Engine helpers ───────────────────────────────────────────────────────────
-- Type of a public column, or NULL when the table or column doesn't exist.
CREATE OR REPLACE FUNCTION public.compliance__col_type(p_table text, p_col text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT format_type(a.atttypid, NULL)
  FROM pg_attribute a
  WHERE a.attrelid = to_regclass('public.' || quote_ident(p_table))
    AND a.attname = p_col AND a.attnum > 0 AND NOT a.attisdropped
$$;

CREATE OR REPLACE FUNCTION public.compliance__col_notnull(p_table text, p_col text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce((
    SELECT a.attnotnull FROM pg_attribute a
    WHERE a.attrelid = to_regclass('public.' || quote_ident(p_table))
      AND a.attname = p_col AND a.attnum > 0 AND NOT a.attisdropped), false)
$$;

-- "<col> matches one of these ids", typed so uuid columns can use their index.
CREATE OR REPLACE FUNCTION public.compliance__id_match(p_table text, p_col text, p_ids jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_type text := public.compliance__col_type(p_table, p_col);
  v_ids text[] := public.compliance__jtext(p_ids);
BEGIN
  IF v_type IS NULL OR cardinality(v_ids) = 0 THEN
    RETURN NULL;
  END IF;
  IF v_type = 'uuid' THEN
    RETURN format('%I = ANY(%L::uuid[])', p_col, v_ids);
  END IF;
  RETURN format('%I::text = ANY(%L::text[])', p_col, v_ids);
END $$;

-- WHERE clause matching every row of p_entry that belongs to the person, or
-- NULL when the entry has nothing to match on this database.
CREATE OR REPLACE FUNCTION public.compliance__erasure_predicate(
  p_entry public.compliance_personal_data_registry,
  p_ident jsonb,
  p_depth int DEFAULT 0
)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_parts  text[] := '{}';
  v_col    text;
  v_type   text;
  v_part   text;
  v_j      jsonb;
  v_emails text[] := public.compliance__jtext(p_ident -> 'emails');
  v_phones text[] := public.compliance__jtext(p_ident -> 'phones');
  v_parent public.compliance_personal_data_registry;
  v_ppred  text;
  v_tbl    text := p_entry.table_name;
BEGIN
  IF to_regclass('public.' || quote_ident(v_tbl)) IS NULL THEN
    RETURN NULL;
  END IF;

  FOREACH v_col IN ARRAY p_entry.person_cols LOOP
    v_part := public.compliance__id_match(v_tbl, v_col, p_ident -> 'person_ids');
    IF v_part IS NOT NULL THEN v_parts := v_parts || v_part; END IF;
  END LOOP;
  FOREACH v_col IN ARRAY p_entry.profile_cols LOOP
    v_part := public.compliance__id_match(v_tbl, v_col, p_ident -> 'profile_ids');
    IF v_part IS NOT NULL THEN v_parts := v_parts || v_part; END IF;
  END LOOP;
  FOREACH v_col IN ARRAY p_entry.registration_cols LOOP
    v_part := public.compliance__id_match(v_tbl, v_col, p_ident -> 'registration_ids');
    IF v_part IS NOT NULL THEN v_parts := v_parts || v_part; END IF;
  END LOOP;
  FOREACH v_col IN ARRAY p_entry.auth_cols LOOP
    v_part := public.compliance__id_match(v_tbl, v_col, p_ident -> 'auth_user_ids');
    IF v_part IS NOT NULL THEN v_parts := v_parts || v_part; END IF;
  END LOOP;
  FOREACH v_col IN ARRAY p_entry.cio_cols LOOP
    v_part := public.compliance__id_match(v_tbl, v_col, p_ident -> 'cio_ids');
    IF v_part IS NOT NULL THEN v_parts := v_parts || v_part; END IF;
  END LOOP;

  IF cardinality(v_emails) > 0 THEN
    FOREACH v_col IN ARRAY p_entry.email_cols LOOP
      v_type := public.compliance__col_type(v_tbl, v_col);
      IF v_type IN ('text', 'character varying', 'citext') THEN
        v_parts := v_parts || format('lower(%I) = ANY(%L::text[])', v_col, v_emails);
      END IF;
    END LOOP;
    FOREACH v_col IN ARRAY p_entry.email_array_cols LOOP
      v_type := public.compliance__col_type(v_tbl, v_col);
      IF v_type IN ('text[]', 'character varying[]') THEN
        v_parts := v_parts || format(
          'EXISTS (SELECT 1 FROM unnest(%I) AS x(v) WHERE lower(x.v) = ANY(%L::text[]))', v_col, v_emails);
      END IF;
    END LOOP;
    FOR v_j IN SELECT * FROM jsonb_array_elements(p_entry.json_email) LOOP
      v_type := public.compliance__col_type(v_tbl, v_j ->> 'column');
      IF v_type IN ('jsonb', 'json') THEN
        v_parts := v_parts || format('lower(%I::jsonb #>> %L::text[]) = ANY(%L::text[])',
          v_j ->> 'column', public.compliance__jtext(v_j -> 'path'), v_emails);
      END IF;
    END LOOP;
  END IF;

  IF cardinality(v_phones) > 0 THEN
    FOREACH v_col IN ARRAY p_entry.phone_cols LOOP
      v_type := public.compliance__col_type(v_tbl, v_col);
      IF v_type IN ('text', 'character varying') THEN
        v_parts := v_parts || format(
          'regexp_replace(%I, ''\D'', '''', ''g'') = ANY(%L::text[])', v_col, v_phones);
      END IF;
    END LOOP;
  END IF;

  -- Rows that belong to the person through a parent row, e.g. opens and
  -- clicks of a send log row sent to them.
  IF p_entry.parent IS NOT NULL AND p_depth < 2 THEN
    SELECT * INTO v_parent FROM public.compliance_personal_data_registry
    WHERE table_name = p_entry.parent ->> 'table'
      AND entry = coalesce(p_entry.parent ->> 'entry', 'default');
    IF FOUND THEN
      v_ppred := public.compliance__erasure_predicate(v_parent, p_ident, p_depth + 1);
      IF v_ppred IS NOT NULL AND public.compliance__col_type(v_tbl, p_entry.parent ->> 'column') IS NOT NULL THEN
        v_parts := v_parts || format('%I IN (SELECT %I FROM public.%I WHERE %s)',
          p_entry.parent ->> 'column',
          coalesce(p_entry.parent ->> 'parent_column', 'id'),
          v_parent.table_name, v_ppred);
      END IF;
    END IF;
  END IF;

  IF cardinality(v_parts) = 0 THEN
    RETURN NULL;
  END IF;
  RETURN '(' || array_to_string(v_parts, ' OR ') || ')';
END $$;

-- Columns an anonymise entry writes: every match column plus clear/replace.
CREATE OR REPLACE FUNCTION public.compliance__anonymise_targets(p_entry public.compliance_personal_data_registry)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(array_agg(DISTINCT c), '{}') FROM unnest(
    p_entry.person_cols || p_entry.profile_cols || p_entry.registration_cols ||
    p_entry.auth_cols || p_entry.cio_cols || p_entry.email_cols ||
    p_entry.email_array_cols || p_entry.phone_cols || p_entry.clear_cols ||
    ARRAY(SELECT jsonb_object_keys(p_entry.replace_cols))
  ) AS c
$$;

CREATE OR REPLACE FUNCTION public.compliance__replace_expr(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_value
    -- unique per row so unique(email, ...) constraints can't collide
    WHEN '{erased_email}' THEN
      $x$('erased+' || substr(md5(random()::text || clock_timestamp()::text), 1, 16) || '@erased.invalid')$x$
    WHEN '{erased}' THEN quote_literal('erased')
    ELSE quote_literal(p_value)
  END
$$;

-- SET list for an anonymise entry. Columns that don't exist here are skipped.
CREATE OR REPLACE FUNCTION public.compliance__anonymise_set(p_entry public.compliance_personal_data_registry)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_sets text[] := '{}';
  v_col  text;
  v_j    jsonb;
  v_expr text;
BEGIN
  FOREACH v_col IN ARRAY public.compliance__anonymise_targets(p_entry) LOOP
    IF public.compliance__col_type(p_entry.table_name, v_col) IS NULL THEN
      CONTINUE;
    END IF;
    IF p_entry.replace_cols ? v_col THEN
      v_sets := v_sets || format('%I = %s', v_col, public.compliance__replace_expr(p_entry.replace_cols ->> v_col));
    ELSE
      v_sets := v_sets || format('%I = NULL', v_col);
    END IF;
  END LOOP;
  -- JSON columns keep everything except the email paths.
  FOR v_j IN SELECT * FROM jsonb_array_elements(p_entry.json_email) LOOP
    v_col := v_j ->> 'column';
    IF v_col = ANY(public.compliance__anonymise_targets(p_entry))
       OR public.compliance__col_type(p_entry.table_name, v_col) IS DISTINCT FROM 'jsonb' THEN
      CONTINUE;
    END IF;
    v_expr := format('%I #- %L::text[]', v_col, public.compliance__jtext(v_j -> 'path'));
    v_sets := v_sets || format('%I = %s', v_col, v_expr);
  END LOOP;
  IF cardinality(v_sets) = 0 THEN
    RETURN NULL;
  END IF;
  RETURN array_to_string(v_sets, ', ');
END $$;

-- ── Coverage ─────────────────────────────────────────────────────────────────
-- Personal-looking columns in public base tables that no registry entry
-- accounts for. CI fails on any row; the plan probes the email ones.
CREATE OR REPLACE FUNCTION public.compliance_erasure_coverage()
RETURNS TABLE (table_name text, column_name text, data_type text, is_email boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.table_name::text, c.column_name::text, format_type(a.atttypid, NULL),
         (c.column_name ~* '(^|_)e_?mails?$|(^|_)e_?mail_(address|addresses|to|from)$|(^|_)(from|to|recipient|reply_to)_address(es)?$'
          AND format_type(a.atttypid, NULL) IN ('text', 'character varying', 'citext', 'text[]', 'character varying[]'))
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
  JOIN pg_attribute a
    ON a.attrelid = to_regclass('public.' || quote_ident(c.table_name)) AND a.attname = c.column_name
  WHERE c.table_schema = 'public'
    AND (
      c.column_name ~* '(^|_)e_?mails?$|(^|_)e_?mail_(address|addresses|to|from)$'
      OR c.column_name ~* '(^|_)(phone|phone_number|mobile|to_number|ip|ip_address|ip_cidr|user_agent|first_name|last_name|full_name|guest_name|applicant_name|from_name|from_address|to_address|to_addresses|recipient_address)$'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.compliance_personal_data_registry r
      WHERE r.table_name = c.table_name
        AND (
          r.action = 'delete'
          OR '*' = ANY(r.covers_cols)
          OR c.column_name = ANY(
               r.person_cols || r.profile_cols || r.registration_cols || r.auth_cols ||
               r.cio_cols || r.email_cols || r.email_array_cols || r.phone_cols ||
               r.clear_cols || r.covers_cols)
          OR r.replace_cols ? c.column_name
        )
    )
  ORDER BY 1, 2
$$;

-- ── Identify ─────────────────────────────────────────────────────────────────
-- Every identifier for the people behind these emails: aliases recorded on the
-- person (attributes.other_emails), addresses of records merged into them
-- (people_merge_audit), profiles, registrations, auth users, Customer.io ids,
-- phones and Slack ids. Repeats until no new email turns up.
CREATE OR REPLACE FUNCTION public.compliance_erasure_identify(p_emails text[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_emails   text[];
  v_more     text[];
  v_more_people uuid[];
  v_people   uuid[] := '{}';
  v_profiles uuid[] := '{}';
  v_regs     uuid[] := '{}';
  v_prev     int := -1;
  i          int;
BEGIN
  SELECT coalesce(array_agg(DISTINCT lower(btrim(x))), '{}') INTO v_emails
  FROM unnest(p_emails) AS x
  WHERE x IS NOT NULL AND btrim(x) <> '';
  IF cardinality(v_emails) = 0 THEN
    RAISE EXCEPTION 'compliance_erasure_identify: at least one email is required';
  END IF;

  FOR i IN 1..5 LOOP
    EXIT WHEN cardinality(v_emails) = v_prev;
    v_prev := cardinality(v_emails);

    SELECT coalesce(array_agg(p.id), '{}') INTO v_people
    FROM public.people p
    WHERE lower(p.email) = ANY(v_emails)
       OR (jsonb_typeof(p.attributes -> 'other_emails') = 'array'
           AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p.attributes -> 'other_emails') o
                       WHERE lower(btrim(o)) = ANY(v_emails)));

    SELECT coalesce(array_agg(DISTINCT x), '{}') INTO v_emails FROM (
      SELECT unnest(v_emails) AS x
      UNION SELECT lower(btrim(p.email)) FROM public.people p WHERE p.id = ANY(v_people)
      UNION SELECT lower(btrim(o))
        FROM public.people p,
             jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.attributes -> 'other_emails') = 'array'
                                            THEN p.attributes -> 'other_emails' ELSE '[]'::jsonb END) o
        WHERE p.id = ANY(v_people)
    ) s WHERE x IS NOT NULL AND x <> '';

    -- Verified alias addresses (email alias identity).
    IF to_regclass('public.person_emails') IS NOT NULL THEN
      EXECUTE 'SELECT coalesce(array_agg(DISTINCT person_id), ''{}'') FROM public.person_emails
                WHERE lower(email) = ANY($1) OR lower(canonical_email) = ANY($1)'
        INTO v_more_people USING v_emails;
      SELECT coalesce(array_agg(DISTINCT x), '{}') INTO v_people FROM unnest(v_people || v_more_people) AS x;
      EXECUTE 'SELECT coalesce(array_agg(DISTINCT lower(btrim(e))), ''{}'')
                 FROM public.person_emails pe, LATERAL unnest(ARRAY[pe.email, pe.canonical_email]) AS e
                WHERE pe.person_id = ANY($1) AND e IS NOT NULL'
        INTO v_more USING v_people;
      SELECT coalesce(array_agg(DISTINCT x), '{}') INTO v_emails FROM unnest(v_emails || v_more) AS x;
      SELECT coalesce(array_agg(DISTINCT lower(btrim(p.email))), '{}') INTO v_more
        FROM public.people p WHERE p.id = ANY(v_people);
      SELECT coalesce(array_agg(DISTINCT x), '{}') INTO v_emails FROM unnest(v_emails || v_more) AS x;
    END IF;

    IF to_regclass('public.people_merge_audit') IS NOT NULL THEN
      EXECUTE 'SELECT coalesce(array_agg(DISTINCT lower(btrim(dup_email))), ''{}'')
                 FROM public.people_merge_audit
                WHERE survivor_id = ANY($1) AND dup_email IS NOT NULL'
        INTO v_more USING v_people;
      SELECT coalesce(array_agg(DISTINCT x), '{}') INTO v_emails
      FROM unnest(v_emails || v_more) AS x;
    END IF;
  END LOOP;

  IF to_regclass('public.people_profiles') IS NOT NULL THEN
    EXECUTE 'SELECT coalesce(array_agg(id), ''{}'') FROM public.people_profiles WHERE person_id = ANY($1)'
      INTO v_profiles USING v_people;
  END IF;
  IF to_regclass('public.events_registrations') IS NOT NULL THEN
    IF public.compliance__col_type('events_registrations', 'people_profile_id') IS NOT NULL THEN
      EXECUTE 'SELECT coalesce(array_agg(id), ''{}'') FROM public.events_registrations
                WHERE person_id = ANY($1) OR people_profile_id = ANY($2)'
        INTO v_regs USING v_people, v_profiles;
    ELSE
      EXECUTE 'SELECT coalesce(array_agg(id), ''{}'') FROM public.events_registrations WHERE person_id = ANY($1)'
        INTO v_regs USING v_people;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'emails', to_jsonb(v_emails),
    'person_ids', to_jsonb(v_people),
    'profile_ids', to_jsonb(v_profiles),
    'registration_ids', to_jsonb(v_regs),
    'auth_user_ids', (SELECT coalesce(jsonb_agg(DISTINCT auth_user_id), '[]')
                      FROM public.people WHERE id = ANY(v_people) AND auth_user_id IS NOT NULL),
    'cio_ids', (SELECT coalesce(jsonb_agg(DISTINCT cio_id), '[]')
                FROM public.people WHERE id = ANY(v_people) AND coalesce(cio_id, '') <> ''),
    'phones', (SELECT coalesce(jsonb_agg(DISTINCT d), '[]') FROM (
                 SELECT regexp_replace(phone, '\D', '', 'g') AS d
                 FROM public.people WHERE id = ANY(v_people) AND phone IS NOT NULL) s
               WHERE length(d) >= 7),
    'slack_user_ids', (SELECT coalesce(jsonb_agg(DISTINCT attributes ->> 'slack_user_id'), '[]')
                       FROM public.people
                       WHERE id = ANY(v_people) AND coalesce(attributes ->> 'slack_user_id', '') <> '')
  );
END $$;

-- ── Plan ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compliance_erasure_plan(p_ident jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  e          public.compliance_personal_data_registry;
  fk         record;
  c          record;
  v_pred     text;
  v_count    bigint;
  v_total    bigint := 0;
  v_tables   jsonb := '[]';
  v_blockers jsonb := '[]';
  v_warnings jsonb := '[]';
  v_ids      jsonb;
  v_covered  boolean;
  v_col      text;
  v_emails   text[] := public.compliance__jtext(p_ident -> 'emails');
BEGIN
  IF jsonb_array_length(coalesce(p_ident -> 'person_ids', '[]')) > 1 THEN
    v_warnings := v_warnings || jsonb_build_object(
      'kind', 'multiple_people',
      'detail', format('%s people records matched these emails. Check they are all the same person before erasing.',
                       jsonb_array_length(p_ident -> 'person_ids')));
  END IF;
  IF jsonb_array_length(coalesce(p_ident -> 'person_ids', '[]')) = 0 THEN
    v_warnings := v_warnings || jsonb_build_object(
      'kind', 'no_person',
      'detail', 'No people record matched. Erasure will still remove rows keyed by email and record the suppression.');
  END IF;

  -- Registered tables.
  FOR e IN
    SELECT * FROM public.compliance_personal_data_registry
    ORDER BY sort_order, table_name, entry
  LOOP
    v_pred := public.compliance__erasure_predicate(e, p_ident);
    IF v_pred IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %s', e.table_name, v_pred) INTO v_count;
    IF v_count = 0 THEN
      CONTINUE;
    END IF;

    IF e.action = 'ignore' THEN
      v_blockers := v_blockers || jsonb_build_object(
        'kind', 'needs_review', 'table', e.table_name, 'entry', e.entry, 'rows', v_count,
        'detail', coalesce(e.note, 'This table is excluded from erasure but holds matching rows.'));
      CONTINUE;
    END IF;

    IF e.action = 'anonymise' THEN
      FOREACH v_col IN ARRAY public.compliance__anonymise_targets(e) LOOP
        IF public.compliance__col_notnull(e.table_name, v_col) AND NOT (e.replace_cols ? v_col) THEN
          v_blockers := v_blockers || jsonb_build_object(
            'kind', 'declaration', 'table', e.table_name, 'entry', e.entry, 'column', v_col,
            'detail', 'Anonymising would set a NOT NULL column to NULL. Add it to replace or change the action to delete.');
        END IF;
      END LOOP;
    END IF;

    v_total := v_total + v_count;
    v_tables := v_tables || jsonb_build_object(
      'table', e.table_name, 'entry', e.entry, 'owner', e.owner_module,
      'action', e.action, 'rows', v_count, 'retain', e.retain, 'note', e.note);
  END LOOP;

  -- Foreign keys to a person that no entry declares.
  FOR fk IN
    SELECT cl.relname::text AS tbl, a.attname::text AS col, rf.relname::text AS ref, con.confdeltype AS del
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_class rf ON rf.oid = con.confrelid
    JOIN pg_namespace rn ON rn.oid = rf.relnamespace
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    WHERE con.contype = 'f' AND cardinality(con.conkey) = 1
      AND n.nspname = 'public' AND rn.nspname = 'public'
      AND rf.relname IN ('people', 'people_profiles', 'events_registrations')
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM public.compliance_personal_data_registry r
      WHERE r.table_name = fk.tbl AND r.action <> 'ignore'
        AND fk.col = ANY(CASE fk.ref
                           WHEN 'people' THEN r.person_cols
                           WHEN 'people_profiles' THEN r.profile_cols
                           ELSE r.registration_cols END)
    ) INTO v_covered;
    IF v_covered THEN
      CONTINUE;
    END IF;
    v_ids := CASE fk.ref
               WHEN 'people' THEN p_ident -> 'person_ids'
               WHEN 'people_profiles' THEN p_ident -> 'profile_ids'
               ELSE p_ident -> 'registration_ids' END;
    IF jsonb_array_length(coalesce(v_ids, '[]')) = 0 THEN
      CONTINUE;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %s', fk.tbl,
                   public.compliance__id_match(fk.tbl, fk.col, v_ids)) INTO v_count;
    IF v_count = 0 THEN
      CONTINUE;
    END IF;
    IF fk.del = 'c' THEN
      -- The cascade removes these rows anyway. Worth registering, not blocking.
      v_warnings := v_warnings || jsonb_build_object(
        'kind', 'unregistered_cascade', 'table', fk.tbl, 'column', fk.col, 'rows', v_count,
        'detail', 'Removed by ON DELETE CASCADE, but not registered.');
    ELSE
      v_blockers := v_blockers || jsonb_build_object(
        'kind', 'unregistered_link', 'table', fk.tbl, 'column', fk.col, 'rows', v_count,
        'detail', format('Links to %s with ON DELETE %s and no registry entry, so these rows would survive or block the delete.',
                         fk.ref, CASE fk.del WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE 'NO ACTION' END));
    END IF;
  END LOOP;

  -- Email columns no entry covers that hold one of the addresses.
  IF cardinality(v_emails) > 0 THEN
    FOR c IN SELECT * FROM public.compliance_erasure_coverage() cov WHERE cov.is_email LOOP
      IF c.data_type IN ('text[]', 'character varying[]') THEN
        EXECUTE format('SELECT count(*) FROM public.%I WHERE EXISTS (SELECT 1 FROM unnest(%I) x(v) WHERE lower(x.v) = ANY(%L::text[]))',
                       c.table_name, c.column_name, v_emails) INTO v_count;
      ELSE
        EXECUTE format('SELECT count(*) FROM public.%I WHERE lower(%I) = ANY(%L::text[])',
                       c.table_name, c.column_name, v_emails) INTO v_count;
      END IF;
      IF v_count > 0 THEN
        v_blockers := v_blockers || jsonb_build_object(
          'kind', 'unregistered_column', 'table', c.table_name, 'column', c.column_name, 'rows', v_count,
          'detail', 'Holds one of these addresses but no registry entry covers the column.');
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'built_at', now(),
    'summary', jsonb_build_object(
      'emails', jsonb_array_length(coalesce(p_ident -> 'emails', '[]')),
      'people', jsonb_array_length(coalesce(p_ident -> 'person_ids', '[]')),
      'auth_users', jsonb_array_length(coalesce(p_ident -> 'auth_user_ids', '[]')),
      'tables', jsonb_array_length(v_tables),
      'rows', v_total),
    'tables', v_tables,
    'blockers', v_blockers,
    'warnings', v_warnings);
END $$;

-- Identify + plan for a stored request, saved on the request.
CREATE OR REPLACE FUNCTION public.compliance_erasure_preview(p_request_id uuid, p_actor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r      public.compliance_privacy_requests;
  v_id   jsonb;
  v_plan jsonb;
BEGIN
  SELECT * INTO r FROM public.compliance_privacy_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'privacy request % not found', p_request_id;
  END IF;
  IF r.redacted_at IS NOT NULL OR r.executed_at IS NOT NULL THEN
    RAISE EXCEPTION 'privacy request % has already been carried out', p_request_id;
  END IF;
  v_id := public.compliance_erasure_identify(coalesce(r.subject_emails, ARRAY[r.subject_email::text]));
  v_plan := public.compliance_erasure_plan(v_id);
  UPDATE public.compliance_privacy_requests
     SET identifiers = v_id, plan = v_plan, plan_status = 'ready', plan_error = NULL,
         plan_built_at = now(), previewed_by = p_actor,
         subject_person_id = coalesce(subject_person_id, (v_id -> 'person_ids' ->> 0)::uuid)
   WHERE id = p_request_id;
  RETURN v_plan;
END $$;

-- ── Execute ──────────────────────────────────────────────────────────────────
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

  -- 4. Suppress every address so nothing can re-subscribe or email them.
  INSERT INTO public.compliance_suppressions (email_sha256, scope, request_id)
  SELECT DISTINCT public.compliance_email_sha256(x), 'all', p_request_id
  FROM jsonb_array_elements_text(v_ident -> 'emails') AS x
  ON CONFLICT (email_sha256) DO UPDATE
    SET scope = 'all', request_id = EXCLUDED.request_id, updated_at = now();

  UPDATE public.compliance_privacy_requests
     SET identifiers = v_ident,
         plan = v_plan,
         execute_status = 'erased',
         executed_by = p_actor,
         executed_at = now(),
         status = 'in_progress',
         processing_started_at = coalesce(processing_started_at, now()),
         subject_email_sha256 = ARRAY(SELECT DISTINCT public.compliance_email_sha256(x)
                                      FROM jsonb_array_elements_text(v_ident -> 'emails') x),
         report = jsonb_build_object(
           'erased_at', now(),
           'database', v_results,
           'suppressed_emails', jsonb_array_length(v_ident -> 'emails'),
           'warnings', v_plan -> 'warnings')
   WHERE id = p_request_id;

  RETURN jsonb_build_object('database', v_results, 'identifiers', v_ident);
END $$;

-- Replace the request's plain identifiers with hashes once everything is done.
-- The row stays as the record that the request was handled (Art. 5(2)).
CREATE OR REPLACE FUNCTION public.compliance_privacy_request_redact(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.compliance_privacy_requests
     SET subject_email_sha256 = coalesce(subject_email_sha256, ARRAY(
           SELECT DISTINCT public.compliance_email_sha256(x)
           FROM unnest(coalesce(subject_emails, ARRAY[subject_email::text])) x)),
         subject_email = 'sha256:' || public.compliance_email_sha256(subject_email),
         subject_emails = NULL,
         subject_person_id = NULL,
         identifiers = CASE WHEN identifiers IS NULL THEN NULL ELSE jsonb_build_object(
           'emails', jsonb_array_length(coalesce(identifiers -> 'emails', '[]')),
           'people', jsonb_array_length(coalesce(identifiers -> 'person_ids', '[]')),
           'auth_users', jsonb_array_length(coalesce(identifiers -> 'auth_user_ids', '[]'))) END,
         redacted_at = now()
   WHERE id = p_request_id AND redacted_at IS NULL;
END $$;

-- ── Grants ───────────────────────────────────────────────────────────────────
-- The engine is only for the server (worker / API with the service role or
-- the database owner). Nothing here is callable by signed-in users or anon.
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.compliance_install_suppression_triggers()',
    'public.compliance_register_personal_data(jsonb)',
    'public.compliance_erasure_coverage()',
    'public.compliance_erasure_identify(text[])',
    'public.compliance_erasure_plan(jsonb)',
    'public.compliance_erasure_preview(uuid, text)',
    'public.compliance_erasure_execute(uuid, text)',
    'public.compliance_privacy_request_redact(uuid)',
    'public.compliance_block_suppressed_subscription()',
    'public.compliance__jtext(jsonb)',
    'public.compliance__col_type(text, text)',
    'public.compliance__col_notnull(text, text)',
    'public.compliance__id_match(text, text, jsonb)',
    'public.compliance__erasure_predicate(public.compliance_personal_data_registry, jsonb, int)',
    'public.compliance__anonymise_targets(public.compliance_personal_data_registry)',
    'public.compliance__replace_expr(text)',
    'public.compliance__anonymise_set(public.compliance_personal_data_registry)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
