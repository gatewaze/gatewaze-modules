-- ============================================================================
-- Module: segments
-- Migration: 012_smart_geo_and_mcp
-- Description: Smart geo/name matching for attribute conditions + MCP
--   segment ownership + a service-role preview entry point.
--
--   1. Country conditions ("attributes.country" / "attributes.country_code")
--      match BOTH stored forms: name ("Japan", "United States") and ISO code
--      ("JP", "US"), whatever form the caller supplies. Previously an equals
--      on the short code returned nothing against name-form data.
--   2. US state conditions ("attributes.state" / "attributes.region") match
--      full names and USPS codes both ways ("CA" <-> "California").
--   3. Virtual field "full_name": first_name + last_name (fallback to the
--      full_name attribute), so "full name contains" works everywhere the
--      segment engine is used (builder UI, broadcasts AI copilot, MCP).
--   4. segments.created_by_person_id + created_via: MCP-created segments are
--      owned by a person (OAuth identity), so "my segments" is answerable.
--   5. segments_preview_service(): same output as segments_preview() but
--      callable by trusted service-role API paths (public API / MCP), which
--      have no admin JWT for is_admin().
-- ============================================================================

ALTER TABLE public.segments ADD COLUMN IF NOT EXISTS created_by_person_id uuid;
ALTER TABLE public.segments ADD COLUMN IF NOT EXISTS created_via text;
CREATE INDEX IF NOT EXISTS idx_segments_created_by_person
  ON public.segments (created_by_person_id) WHERE created_by_person_id IS NOT NULL;

-- Country name -> ISO-3166 alpha-2 (majors + everything seen in the data;
-- unmapped input falls through to itself so codes pass unchanged).
CREATE OR REPLACE FUNCTION public.segments_country_code(p_in text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    CASE lower(trim(p_in))
      WHEN 'united states' THEN 'US' WHEN 'usa' THEN 'US' WHEN 'united states of america' THEN 'US'
      WHEN 'united kingdom' THEN 'GB' WHEN 'uk' THEN 'GB' WHEN 'great britain' THEN 'GB' WHEN 'england' THEN 'GB'
      WHEN 'india' THEN 'IN' WHEN 'germany' THEN 'DE' WHEN 'canada' THEN 'CA' WHEN 'brazil' THEN 'BR'
      WHEN 'netherlands' THEN 'NL' WHEN 'france' THEN 'FR' WHEN 'spain' THEN 'ES' WHEN 'south africa' THEN 'ZA'
      WHEN 'japan' THEN 'JP' WHEN 'australia' THEN 'AU' WHEN 'italy' THEN 'IT' WHEN 'poland' THEN 'PL'
      WHEN 'switzerland' THEN 'CH' WHEN 'sweden' THEN 'SE' WHEN 'ireland' THEN 'IE' WHEN 'israel' THEN 'IL'
      WHEN 'singapore' THEN 'SG' WHEN 'mexico' THEN 'MX' WHEN 'portugal' THEN 'PT' WHEN 'belgium' THEN 'BE'
      WHEN 'denmark' THEN 'DK' WHEN 'norway' THEN 'NO' WHEN 'finland' THEN 'FI' WHEN 'austria' THEN 'AT'
      WHEN 'greece' THEN 'GR' WHEN 'turkey' THEN 'TR' WHEN 'nigeria' THEN 'NG' WHEN 'kenya' THEN 'KE'
      WHEN 'egypt' THEN 'EG' WHEN 'argentina' THEN 'AR' WHEN 'chile' THEN 'CL' WHEN 'colombia' THEN 'CO'
      WHEN 'peru' THEN 'PE' WHEN 'china' THEN 'CN' WHEN 'hong kong' THEN 'HK' WHEN 'taiwan' THEN 'TW'
      WHEN 'south korea' THEN 'KR' WHEN 'korea' THEN 'KR' WHEN 'indonesia' THEN 'ID' WHEN 'malaysia' THEN 'MY'
      WHEN 'thailand' THEN 'TH' WHEN 'vietnam' THEN 'VN' WHEN 'philippines' THEN 'PH' WHEN 'pakistan' THEN 'PK'
      WHEN 'bangladesh' THEN 'BD' WHEN 'sri lanka' THEN 'LK' WHEN 'nepal' THEN 'NP' WHEN 'new zealand' THEN 'NZ'
      WHEN 'united arab emirates' THEN 'AE' WHEN 'uae' THEN 'AE' WHEN 'saudi arabia' THEN 'SA'
      WHEN 'czech republic' THEN 'CZ' WHEN 'czechia' THEN 'CZ' WHEN 'romania' THEN 'RO' WHEN 'hungary' THEN 'HU'
      WHEN 'ukraine' THEN 'UA' WHEN 'russia' THEN 'RU' WHEN 'estonia' THEN 'EE' WHEN 'latvia' THEN 'LV'
      WHEN 'lithuania' THEN 'LT' WHEN 'bulgaria' THEN 'BG' WHEN 'croatia' THEN 'HR' WHEN 'serbia' THEN 'RS'
      WHEN 'slovakia' THEN 'SK' WHEN 'slovenia' THEN 'SI' WHEN 'luxembourg' THEN 'LU' WHEN 'iceland' THEN 'IS'
      WHEN 'ghana' THEN 'GH' WHEN 'morocco' THEN 'MA' WHEN 'tunisia' THEN 'TN' WHEN 'ethiopia' THEN 'ET'
      WHEN 'uganda' THEN 'UG' WHEN 'tanzania' THEN 'TZ' WHEN 'zimbabwe' THEN 'ZW' WHEN 'costa rica' THEN 'CR'
      WHEN 'uruguay' THEN 'UY' WHEN 'ecuador' THEN 'EC' WHEN 'venezuela' THEN 'VE' WHEN 'bolivia' THEN 'BO'
      ELSE NULL
    END,
    CASE WHEN length(trim(p_in)) = 2 THEN upper(trim(p_in)) ELSE NULL END
  );
$$;

-- US state: return the FULL NAME for a USPS code, else the input unchanged.
CREATE OR REPLACE FUNCTION public.segments_us_state_name(p_in text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    CASE upper(trim(p_in))
      WHEN 'AL' THEN 'Alabama' WHEN 'AK' THEN 'Alaska' WHEN 'AZ' THEN 'Arizona' WHEN 'AR' THEN 'Arkansas'
      WHEN 'CA' THEN 'California' WHEN 'CO' THEN 'Colorado' WHEN 'CT' THEN 'Connecticut' WHEN 'DE' THEN 'Delaware'
      WHEN 'FL' THEN 'Florida' WHEN 'GA' THEN 'Georgia' WHEN 'HI' THEN 'Hawaii' WHEN 'ID' THEN 'Idaho'
      WHEN 'IL' THEN 'Illinois' WHEN 'IN' THEN 'Indiana' WHEN 'IA' THEN 'Iowa' WHEN 'KS' THEN 'Kansas'
      WHEN 'KY' THEN 'Kentucky' WHEN 'LA' THEN 'Louisiana' WHEN 'ME' THEN 'Maine' WHEN 'MD' THEN 'Maryland'
      WHEN 'MA' THEN 'Massachusetts' WHEN 'MI' THEN 'Michigan' WHEN 'MN' THEN 'Minnesota' WHEN 'MS' THEN 'Mississippi'
      WHEN 'MO' THEN 'Missouri' WHEN 'MT' THEN 'Montana' WHEN 'NE' THEN 'Nebraska' WHEN 'NV' THEN 'Nevada'
      WHEN 'NH' THEN 'New Hampshire' WHEN 'NJ' THEN 'New Jersey' WHEN 'NM' THEN 'New Mexico' WHEN 'NY' THEN 'New York'
      WHEN 'NC' THEN 'North Carolina' WHEN 'ND' THEN 'North Dakota' WHEN 'OH' THEN 'Ohio' WHEN 'OK' THEN 'Oklahoma'
      WHEN 'OR' THEN 'Oregon' WHEN 'PA' THEN 'Pennsylvania' WHEN 'RI' THEN 'Rhode Island' WHEN 'SC' THEN 'South Carolina'
      WHEN 'SD' THEN 'South Dakota' WHEN 'TN' THEN 'Tennessee' WHEN 'TX' THEN 'Texas' WHEN 'UT' THEN 'Utah'
      WHEN 'VT' THEN 'Vermont' WHEN 'VA' THEN 'Virginia' WHEN 'WA' THEN 'Washington' WHEN 'WV' THEN 'West Virginia'
      WHEN 'WI' THEN 'Wisconsin' WHEN 'WY' THEN 'Wyoming' WHEN 'DC' THEN 'District of Columbia'
      ELSE NULL
    END,
    trim(p_in)
  );
$$;

-- Field resolver: adds the full_name virtual field.
CREATE OR REPLACE FUNCTION public.segments_attr_column(p_field text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  IF p_field IN ('email') THEN
    RETURN 'p.email';
  ELSIF p_field IN ('full_name', 'name', 'attributes.full_name') THEN
    -- Virtual: first + last, falling back to a stored full_name attribute.
    RETURN $c$COALESCE(NULLIF(TRIM(CONCAT_WS(' ', p.attributes->>'first_name', p.attributes->>'last_name')), ''), p.attributes->>'full_name')$c$;
  ELSIF p_field LIKE 'attributes.%' THEN
    RETURN format('(p.attributes ->> %L)', substring(p_field FROM 12));
  ELSE
    RETURN format('(p.attributes ->> %L)', p_field);
  END IF;
END;
$$;

-- Attribute condition translator: 002's body VERBATIM, with the smart-geo
-- special cases inserted before generic operator handling. Every operator's
-- semantics (IS DISTINCT FROM, numeric guards, jsonb in_list, 'true'
-- fallbacks) are unchanged.
CREATE OR REPLACE FUNCTION public.segments_attr_to_sql(cond jsonb)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_field text := cond->>'field';
  v_op    text := cond->>'operator';
  v_col   text;
  v_val   jsonb := cond->'value';
  v_text  text := cond->>'value';
  v_arr   text;
  v_num   constant text := '^-?[0-9]+(\.[0-9]+)?$';
  v_key   text;
  v_code  text;
BEGIN
  IF v_field IS NULL OR v_field = '' THEN
    RETURN 'true';
  END IF;
  v_col := public.segments_attr_column(v_field);

  -- Smart geo: for equals/contains on country/state fields, match the value
  -- against BOTH stored forms (name and code). Other operators keep literal
  -- semantics on the addressed key.
  v_key := CASE WHEN v_field LIKE 'attributes.%' THEN substring(v_field FROM 12) ELSE v_field END;
  IF v_key IN ('country', 'country_code') AND v_op IN ('equals', 'contains') AND COALESCE(v_text, '') <> '' THEN
    v_code := public.segments_country_code(v_text);
    RETURN format(
      $g$((p.attributes->>'country') ILIKE %L OR upper(p.attributes->>'country_code') = %L OR upper(p.attributes->>'country') = %L)$g$,
      '%' || v_text || '%',
      COALESCE(upper(v_code), upper(v_text)),
      upper(v_text)
    );
  ELSIF v_key IN ('state', 'region') AND v_op IN ('equals', 'contains') AND COALESCE(v_text, '') <> '' THEN
    RETURN format(
      $g$((p.attributes->>'state') ILIKE %L OR (p.attributes->>'region') ILIKE %L OR upper(p.attributes->>'state') = %L)$g$,
      '%' || public.segments_us_state_name(v_text) || '%',
      '%' || public.segments_us_state_name(v_text) || '%',
      upper(v_text)
    );
  END IF;

  CASE v_op
    WHEN 'equals' THEN
      RETURN format('%s = %L', v_col, v_text);
    WHEN 'not_equals' THEN
      RETURN format('%s IS DISTINCT FROM %L', v_col, v_text);
    WHEN 'contains' THEN
      RETURN format('%s ILIKE %L', v_col, '%' || v_text || '%');
    WHEN 'not_contains' THEN
      RETURN format('(%s IS NULL OR %s NOT ILIKE %L)', v_col, v_col, '%' || v_text || '%');
    WHEN 'starts_with' THEN
      RETURN format('%s ILIKE %L', v_col, v_text || '%');
    WHEN 'ends_with' THEN
      RETURN format('%s ILIKE %L', v_col, '%' || v_text);
    WHEN 'is_set' THEN
      RETURN format('(%s IS NOT NULL AND %s <> '''')', v_col, v_col);
    WHEN 'is_not_set' THEN
      RETURN format('(%s IS NULL OR %s = '''')', v_col, v_col);
    WHEN 'greater_than' THEN
      RETURN format('(%s ~ %L AND %s::numeric > %L::numeric)', v_col, v_num, v_col, v_text);
    WHEN 'less_than' THEN
      RETURN format('(%s ~ %L AND %s::numeric < %L::numeric)', v_col, v_num, v_col, v_text);
    WHEN 'greater_than_or_equal' THEN
      RETURN format('(%s ~ %L AND %s::numeric >= %L::numeric)', v_col, v_num, v_col, v_text);
    WHEN 'less_than_or_equal' THEN
      RETURN format('(%s ~ %L AND %s::numeric <= %L::numeric)', v_col, v_num, v_col, v_text);
    WHEN 'matches_regex' THEN
      RETURN format('%s ~ %L', v_col, v_text);
    WHEN 'in_list' THEN
      IF jsonb_typeof(v_val) = 'array' THEN
        SELECT string_agg(format('%L', elem), ',') INTO v_arr
        FROM jsonb_array_elements_text(v_val) elem;
      ELSE
        SELECT string_agg(format('%L', trim(elem)), ',') INTO v_arr
        FROM unnest(string_to_array(COALESCE(v_text, ''), ',')) elem
        WHERE trim(elem) <> '';
      END IF;
      IF v_arr IS NULL THEN RETURN 'false'; END IF;
      RETURN format('%s IN (%s)', v_col, v_arr);
    WHEN 'not_in_list' THEN
      IF jsonb_typeof(v_val) = 'array' THEN
        SELECT string_agg(format('%L', elem), ',') INTO v_arr
        FROM jsonb_array_elements_text(v_val) elem;
      ELSE
        SELECT string_agg(format('%L', trim(elem)), ',') INTO v_arr
        FROM unnest(string_to_array(COALESCE(v_text, ''), ',')) elem
        WHERE trim(elem) <> '';
      END IF;
      IF v_arr IS NULL THEN RETURN 'true'; END IF;
      RETURN format('(%s IS NULL OR %s NOT IN (%s))', v_col, v_col, v_arr);
    ELSE
      RETURN 'true';
  END CASE;
END;
$$;

-- Service-role preview: identical result shape to segments_preview() but
-- permitted for trusted service paths (public API + MCP) that carry no admin
-- JWT. Row output is trimmed to the fields those surfaces expose.
CREATE OR REPLACE FUNCTION public.segments_preview_service(p_definition jsonb, p_limit int DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_where  text;
  v_count  bigint;
  v_sample jsonb;
BEGIN
  IF NOT (auth.role() = 'service_role' OR public.is_admin()) THEN
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

REVOKE ALL ON FUNCTION public.segments_preview_service(jsonb, int) FROM anon, authenticated;
