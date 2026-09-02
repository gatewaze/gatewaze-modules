-- ============================================================================
-- Module: segments
-- Migration: 015_test_recipient_optin
-- Description: Make the send-testing exclusion (migration 014) OPT-OUTABLE so
-- deliberate test sends work again. 014 unconditionally appended
--   AND (p.acquisition_source IS DISTINCT FROM 'send_testing')
-- to every audience predicate, which also blocked audiences that intentionally
-- target the synthetic test population (e.g. an email filter for the test domain
-- @pr-view.com came back empty).
--
-- New rule: the exclusion still applies by default, but is SKIPPED when the
-- definition explicitly targets test recipients — detected (cheaply, once per
-- compile, not per row) by any of:
--   * an `include_test: true` flag on the definition (for a builder toggle),
--   * the literal marker value `send_testing` appearing in the definition
--     (e.g. an acquisition_source = 'send_testing' condition),
--   * an email/domain filter matching a configured test domain
--     (platform_settings key 'send_testing_domains', comma-separated; set this
--     to the send-testing inbound_domain(s) for the install).
--
-- Recursion still lives in segments_def_to_sql_core; only the public wrapper
-- (which runs once at the top level) gains the conditional.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.segments_def_to_sql(def jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_core text := public.segments_def_to_sql_core(def);
  v_txt  text := lower(def::text);
  v_skip boolean := false;
  v_dom  text;
BEGIN
  -- Explicit opt-in: flag, or the marker value referenced anywhere.
  IF COALESCE((def->>'include_test')::boolean, false) OR v_txt LIKE '%send_testing%' THEN
    v_skip := true;
  ELSE
    -- Or an email/domain filter that mentions a configured test domain.
    FOR v_dom IN
      SELECT trim(x)
      FROM unnest(string_to_array(
             COALESCE((SELECT value FROM public.platform_settings WHERE key = 'send_testing_domains'), ''),
             ',')) AS x
      WHERE trim(x) <> ''
    LOOP
      IF v_txt LIKE '%' || lower(v_dom) || '%' THEN
        v_skip := true;
        EXIT;
      END IF;
    END LOOP;
  END IF;

  IF v_skip THEN
    RETURN '(' || v_core || ')';
  END IF;
  RETURN '(' || v_core || ') AND (p.acquisition_source IS DISTINCT FROM ''send_testing'')';
END $$;

COMMENT ON FUNCTION public.segments_def_to_sql(jsonb) IS
  'Compile a segment definition to a WHERE predicate over people p. Excludes synthetic send-testing people (acquisition_source=''send_testing'') by default, but skips that exclusion when the definition explicitly targets them (include_test flag, the send_testing marker value, or a configured test domain in platform_settings.send_testing_domains). Recursion lives in segments_def_to_sql_core.';
