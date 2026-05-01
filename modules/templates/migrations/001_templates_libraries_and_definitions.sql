-- ============================================================================
-- Migration: templates_001_libraries_and_definitions
-- Description: Core schema for the templates module. Creates libraries
--              (per-host scopes), block definitions, brick definitions
--              (nested blocks), wrappers, and top-level definition rows.
--              Sources/ingestion live in 002. RLS lives in 003. A/B in 004.
--              See spec-templates-module.md §5 for the full data model.
-- ============================================================================

-- ==========================================================================
-- 1. templates_libraries
-- ==========================================================================
-- A library is a scoped collection of definitions belonging to one host.
-- Hosts are uniformly typed via (host_kind, host_id). One library per host.

CREATE TABLE IF NOT EXISTS public.templates_libraries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_kind    text NOT NULL,         -- 'newsletter' | 'site' | 'event' | 'calendar' | 'system' | ...
  host_id      uuid,                  -- nullable when host_kind='system' or platform-wide
  name         text NOT NULL,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Each (host_kind, host_id) pair has at most one library. Two partial unique
-- indexes are required because SQL treats NULL != NULL — without the second
-- index, a 'system' library (host_id IS NULL) could be created multiple times.
CREATE UNIQUE INDEX IF NOT EXISTS templates_libraries_unique_with_host
  ON public.templates_libraries (host_kind, host_id)
  WHERE host_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS templates_libraries_unique_no_host
  ON public.templates_libraries (host_kind)
  WHERE host_id IS NULL;

CREATE INDEX IF NOT EXISTS templates_libraries_host_kind_idx
  ON public.templates_libraries (host_kind);

COMMENT ON TABLE public.templates_libraries IS
  'Per-host scope for template/wrapper/block definitions. See spec-templates-module.md §5.1.';

COMMENT ON COLUMN public.templates_libraries.host_id IS
  'NULL for system / platform-wide libraries (e.g. host_kind=event uses NULL until per-event libraries land in v2).';

-- ==========================================================================
-- 2. templates_block_defs
-- ==========================================================================
-- Block definitions are version-pinned. Each (library_id, key) has a chain
-- of versions; exactly one is is_current=true. Page block / edition block
-- instances pin to a specific (library_id, key, version) row.

CREATE TABLE IF NOT EXISTS public.templates_block_defs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id          uuid NOT NULL REFERENCES public.templates_libraries(id) ON DELETE CASCADE,
  key                 text NOT NULL,            -- stable identifier within library
  name                text NOT NULL,
  description         text,
  source_kind         text NOT NULL DEFAULT 'static'
    CHECK (source_kind IN ('static', 'external-api', 'internal-content')),
  schema              jsonb NOT NULL DEFAULT '{}'::jsonb,    -- JSON Schema draft 2020-12
  html                text NOT NULL DEFAULT '',
  rich_text_template  text,                     -- nullable; for Substack/Beehiiv-style outputs
  has_bricks          boolean NOT NULL DEFAULT false,
  data_source         jsonb,                    -- nullable; populated when source_kind != 'static'
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  is_current          boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT templates_block_defs_unique_version
    UNIQUE (library_id, key, version)
);

-- Exactly one is_current=true per (library_id, key). Partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS templates_block_defs_unique_current
  ON public.templates_block_defs (library_id, key)
  WHERE is_current = true;

CREATE INDEX IF NOT EXISTS templates_block_defs_library_idx
  ON public.templates_block_defs (library_id);

COMMENT ON TABLE public.templates_block_defs IS
  'Version-pinned block definitions. Spec §5.2. Instances pin to a specific version row; bumping a def creates a new row and flips is_current.';

-- ==========================================================================
-- 3. templates_brick_defs
-- ==========================================================================
-- Bricks are nested inside a parent block (when has_bricks=true).
-- Bound to a specific block-def version, so updating the block def to a new
-- version creates new brick rows pointing at the new version.

CREATE TABLE IF NOT EXISTS public.templates_brick_defs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_def_id        uuid NOT NULL REFERENCES public.templates_block_defs(id) ON DELETE CASCADE,
  key                 text NOT NULL,
  name                text NOT NULL,
  schema              jsonb NOT NULL DEFAULT '{}'::jsonb,
  html                text NOT NULL DEFAULT '',
  rich_text_template  text,
  sort_order          integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT templates_brick_defs_unique_key
    UNIQUE (block_def_id, key)
);

CREATE INDEX IF NOT EXISTS templates_brick_defs_block_def_idx
  ON public.templates_brick_defs (block_def_id);

COMMENT ON TABLE public.templates_brick_defs IS
  'Nested brick definitions. Spec §5.2. Cascade-deletes with parent block def.';

-- ==========================================================================
-- 4. templates_wrappers
-- ==========================================================================
-- Page shells with a {{content}} slot. Optional per-library; pages reference
-- a wrapper by id; sites can declare a default wrapper key in config.

CREATE TABLE IF NOT EXISTS public.templates_wrappers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id        uuid NOT NULL REFERENCES public.templates_libraries(id) ON DELETE CASCADE,
  key               text NOT NULL,
  name              text NOT NULL,
  html              text NOT NULL,                 -- MUST contain {{content}} (validated at write)
  meta_block_keys   jsonb NOT NULL DEFAULT '[]'::jsonb,    -- text[] of META block keys declared in the wrapper
  global_seed_blocks jsonb NOT NULL DEFAULT '[]'::jsonb,   -- text[] of block keys auto-attached to new pages
  version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  is_current        boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT templates_wrappers_unique_version
    UNIQUE (library_id, key, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS templates_wrappers_unique_current
  ON public.templates_wrappers (library_id, key)
  WHERE is_current = true;

CREATE INDEX IF NOT EXISTS templates_wrappers_library_idx
  ON public.templates_wrappers (library_id);

COMMENT ON TABLE public.templates_wrappers IS
  'Page shells with a {{content}} slot. Spec §5.2.';

-- ==========================================================================
-- 5. templates_definitions
-- ==========================================================================
-- Top-level "starter sets" — a parsed source HTML file with the ordered list
-- of block keys to seed when creating a new page/edition from this template.

CREATE TABLE IF NOT EXISTS public.templates_definitions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id          uuid NOT NULL REFERENCES public.templates_libraries(id) ON DELETE CASCADE,
  key                 text NOT NULL,
  name                text NOT NULL,
  source_html         text NOT NULL,                 -- raw HTML as uploaded (post-validation)
  parsed_blocks       jsonb NOT NULL DEFAULT '[]'::jsonb,    -- denormalised cache of declared block keys
  default_block_order jsonb NOT NULL DEFAULT '[]'::jsonb,    -- text[] of block keys to seed
  meta_block_keys     jsonb NOT NULL DEFAULT '[]'::jsonb,
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  is_current          boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT templates_definitions_unique_version
    UNIQUE (library_id, key, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS templates_definitions_unique_current
  ON public.templates_definitions (library_id, key)
  WHERE is_current = true;

CREATE INDEX IF NOT EXISTS templates_definitions_library_idx
  ON public.templates_definitions (library_id);

COMMENT ON TABLE public.templates_definitions IS
  'Top-level parsed templates (block-set bundles). Spec §5.2.';

-- ==========================================================================
-- 6. updated_at triggers
-- ==========================================================================
-- Standard set_updated_at trigger function — created once if not exists, then
-- attached to each table.

CREATE OR REPLACE FUNCTION public.templates_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER templates_libraries_set_updated_at
  BEFORE UPDATE ON public.templates_libraries
  FOR EACH ROW EXECUTE FUNCTION public.templates_set_updated_at();

CREATE TRIGGER templates_block_defs_set_updated_at
  BEFORE UPDATE ON public.templates_block_defs
  FOR EACH ROW EXECUTE FUNCTION public.templates_set_updated_at();

CREATE TRIGGER templates_brick_defs_set_updated_at
  BEFORE UPDATE ON public.templates_brick_defs
  FOR EACH ROW EXECUTE FUNCTION public.templates_set_updated_at();

CREATE TRIGGER templates_wrappers_set_updated_at
  BEFORE UPDATE ON public.templates_wrappers
  FOR EACH ROW EXECUTE FUNCTION public.templates_set_updated_at();

CREATE TRIGGER templates_definitions_set_updated_at
  BEFORE UPDATE ON public.templates_definitions
  FOR EACH ROW EXECUTE FUNCTION public.templates_set_updated_at();
