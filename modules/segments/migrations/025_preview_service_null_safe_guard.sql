-- ============================================================================
-- Module: segments
-- Migration: 025_preview_service_null_safe_guard
-- Description: segments_preview_service's guard (012) did not raise when the
-- caller had no JWT claims: auth.role() is NULL there, so
-- NOT (NULL OR false) is NULL and IF treats it as false. It returns a sample
-- of people, so close it. Body unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.segments_preview_service(p_definition jsonb, p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $$
DECLARE
  v_where  text;
  v_count  bigint;
  v_sample jsonb;
BEGIN
  -- COALESCE: with no JWT claims auth.role() is NULL, NOT (NULL OR false) is
  -- NULL, and IF NULL does not raise.
  IF NOT (COALESCE(auth.role() = 'service_role', false) OR public.is_admin()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_where := public.segments_def_to_sql(p_definition);

  EXECUTE format('SELECT count(*) FROM public.people p WHERE %s', v_where)
    INTO v_count;

  EXECUTE format($q$
    SELECT COALESCE(jsonb_agg(row), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
        'id', p.id,
        'email', p.email,
        'name', COALESCE(NULLIF(TRIM(CONCAT_WS(' ', p.attributes->>'first_name', p.attributes->>'last_name')), ''), p.attributes->>'full_name'),
        'company', p.attributes->>'company',
        'job_title', p.attributes->>'job_title',
        'city', p.attributes->>'city',
        'state', p.attributes->>'state',
        'country', p.attributes->>'country',
        'country_code', p.attributes->>'country_code'
      ) AS row
      FROM public.people p
      WHERE %s
      ORDER BY p.created_at DESC
      LIMIT %s
    ) sub
  $q$, v_where, LEAST(GREATEST(p_limit, 0), 200))
    INTO v_sample;

  RETURN jsonb_build_object('count', v_count, 'sample', v_sample, 'is_estimate', false);
END;
$$;
