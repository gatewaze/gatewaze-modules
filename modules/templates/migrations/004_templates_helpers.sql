-- ============================================================================
-- Migration: templates_004_helpers
-- Description: Postgres helper functions exposed by the templates module
--              for consumers (sites, newsletters) to use in their triggers
--              and queries.
--
--              - templates.walk_media_urls(schema jsonb, content jsonb)
--                Walks a JSON Schema for fields with format='media-url' and
--                returns each URL value present in the matching content paths.
--                Used by sites' media_refs maintenance triggers (sites spec §4.5.7).
--
--              - templates.is_current_block_def(block_def_id uuid)
--                True iff the block_def row is the current pinned version
--                for its (library_id, key).
--
--              - templates.get_current_block_def(library_id uuid, key text)
--                Returns the row at is_current=true for the given key.
--
--              All functions are placed in a `templates` schema for clarity.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS templates;

-- ==========================================================================
-- templates.walk_media_urls(schema jsonb, content jsonb) RETURNS setof text
-- ==========================================================================
-- Walks the schema-content tree and emits the URL string at every path whose
-- schema declares `format: "media-url"`. Handles:
--   - top-level string fields: { type: "string", format: "media-url" }
--   - array-of-string fields:  { type: "array", items: { type: "string", format: "media-url" } }
--   - nested object fields:    recurses through `properties`
-- Returns nothing (zero rows) on null content or schemas with no media-url
-- fields. Idempotent and side-effect-free.

CREATE OR REPLACE FUNCTION templates.walk_media_urls(p_schema jsonb, p_content jsonb)
RETURNS SETOF text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  prop_key   text;
  prop_def   jsonb;
  prop_value jsonb;
  arr_item   jsonb;
BEGIN
  IF p_schema IS NULL OR p_content IS NULL THEN
    RETURN;
  END IF;

  -- Only walk objects that declare properties.
  IF p_schema->>'type' <> 'object' OR p_schema->'properties' IS NULL THEN
    RETURN;
  END IF;

  FOR prop_key, prop_def IN SELECT k, v FROM jsonb_each(p_schema->'properties') AS j(k, v) LOOP
    prop_value := p_content->prop_key;
    IF prop_value IS NULL OR jsonb_typeof(prop_value) = 'null' THEN
      CONTINUE;
    END IF;

    -- Direct media-url string field
    IF prop_def->>'type' = 'string' AND prop_def->>'format' = 'media-url' THEN
      IF jsonb_typeof(prop_value) = 'string' THEN
        RETURN NEXT prop_value #>> '{}';      -- jsonb string -> text
      END IF;
      CONTINUE;
    END IF;

    -- Array of media-url strings
    IF prop_def->>'type' = 'array'
       AND prop_def->'items'->>'type' = 'string'
       AND prop_def->'items'->>'format' = 'media-url' THEN
      IF jsonb_typeof(prop_value) = 'array' THEN
        FOR arr_item IN SELECT jsonb_array_elements(prop_value) LOOP
          IF jsonb_typeof(arr_item) = 'string' THEN
            RETURN NEXT arr_item #>> '{}';
          END IF;
        END LOOP;
      END IF;
      CONTINUE;
    END IF;

    -- Nested object
    IF prop_def->>'type' = 'object' THEN
      IF jsonb_typeof(prop_value) = 'object' THEN
        RETURN QUERY SELECT * FROM templates.walk_media_urls(prop_def, prop_value);
      END IF;
      CONTINUE;
    END IF;

    -- Array of objects (recurse per item)
    IF prop_def->>'type' = 'array' AND prop_def->'items'->>'type' = 'object' THEN
      IF jsonb_typeof(prop_value) = 'array' THEN
        FOR arr_item IN SELECT jsonb_array_elements(prop_value) LOOP
          IF jsonb_typeof(arr_item) = 'object' THEN
            RETURN QUERY SELECT * FROM templates.walk_media_urls(prop_def->'items', arr_item);
          END IF;
        END LOOP;
      END IF;
      CONTINUE;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION templates.walk_media_urls(jsonb, jsonb) IS
  'Returns every URL string at a JSON Schema field with format="media-url". Spec §4.5.7. Used by sites'' media_refs triggers.';

-- ==========================================================================
-- templates.is_current_block_def(block_def_id uuid) RETURNS boolean
-- ==========================================================================

CREATE OR REPLACE FUNCTION templates.is_current_block_def(p_block_def_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((SELECT is_current FROM public.templates_block_defs WHERE id = p_block_def_id), false);
$$;

-- ==========================================================================
-- templates.get_current_block_def(library_id uuid, key text)
-- ==========================================================================
-- Returns the current block-def row for the given (library_id, key), or
-- NULL if no current row exists. Used by consumers seeding new instances.

CREATE OR REPLACE FUNCTION templates.get_current_block_def(p_library_id uuid, p_key text)
RETURNS public.templates_block_defs
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM public.templates_block_defs
  WHERE library_id = p_library_id
    AND key = p_key
    AND is_current = true
  LIMIT 1;
$$;

-- ==========================================================================
-- templates.get_current_wrapper(library_id uuid, key text)
-- ==========================================================================

CREATE OR REPLACE FUNCTION templates.get_current_wrapper(p_library_id uuid, p_key text)
RETURNS public.templates_wrappers
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM public.templates_wrappers
  WHERE library_id = p_library_id
    AND key = p_key
    AND is_current = true
  LIMIT 1;
$$;
