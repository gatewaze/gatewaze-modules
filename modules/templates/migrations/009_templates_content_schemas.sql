-- ============================================================================
-- Migration: templates_009_content_schemas
-- Description: New table backing the Next.js theme path. Per
--              spec-sites-theme-kinds §8.1.
--              `templates_content_schemas` stores the JSON Schema produced
--              by ingesting a Next.js source's `content/schema.{ts,json}`.
--              Versioned per library; consumers (sites) pin to a specific
--              version via pages.content_schema_version.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.templates_content_schemas (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id              uuid NOT NULL REFERENCES public.templates_sources(id) ON DELETE CASCADE,
  library_id             uuid NOT NULL REFERENCES public.templates_libraries(id) ON DELETE CASCADE,
  version                integer NOT NULL CHECK (version >= 1),
  is_current             boolean NOT NULL DEFAULT false,
  schema_format          text NOT NULL CHECK (schema_format IN ('ts', 'json')),
  schema_hash            text NOT NULL                 -- content-addressed identity
                         CHECK (schema_hash ~ '^[0-9a-f]{64}$'),
  schema_json            jsonb NOT NULL,               -- the compiled JSON Schema
  raw_source_object_key  text,                         -- original schema.ts/json in object storage; nullable for inline test fixtures
  applied_at             timestamptz,
  applied_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT templates_content_schemas_unique_version
    UNIQUE (library_id, version)
);

-- Exactly one is_current=true per library — enforced by partial unique index
-- (rather than CHECK constraint) so we can flip is_current in a transaction
-- (UPDATE old row to false, INSERT new row with true, COMMIT).
CREATE UNIQUE INDEX IF NOT EXISTS templates_content_schemas_unique_current
  ON public.templates_content_schemas (library_id)
  WHERE is_current = true;

CREATE INDEX IF NOT EXISTS templates_content_schemas_source_idx
  ON public.templates_content_schemas (source_id);

CREATE INDEX IF NOT EXISTS templates_content_schemas_hash_idx
  ON public.templates_content_schemas (library_id, schema_hash);

COMMENT ON TABLE public.templates_content_schemas IS
  'Next.js theme content schemas. Per spec-sites-theme-kinds §8.1. One row per ingested schema version per library.';

COMMENT ON COLUMN public.templates_content_schemas.schema_json IS
  'The JSON Schema (Ajv draft 2020-12) — either compiled from schema.ts or hand-authored schema.json. This is the editor-form schema used by the Next.js page editor.';

-- RLS: cascades through library access. Reusing the templates_libraries
-- read predicate from migration 005.
ALTER TABLE public.templates_content_schemas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "templates_content_schemas_read_via_host"
  ON public.templates_content_schemas
  FOR SELECT
  TO authenticated
  USING (templates.can_read_library(library_id));
