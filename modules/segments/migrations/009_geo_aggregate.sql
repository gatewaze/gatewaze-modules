-- ============================================================================
-- Module: segments
-- Migration: 009_geo_aggregate
-- Description: Aggregate a segment's members by location for the audience map
-- preview. Rather than return one point per person (thousands of dots), group by
-- city/country and return each group's centroid (avg lat/lng from
-- people.attributes.location "lat,lng") + a count. The broadcast audience tab's
-- Map view renders these as count-sized circles. Mirrors segments_preview
-- (is_admin gate + segments_def_to_sql), so it respects the same filters.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.segments_geo_aggregate(p_definition jsonb, p_limit int DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_where text;
  v_rows  jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_where := public.segments_def_to_sql(p_definition);

  EXECUTE format($q$
    SELECT COALESCE(jsonb_agg(row), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
        'city',    COALESCE(NULLIF(p.attributes->>'city', ''), '(unknown)'),
        'country', COALESCE(NULLIF(p.attributes->>'country', ''), ''),
        'lat',     round(avg(split_part(p.attributes->>'location', ',', 1)::float8)::numeric, 4),
        'lng',     round(avg(split_part(p.attributes->>'location', ',', 2)::float8)::numeric, 4),
        'count',   count(*)
      ) AS row
      FROM public.people p
      WHERE %s
        AND p.attributes->>'location' ~ '^-?[0-9.]+,-?[0-9.]+$'
      GROUP BY COALESCE(NULLIF(p.attributes->>'city', ''), '(unknown)'),
               COALESCE(NULLIF(p.attributes->>'country', ''), '')
      ORDER BY count(*) DESC
      LIMIT %s
    ) sub
  $q$, v_where, GREATEST(p_limit, 0))
  INTO v_rows;

  RETURN COALESCE(v_rows, '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.segments_geo_aggregate(jsonb, int) TO authenticated;
