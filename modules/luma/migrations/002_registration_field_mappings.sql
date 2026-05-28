-- ============================================================================
-- Module: luma
-- Migration: 002_registration_field_mappings
-- Description: Registration field mappings table and RPC functions for
--              discovering questions from registration metadata and applying
--              mapped values to person attributes and registration fields.
-- ============================================================================

-- Registration field mappings table
CREATE TABLE IF NOT EXISTS public.registration_field_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  source_label text NOT NULL,
  source_question_type text,
  target_type text NOT NULL CHECK (target_type IN ('customer_attribute', 'registration_field')),
  target_field text NOT NULL,
  transform text NOT NULL DEFAULT 'direct',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_registration_field_mappings_event
  ON public.registration_field_mappings(event_id);

COMMENT ON TABLE public.registration_field_mappings IS 'Maps registration survey questions to person attributes or registration fields';

DROP TRIGGER IF EXISTS registration_field_mappings_updated_at ON public.registration_field_mappings;
CREATE TRIGGER registration_field_mappings_updated_at
  BEFORE UPDATE ON public.registration_field_mappings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.registration_field_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_registration_field_mappings"
  ON public.registration_field_mappings FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_registration_field_mappings"
  ON public.registration_field_mappings FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ============================================================================
-- RPC: events_discover_registration_questions
--
-- Scans registration_metadata (luma_survey_responses, registration_answers)
-- across all registrations for a given event. Returns unique question labels
-- with occurrence counts and a sample value.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.events_discover_registration_questions(
  p_event_id uuid
)
RETURNS TABLE (
  question_label text,
  question_type text,
  occurrence_count bigint,
  sample_value text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH survey_questions AS (
    -- Extract from luma_survey_responses (key-value pairs from CSV import)
    SELECT
      key AS label,
      'survey' AS qtype,
      value::text AS val
    FROM events_registrations r,
      jsonb_each(r.registration_metadata -> 'luma_survey_responses')
    WHERE r.event_id = p_event_id
      AND r.registration_metadata ? 'luma_survey_responses'
      AND jsonb_typeof(r.registration_metadata -> 'luma_survey_responses') = 'object'
  ),
  answer_questions AS (
    -- Extract from registration_answers (array format from webhooks/email)
    SELECT
      COALESCE(elem ->> 'label', elem ->> 'question', 'Unknown') AS label,
      COALESCE(elem ->> 'question_type', 'text') AS qtype,
      COALESCE(elem ->> 'answer', elem ->> 'value', '') AS val
    FROM events_registrations r,
      jsonb_array_elements(r.registration_metadata -> 'registration_answers') AS elem
    WHERE r.event_id = p_event_id
      AND r.registration_metadata ? 'registration_answers'
      AND jsonb_typeof(r.registration_metadata -> 'registration_answers') = 'array'
  ),
  all_questions AS (
    SELECT label, qtype, val FROM survey_questions
    UNION ALL
    SELECT label, qtype, val FROM answer_questions
  )
  SELECT
    aq.label AS question_label,
    mode() WITHIN GROUP (ORDER BY aq.qtype) AS question_type,
    count(*)::bigint AS occurrence_count,
    (array_agg(aq.val ORDER BY aq.val) FILTER (WHERE aq.val IS NOT NULL AND aq.val <> ''))[1] AS sample_value
  FROM all_questions aq
  GROUP BY aq.label
  ORDER BY count(*) DESC, aq.label;
END;
$$;

COMMENT ON FUNCTION public.events_discover_registration_questions(uuid)
  IS 'Discovers unique registration questions from registration metadata for an event';

-- ============================================================================
-- RPC: events_apply_registration_mappings
--
-- For each active mapping on an event, reads the corresponding value from
-- registration_metadata and writes it to the target (person attribute or
-- registration field like sponsor_permission).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.events_apply_registration_mappings(
  p_event_id uuid
)
RETURNS TABLE (
  registration_id uuid,
  person_id uuid,
  fields_updated text[],
  errors text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mapping RECORD;
  v_reg RECORD;
  v_raw_value text;
  v_transformed text;
  v_fields text[];
  v_errors text[];
  v_attrs jsonb;
BEGIN
  FOR v_reg IN
    SELECT r.id AS reg_id, r.person_id, r.registration_metadata, r.sponsor_permission
    FROM events_registrations r
    WHERE r.event_id = p_event_id
      AND r.registration_metadata IS NOT NULL
      AND r.registration_metadata::text <> '{}'
  LOOP
    v_fields := ARRAY[]::text[];
    v_errors := ARRAY[]::text[];

    FOR v_mapping IN
      SELECT m.source_label, m.target_type, m.target_field, m.transform
      FROM registration_field_mappings m
      WHERE m.event_id = p_event_id AND m.is_active = true
    LOOP
      -- Extract value from luma_survey_responses first, then registration_answers
      v_raw_value := NULL;

      -- Try luma_survey_responses (key-value)
      IF v_reg.registration_metadata ? 'luma_survey_responses' THEN
        v_raw_value := v_reg.registration_metadata -> 'luma_survey_responses' ->> v_mapping.source_label;
      END IF;

      -- Try registration_answers (array of objects)
      IF v_raw_value IS NULL AND v_reg.registration_metadata ? 'registration_answers' THEN
        SELECT COALESCE(elem ->> 'answer', elem ->> 'value')
        INTO v_raw_value
        FROM jsonb_array_elements(v_reg.registration_metadata -> 'registration_answers') AS elem
        WHERE COALESCE(elem ->> 'label', elem ->> 'question') = v_mapping.source_label
        LIMIT 1;
      END IF;

      IF v_raw_value IS NULL OR v_raw_value = '' THEN
        CONTINUE;
      END IF;

      -- Apply transform
      v_transformed := CASE v_mapping.transform
        WHEN 'boolean' THEN
          CASE WHEN lower(v_raw_value) IN ('yes', 'true', 'agreed', '1') THEN 'true' ELSE 'false' END
        WHEN 'boolean_inverted' THEN
          CASE WHEN lower(v_raw_value) IN ('yes', 'true', 'agreed', '1') THEN 'false' ELSE 'true' END
        WHEN 'normalize_linkedin' THEN
          CASE
            WHEN v_raw_value ~* '^https?://(www\.)?linkedin\.com/' THEN v_raw_value
            WHEN v_raw_value ~* '^linkedin\.com/' THEN 'https://' || v_raw_value
            WHEN v_raw_value ~* '^/in/' THEN 'https://linkedin.com' || v_raw_value
            ELSE v_raw_value
          END
        ELSE v_raw_value
      END;

      BEGIN
        IF v_mapping.target_type = 'customer_attribute' THEN
          -- Update person attributes
          SELECT p.attributes INTO v_attrs
          FROM people p WHERE p.id = v_reg.person_id;

          IF v_attrs IS NULL THEN v_attrs := '{}'::jsonb; END IF;

          -- Only set if not already present
          IF NOT (v_attrs ? v_mapping.target_field) OR v_attrs ->> v_mapping.target_field IS NULL OR v_attrs ->> v_mapping.target_field = '' THEN
            UPDATE people
            SET attributes = v_attrs || jsonb_build_object(v_mapping.target_field, v_transformed)
            WHERE id = v_reg.person_id;

            v_fields := array_append(v_fields, v_mapping.target_field);
          END IF;

        ELSIF v_mapping.target_type = 'registration_field' THEN
          -- Update registration fields directly
          IF v_mapping.target_field = 'sponsor_permission' THEN
            UPDATE events_registrations
            SET sponsor_permission = (v_transformed = 'true')
            WHERE id = v_reg.reg_id;

            v_fields := array_append(v_fields, 'sponsor_permission');
          END IF;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_errors := array_append(v_errors, v_mapping.target_field || ': ' || SQLERRM);
      END;
    END LOOP;

    -- Only return rows where something was attempted
    IF array_length(v_fields, 1) > 0 OR array_length(v_errors, 1) > 0 THEN
      registration_id := v_reg.reg_id;
      person_id := v_reg.person_id;
      fields_updated := v_fields;
      errors := v_errors;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.events_apply_registration_mappings(uuid)
  IS 'Applies configured field mappings to all registrations for an event';
