-- ============================================================================
-- Migration: sites_006_theme_kinds
-- Description: Annex per spec-sites-theme-kinds.md.
--              - Adds `theme_kind` to sites (default 'html', immutable)
--              - Adds `accepted_theme_kinds` to pages_host_registrations
--              - Adds `content`, `content_schema_version`, `published_version`
--                to pages
--              - Triggers:
--                * trg_sites_theme_kind_immutable
--                * trg_sites_publishing_target_matches_kind (nextjs sites
--                  must use external+git-driven publisher)
--                * trg_pages_content_matches_kind (nextjs pages require
--                  content; html pages require content IS NULL)
--                * trg_page_blocks_only_for_html_pages (page_blocks /
--                  page_block_bricks forbidden on nextjs pages)
--
--              The new tables backing the Next.js path
--              (templates_content_schemas, pages_nextjs_drafts,
--              pages_content_variants, pages_content_versions,
--              sites_publish_jobs, sites_webhook_seen, sites_runtime_api_keys)
--              land in migration 007.
-- ============================================================================

-- ==========================================================================
-- 1. ADD COLUMN: sites.theme_kind
-- ==========================================================================

ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS theme_kind text NOT NULL DEFAULT 'html'
    CHECK (theme_kind IN ('html', 'nextjs'));

CREATE OR REPLACE FUNCTION public.sites_theme_kind_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW.theme_kind IS DISTINCT FROM OLD.theme_kind THEN
    RAISE EXCEPTION 'cannot_change_theme_kind: sites.theme_kind is immutable (was %, attempted %)',
      OLD.theme_kind, NEW.theme_kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sites_theme_kind_immutable
  BEFORE UPDATE OF theme_kind ON public.sites
  FOR EACH ROW EXECUTE FUNCTION public.sites_theme_kind_immutable();

-- ==========================================================================
-- 2. ADD COLUMN: pages_host_registrations.accepted_theme_kinds
-- ==========================================================================
-- Default: ['html'] for safety. Sites and Calendars (when registered) opt
-- into ['html', 'nextjs']; newsletters/emails/badges keep the default.

ALTER TABLE public.pages_host_registrations
  ADD COLUMN IF NOT EXISTS accepted_theme_kinds text[] NOT NULL DEFAULT ARRAY['html']::text[];

ALTER TABLE public.pages_host_registrations
  ADD CONSTRAINT pages_host_registrations_accepted_theme_kinds_valid
  CHECK (accepted_theme_kinds <@ ARRAY['html','nextjs']::text[]);

-- ==========================================================================
-- 3. ADD COLUMN: pages content fields for Next.js
-- ==========================================================================

ALTER TABLE public.pages
  ADD COLUMN IF NOT EXISTS content jsonb,
  ADD COLUMN IF NOT EXISTS content_schema_version int,
  ADD COLUMN IF NOT EXISTS published_version int NOT NULL DEFAULT 0;

-- ==========================================================================
-- 4. trg_sites_publishing_target_matches_kind
-- ==========================================================================
-- For sites with theme_kind='nextjs', publishing_target.kind MUST be
-- 'external' AND publishing_target.publisherId MUST refer to a registered
-- git-driven publisher. The existence check on publisherId is verified at
-- the application layer (we don't have a publishers table to FK against);
-- the structural check is done here.

CREATE OR REPLACE FUNCTION public.sites_publishing_target_matches_kind()
RETURNS trigger AS $$
DECLARE
  v_target_kind text;
BEGIN
  v_target_kind := NEW.publishing_target->>'kind';

  IF NEW.theme_kind = 'nextjs' THEN
    IF v_target_kind IS DISTINCT FROM 'external' THEN
      RAISE EXCEPTION 'invalid_publishing_target_for_nextjs: theme_kind=nextjs requires publishing_target.kind=external (got %)',
        COALESCE(v_target_kind, '<null>')
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.publishing_target->>'publisherId') IS NULL THEN
      RAISE EXCEPTION 'invalid_publishing_target_for_nextjs: theme_kind=nextjs requires publishing_target.publisherId'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sites_publishing_target_matches_kind
  BEFORE INSERT OR UPDATE OF theme_kind, publishing_target ON public.sites
  FOR EACH ROW EXECUTE FUNCTION public.sites_publishing_target_matches_kind();

-- ==========================================================================
-- 5. trg_pages_content_matches_kind
-- ==========================================================================
-- For pages on nextjs-kind sites: content + content_schema_version both required.
-- For pages on html-kind sites: content + content_schema_version both NULL.
--
-- Resolution: page → site → site.theme_kind. For host_kind != 'site'
-- (event, calendar, etc.) we don't enforce — those hosts choose their own
-- model (currently html-only via accepted_theme_kinds).

CREATE OR REPLACE FUNCTION public.pages_content_matches_kind()
RETURNS trigger AS $$
DECLARE
  v_site_kind text;
BEGIN
  IF NEW.host_kind = 'site' AND NEW.host_id IS NOT NULL THEN
    SELECT theme_kind INTO v_site_kind FROM public.sites WHERE id = NEW.host_id;
    IF v_site_kind = 'nextjs' THEN
      IF NEW.content IS NULL OR NEW.content_schema_version IS NULL THEN
        RAISE EXCEPTION 'invalid_pages_content_for_theme_kind: nextjs site requires content AND content_schema_version'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF v_site_kind = 'html' THEN
      IF NEW.content IS NOT NULL OR NEW.content_schema_version IS NOT NULL THEN
        RAISE EXCEPTION 'invalid_pages_content_for_theme_kind: html site forbids content / content_schema_version (use page_blocks)'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pages_content_matches_kind
  BEFORE INSERT OR UPDATE OF content, content_schema_version, host_kind, host_id ON public.pages
  FOR EACH ROW EXECUTE FUNCTION public.pages_content_matches_kind();

-- ==========================================================================
-- 6. trg_page_blocks_only_for_html_pages
-- ==========================================================================
-- page_blocks (and page_block_bricks via cascade) must not exist for
-- pages on theme_kind='nextjs' sites. The complementary mental model is
-- spelled out in the spec (§8.2): an HTML page is a list of blocks; a
-- Next.js page is a single content document.

CREATE OR REPLACE FUNCTION public.page_blocks_only_for_html_pages()
RETURNS trigger AS $$
DECLARE
  v_host_kind text;
  v_host_id   uuid;
  v_site_kind text;
BEGIN
  SELECT host_kind, host_id INTO v_host_kind, v_host_id
    FROM public.pages WHERE id = NEW.page_id;

  IF v_host_kind = 'site' AND v_host_id IS NOT NULL THEN
    SELECT theme_kind INTO v_site_kind FROM public.sites WHERE id = v_host_id;
    IF v_site_kind = 'nextjs' THEN
      RAISE EXCEPTION 'page_blocks_forbidden_for_nextjs_site: page % is on a nextjs site; use pages.content JSONB instead', NEW.page_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER page_blocks_only_for_html_pages
  BEFORE INSERT ON public.page_blocks
  FOR EACH ROW EXECUTE FUNCTION public.page_blocks_only_for_html_pages();

-- The brick-level guard is defensive: if a brick is being inserted, its
-- parent block was already accepted (which already ran the guard above),
-- so this is belt-and-suspenders.
CREATE OR REPLACE FUNCTION public.page_block_bricks_only_for_html_pages()
RETURNS trigger AS $$
DECLARE
  v_page_id   uuid;
  v_host_kind text;
  v_host_id   uuid;
  v_site_kind text;
BEGIN
  SELECT page_id INTO v_page_id FROM public.page_blocks WHERE id = NEW.page_block_id;
  IF v_page_id IS NULL THEN
    RAISE EXCEPTION 'page_block_bricks_orphan: page_block % does not exist', NEW.page_block_id;
  END IF;
  SELECT host_kind, host_id INTO v_host_kind, v_host_id
    FROM public.pages WHERE id = v_page_id;
  IF v_host_kind = 'site' AND v_host_id IS NOT NULL THEN
    SELECT theme_kind INTO v_site_kind FROM public.sites WHERE id = v_host_id;
    IF v_site_kind = 'nextjs' THEN
      RAISE EXCEPTION 'page_block_bricks_forbidden_for_nextjs_site'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER page_block_bricks_only_for_html_pages
  BEFORE INSERT ON public.page_block_bricks
  FOR EACH ROW EXECUTE FUNCTION public.page_block_bricks_only_for_html_pages();
