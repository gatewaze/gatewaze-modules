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
--              Compared with 002 the function also checks the caller (admin
--              or service_role), pins pg_temp in its search path, and fills
--              each attribute in a single conditional UPDATE. The mappings
--              table policy is narrowed from every authenticated user to
--              admins.
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
-- pg_temp last, and explicit: without it a caller's temp table named
-- events_registrations would shadow the real one inside this definer body.
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mapping RECORD;
  v_reg RECORD;
  v_raw_value text;
  v_transformed text;
  v_fields text[];
  v_errors text[];
BEGIN
  -- Writes people.attributes for anyone on the event, so only the importers
  -- (service_role) and admins may call it. COALESCE: with no claims the
  -- comparison is NULL, and NULL would pass a bare NOT.
  IF NOT (COALESCE(auth.role() = 'service_role', false) OR COALESCE(public.is_admin(), false)) THEN
    RAISE EXCEPTION 'events_apply_registration_mappings: admin or service role required'
      USING ERRCODE = '42501';
  END IF;

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
          -- Fill the attribute only when it is empty, in one statement, so a
          -- concurrent importer write to the same row is not overwritten by
          -- a stale read.
          UPDATE people
          SET attributes = COALESCE(attributes, '{}'::jsonb) || jsonb_build_object(v_mapping.target_field, v_transformed)
          WHERE id = v_reg.person_id
            AND COALESCE(attributes ->> v_mapping.target_field, '') = '';

          IF FOUND THEN
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

-- Never anon. `authenticated` covers portal members too, which is why the
-- body checks is_admin() as well.
REVOKE ALL ON FUNCTION public.events_apply_registration_mappings(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.events_apply_registration_mappings(uuid, uuid[]) TO authenticated, service_role;

-- The mappings table had an open policy for every authenticated user, so a
-- portal member could add a mapping with any target field and then call the
-- function above. Admins only; the admin app reads and writes it as an admin.
DROP POLICY IF EXISTS "auth_all_registration_field_mappings" ON public.registration_field_mappings;
DROP POLICY IF EXISTS "admin_all_registration_field_mappings" ON public.registration_field_mappings;
CREATE POLICY "admin_all_registration_field_mappings"
  ON public.registration_field_mappings FOR ALL TO authenticated
  USING (COALESCE(public.is_admin(), false)) WITH CHECK (COALESCE(public.is_admin(), false));
