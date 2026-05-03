-- ============================================================================
-- Migration: sites_002_pages_tables
-- Description: Host-polymorphic pages schema. Per spec-sites-module.md §4.2.
--              These tables are conceptually shared across hosts (sites,
--              calendars, events, blog posts) — a `host_kind` discriminator
--              + nullable `host_id` keys each row to one host instance.
-- ============================================================================

-- ==========================================================================
-- 1. pages_host_registrations
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.pages_host_registrations (
  host_kind            text PRIMARY KEY,
  module_id            text NOT NULL,
  url_prefix_template  text NOT NULL,
  can_admin_fn         text NOT NULL,
  can_edit_pages_fn    text NOT NULL,
  can_publish_fn       text NOT NULL,
  default_wrapper_key  text,
  enabled              boolean NOT NULL DEFAULT true,
  registered_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.pages_host_registrations IS
  'Host registry. Host modules (sites, events, calendars, blogs) register their host_kind + permission helpers here.';

-- ==========================================================================
-- 2. pages
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.pages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_kind             text NOT NULL,
  host_id               uuid,                              -- nullable when host_kind='portal' (singleton)
  templates_library_id  uuid NOT NULL,                     -- FK to templates_libraries.id (deferred FK in 003)
  parent_page_id        uuid REFERENCES public.pages(id) ON DELETE SET NULL,
  slug                  text NOT NULL,
  full_path             text NOT NULL,
  title                 text NOT NULL,
  template_def_id       uuid,                              -- FK to templates_definitions.id (deferred)
  wrapper_def_id        uuid,                              -- FK to templates_wrappers.id (deferred)
  status                text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','published','archived')),
  publish_at            timestamptz,
  unpublish_at          timestamptz,
  seo                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  ab_test_id            uuid,                              -- FK to templates_ab_tests.id (deferred)
  is_homepage           boolean NOT NULL DEFAULT false,
  version               integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid
);

-- Uniqueness invariants — two partial indexes per constraint because SQL
-- treats NULL host_id as non-equal:
CREATE UNIQUE INDEX IF NOT EXISTS pages_unique_path_with_host
  ON public.pages (host_kind, host_id, full_path)
  WHERE status <> 'archived' AND host_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS pages_unique_path_no_host
  ON public.pages (host_kind, full_path)
  WHERE status <> 'archived' AND host_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS pages_unique_homepage_with_host
  ON public.pages (host_kind, host_id)
  WHERE is_homepage = true AND host_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS pages_unique_homepage_no_host
  ON public.pages (host_kind)
  WHERE is_homepage = true AND host_id IS NULL;

CREATE INDEX IF NOT EXISTS pages_host_idx          ON public.pages (host_kind, host_id);
CREATE INDEX IF NOT EXISTS pages_status_idx        ON public.pages (status);
CREATE INDEX IF NOT EXISTS pages_publish_at_idx    ON public.pages (publish_at)
  WHERE status = 'scheduled';

-- ==========================================================================
-- 3. page_blocks
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.page_blocks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id       uuid NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
  block_def_id  uuid NOT NULL,                             -- FK to templates_block_defs.id (deferred)
  sort_order    integer NOT NULL DEFAULT 0,
  variant_key   text NOT NULL DEFAULT 'default',
  ab_split      jsonb,
  content       jsonb NOT NULL DEFAULT '{}'::jsonb,
  visibility    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS page_blocks_page_sort_idx ON public.page_blocks (page_id, sort_order);
CREATE INDEX IF NOT EXISTS page_blocks_block_def_idx ON public.page_blocks (block_def_id);

-- ==========================================================================
-- 4. page_block_bricks
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.page_block_bricks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_block_id  uuid NOT NULL REFERENCES public.page_blocks(id) ON DELETE CASCADE,
  brick_def_id   uuid NOT NULL,                            -- FK to templates_brick_defs.id (deferred)
  sort_order     integer NOT NULL DEFAULT 0,
  content        jsonb NOT NULL DEFAULT '{}'::jsonb,
  variant_key    text NOT NULL DEFAULT 'default',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS page_block_bricks_block_sort_idx ON public.page_block_bricks (page_block_id, sort_order);

-- ==========================================================================
-- 5. media_refs (generalised reverse-index)
-- ==========================================================================
-- Per spec §4.2 / §4.5.7: ALL media references in source-of-truth tables
-- (block content, brick content, site SEO, page SEO) are tracked here.
-- Maintained by Postgres triggers — see migration 004.

CREATE TABLE IF NOT EXISTS public.media_refs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id     uuid NOT NULL REFERENCES public.sites_media(id) ON DELETE CASCADE,
  source_kind  text NOT NULL CHECK (source_kind IN ('page_block', 'page_block_brick', 'site_seo', 'page_seo')),
  source_id    uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (media_id, source_kind, source_id)
);

CREATE INDEX IF NOT EXISTS media_refs_media_idx  ON public.media_refs (media_id);
CREATE INDEX IF NOT EXISTS media_refs_source_idx ON public.media_refs (source_kind, source_id);

-- ==========================================================================
-- 6. pages_preview_tokens
-- ==========================================================================

CREATE TABLE IF NOT EXISTS public.pages_preview_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id      uuid NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,             -- SHA-256 of the raw token; raw never persisted
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  revoked_at   timestamptz
);

CREATE INDEX IF NOT EXISTS pages_preview_tokens_page_idx ON public.pages_preview_tokens (page_id);
CREATE INDEX IF NOT EXISTS pages_preview_tokens_expires_idx ON public.pages_preview_tokens (expires_at)
  WHERE revoked_at IS NULL;
