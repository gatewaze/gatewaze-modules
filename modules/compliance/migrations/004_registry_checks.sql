-- ============================================================================
-- Module: compliance
-- Migration: 004_registry_checks
-- Description: Move the "registry names a missing column" check out of the
-- per-request preview, fix two registry entries.
--
-- A registry column can be missing on one database because the owning
-- module's later migrations haven't run there (e.g. a disabled module on an
-- older schema). A column that doesn't exist can't hold anyone's data, so it
-- can't hide rows from an erasure, and the warning gave the person running
-- an erasure nothing to act on. It now lives in
-- compliance_registry_missing_columns() for maintainers.
-- ============================================================================

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
        EXECUTE format('SELECT count(*) FROM public.%I WHERE EXISTS (SELECT 1 FROM unnest(%I) x(v) WHERE lower(btrim(x.v)) = ANY(%L::text[]))',
                       c.table_name, c.column_name, v_emails) INTO v_count;
      ELSE
        EXECUTE format('SELECT count(*) FROM public.%I WHERE lower(btrim(%I)) = ANY(%L::text[])',
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

-- Registry entries whose declared columns don't exist on this database.
CREATE OR REPLACE FUNCTION public.compliance_registry_missing_columns()
RETURNS TABLE (table_name text, entry text, column_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT r.table_name, r.entry, c
  FROM public.compliance_personal_data_registry r,
       unnest(r.person_cols || r.profile_cols || r.registration_cols || r.auth_cols ||
              r.cio_cols || r.email_cols || r.email_array_cols || r.phone_cols) AS c
  WHERE to_regclass('public.' || quote_ident(r.table_name)) IS NOT NULL
    AND public.compliance__col_type(r.table_name, c) IS NULL
  ORDER BY 1, 2, 3
$$;

REVOKE ALL ON FUNCTION public.compliance_registry_missing_columns() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_registry_missing_columns() TO service_role;

-- integrations_slack_user_tokens has no email column: staff tokens, keyed by
-- the staff user who connected them.
SELECT public.compliance_register_personal_data(
  '{"table":"integrations_slack_user_tokens","owner":"slack","action":"ignore","covers":["*"],"note":"Staff Slack tokens."}');

-- email_logs.from_email is our own sender address.
SELECT public.compliance_register_personal_data(
  '{"table":"email_logs","owner":"core","action":"anonymise","email":["to_email"],"clear":["metadata"],"replace":{"to_email":"{erased_email}"},"covers":["from_email"],"order":50}');
