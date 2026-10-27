-- ============================================================================
-- Module: luma
-- Migration: 005_apply_mappings_by_registration
-- Description: events_apply_registration_mappings takes an optional list of
--              registration ids, so the importers can apply the event's
--              mappings to just the registration they created instead of
--              every registration on the event. Called with the event id
--              alone (the admin "Apply mappings" button) it behaves as before.
--
--              The importers had been calling a function named
--              apply_registration_mappings(p_event_id, p_registration_ids)
--              that never existed, so mappings were never applied on import.
--              The body is otherwise the same as migration 002.
-- ============================================================================

-- A function's signature cannot change under CREATE OR REPLACE, and leaving
-- the one-argument version in place would make the call with only
-- p_event_id ambiguous against the new default.
DROP FUNCTION IF EXISTS public.events_apply_registration_mappings(uuid);

CREATE OR REPLACE FUNCTION public.events_apply_registration_mappings(
  p_event_id uuid,
  p_registration_ids uuid[] DEFAULT NULL
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
      AND (p_registration_ids IS NULL OR r.id = ANY (p_registration_ids))
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

COMMENT ON FUNCTION public.events_apply_registration_mappings(uuid, uuid[])
  IS 'Applies configured field mappings to registrations for an event; p_registration_ids limits it to those registrations';

-- SECURITY DEFINER and it writes people.attributes: admins (authenticated,
-- behind the admin app) and the importers (service_role) only, never anon.
REVOKE ALL ON FUNCTION public.events_apply_registration_mappings(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.events_apply_registration_mappings(uuid, uuid[]) TO authenticated, service_role;
