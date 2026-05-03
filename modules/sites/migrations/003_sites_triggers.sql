-- ============================================================================
-- Migration: sites_003_triggers
-- Description:
--   - updated_at triggers
--   - atomic pages.version bump on any content write (per spec §9.5.3)
--   - media_refs maintenance triggers (per spec §4.5.7)
--
-- The media_refs triggers depend on `templates.walk_media_urls(schema, content)`
-- and `templates.resolve_url_to_media_id(url)` from the templates module.
-- Both must be installed before this migration runs.
-- ============================================================================

-- ==========================================================================
-- updated_at trigger function (sites-scoped — separate from templates' to
-- avoid cross-module coupling)
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.sites_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sites_set_updated_at         BEFORE UPDATE ON public.sites             FOR EACH ROW EXECUTE FUNCTION public.sites_set_updated_at();
CREATE TRIGGER sites_secrets_set_updated_at BEFORE UPDATE ON public.sites_secrets     FOR EACH ROW EXECUTE FUNCTION public.sites_set_updated_at();
CREATE TRIGGER pages_set_updated_at         BEFORE UPDATE ON public.pages             FOR EACH ROW EXECUTE FUNCTION public.sites_set_updated_at();
CREATE TRIGGER page_blocks_set_updated_at   BEFORE UPDATE ON public.page_blocks       FOR EACH ROW EXECUTE FUNCTION public.sites_set_updated_at();
CREATE TRIGGER page_block_bricks_set_updated_at BEFORE UPDATE ON public.page_block_bricks FOR EACH ROW EXECUTE FUNCTION public.sites_set_updated_at();

-- ==========================================================================
-- pages.version bump
-- ==========================================================================
-- Any direct UPDATE on pages bumps version (atomic, in BEFORE UPDATE).
-- Any INSERT/UPDATE/DELETE on page_blocks or page_block_bricks bumps the
-- parent page's version via an AFTER trigger that runs a single atomic
-- `UPDATE pages SET version = version + 1 WHERE id = ...`.

CREATE OR REPLACE FUNCTION public.pages_bump_version_on_self()
RETURNS trigger AS $$
BEGIN
  -- Don't double-bump on a write that already adjusts version (e.g. an
  -- explicit reset). When the caller doesn't touch version, NEW.version
  -- equals OLD.version after row-init; we increment.
  IF NEW.version = OLD.version THEN
    NEW.version = OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pages_bump_version_on_self
  BEFORE UPDATE ON public.pages
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION public.pages_bump_version_on_self();

CREATE OR REPLACE FUNCTION public.pages_bump_version_from_blocks()
RETURNS trigger AS $$
DECLARE
  v_page_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_page_id = OLD.page_id;
  ELSE
    v_page_id = NEW.page_id;
  END IF;
  -- Atomic increment.
  UPDATE public.pages SET version = version + 1 WHERE id = v_page_id;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER page_blocks_bump_parent_version
  AFTER INSERT OR UPDATE OR DELETE ON public.page_blocks
  FOR EACH ROW EXECUTE FUNCTION public.pages_bump_version_from_blocks();

CREATE OR REPLACE FUNCTION public.pages_bump_version_from_bricks()
RETURNS trigger AS $$
DECLARE
  v_page_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT page_id INTO v_page_id FROM public.page_blocks WHERE id = OLD.page_block_id;
  ELSE
    SELECT page_id INTO v_page_id FROM public.page_blocks WHERE id = NEW.page_block_id;
  END IF;
  IF v_page_id IS NOT NULL THEN
    UPDATE public.pages SET version = version + 1 WHERE id = v_page_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER page_block_bricks_bump_grandparent_version
  AFTER INSERT OR UPDATE OR DELETE ON public.page_block_bricks
  FOR EACH ROW EXECUTE FUNCTION public.pages_bump_version_from_bricks();

-- ==========================================================================
-- media_refs maintenance via DB triggers
-- ==========================================================================

-- Generic helper: rewrite media_refs for a single (source_kind, source_id)
-- to match a new URL set. Idempotent.
CREATE OR REPLACE FUNCTION public.sites_sync_media_refs(
  p_source_kind text,
  p_source_id   uuid,
  p_new_urls    text[]
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_ids uuid[];
BEGIN
  -- Resolve each URL to a sites_media id; null-skip.
  -- Note: templates.resolve_url_to_media_id is defined in the templates
  -- module's migrations. The function performs a simple lookup against
  -- sites_media.public_url; consumers can extend it for path-based matches.
  SELECT array_agg(DISTINCT mid) INTO v_new_ids
    FROM unnest(COALESCE(p_new_urls, ARRAY[]::text[])) AS u(url),
         LATERAL public.sites_resolve_url_to_media_id(u.url) AS mid
   WHERE mid IS NOT NULL;

  DELETE FROM public.media_refs
   WHERE source_kind = p_source_kind
     AND source_id   = p_source_id
     AND (v_new_ids IS NULL OR media_id <> ALL(v_new_ids));

  IF v_new_ids IS NOT NULL THEN
    INSERT INTO public.media_refs (media_id, source_kind, source_id)
      SELECT mid, p_source_kind, p_source_id
        FROM unnest(v_new_ids) mid
      ON CONFLICT (media_id, source_kind, source_id) DO NOTHING;
  END IF;
END;
$$;

-- Helper: resolve a public_url to a sites_media row id.
-- Lives in the sites module (depends on sites_media). The templates module's
-- own resolver delegates here when sites is installed.
CREATE OR REPLACE FUNCTION public.sites_resolve_url_to_media_id(p_url text)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT id FROM public.sites_media WHERE public_url = p_url LIMIT 1;
$$;

-- Trigger: page_blocks.content
CREATE OR REPLACE FUNCTION public.tg_page_blocks_media_refs()
RETURNS trigger AS $$
DECLARE
  v_schema  jsonb;
  v_urls    text[];
  v_block_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_block_id = OLD.id;
    PERFORM public.sites_sync_media_refs('page_block', v_block_id, ARRAY[]::text[]);
    RETURN OLD;
  END IF;

  v_block_id = NEW.id;
  SELECT schema INTO v_schema
    FROM public.templates_block_defs WHERE id = NEW.block_def_id;

  IF v_schema IS NULL THEN
    -- Block def doesn't exist (FK should prevent this, but defensive).
    PERFORM public.sites_sync_media_refs('page_block', v_block_id, ARRAY[]::text[]);
    RETURN NEW;
  END IF;

  v_urls := ARRAY(SELECT * FROM templates.walk_media_urls(v_schema, NEW.content));
  PERFORM public.sites_sync_media_refs('page_block', v_block_id, v_urls);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER page_blocks_media_refs
AFTER INSERT OR UPDATE OF content OR DELETE ON public.page_blocks
FOR EACH ROW EXECUTE FUNCTION public.tg_page_blocks_media_refs();

-- Trigger: page_block_bricks.content
CREATE OR REPLACE FUNCTION public.tg_page_block_bricks_media_refs()
RETURNS trigger AS $$
DECLARE
  v_schema   jsonb;
  v_urls     text[];
  v_brick_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_brick_id = OLD.id;
    PERFORM public.sites_sync_media_refs('page_block_brick', v_brick_id, ARRAY[]::text[]);
    RETURN OLD;
  END IF;

  v_brick_id = NEW.id;
  SELECT schema INTO v_schema
    FROM public.templates_brick_defs WHERE id = NEW.brick_def_id;
  IF v_schema IS NULL THEN
    PERFORM public.sites_sync_media_refs('page_block_brick', v_brick_id, ARRAY[]::text[]);
    RETURN NEW;
  END IF;

  v_urls := ARRAY(SELECT * FROM templates.walk_media_urls(v_schema, NEW.content));
  PERFORM public.sites_sync_media_refs('page_block_brick', v_brick_id, v_urls);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER page_block_bricks_media_refs
AFTER INSERT OR UPDATE OF content OR DELETE ON public.page_block_bricks
FOR EACH ROW EXECUTE FUNCTION public.tg_page_block_bricks_media_refs();

-- Trigger: pages.seo (and status transitions for archive/unarchive)
-- The canonical PageSeoOverride schema is small and known statically; we
-- inline the URL-bearing field set here rather than query a dynamic schema.
-- Currently only `ogImageUrl` is media-bearing.
CREATE OR REPLACE FUNCTION public.tg_pages_media_refs()
RETURNS trigger AS $$
DECLARE
  v_seo_url text;
  v_urls    text[];
BEGIN
  -- Status archive: clear all refs for this page's SEO + cascading content.
  IF TG_OP = 'UPDATE' AND NEW.status = 'archived' AND OLD.status <> 'archived' THEN
    PERFORM public.sites_sync_media_refs('page_seo', NEW.id, ARRAY[]::text[]);
    -- Also clear page-block / page-block-brick refs for any block on this page.
    DELETE FROM public.media_refs
     WHERE source_kind IN ('page_block','page_block_brick')
       AND source_id IN (
         SELECT id FROM public.page_blocks WHERE page_id = NEW.id
         UNION
         SELECT b.id FROM public.page_block_bricks b
                     JOIN public.page_blocks pb ON b.page_block_id = pb.id
                    WHERE pb.page_id = NEW.id
       );
    RETURN NEW;
  END IF;

  -- Status unarchive: re-walk current content.
  IF TG_OP = 'UPDATE' AND OLD.status = 'archived' AND NEW.status <> 'archived' THEN
    -- Re-insert page_seo refs from current seo
    v_seo_url := NEW.seo->>'ogImageUrl';
    v_urls := CASE WHEN v_seo_url IS NULL OR v_seo_url = '' THEN ARRAY[]::text[]
                   ELSE ARRAY[v_seo_url] END;
    PERFORM public.sites_sync_media_refs('page_seo', NEW.id, v_urls);
    -- Block / brick re-walk
    INSERT INTO public.media_refs (media_id, source_kind, source_id)
    SELECT DISTINCT mid, 'page_block', pb.id
      FROM public.page_blocks pb
      JOIN public.templates_block_defs bd ON bd.id = pb.block_def_id,
           LATERAL templates.walk_media_urls(bd.schema, pb.content) AS url,
           LATERAL public.sites_resolve_url_to_media_id(url) AS mid
     WHERE pb.page_id = NEW.id AND mid IS NOT NULL
    ON CONFLICT (media_id, source_kind, source_id) DO NOTHING;
    INSERT INTO public.media_refs (media_id, source_kind, source_id)
    SELECT DISTINCT mid, 'page_block_brick', br.id
      FROM public.page_block_bricks br
      JOIN public.page_blocks pb ON br.page_block_id = pb.id
      JOIN public.templates_brick_defs brd ON brd.id = br.brick_def_id,
           LATERAL templates.walk_media_urls(brd.schema, br.content) AS url,
           LATERAL public.sites_resolve_url_to_media_id(url) AS mid
     WHERE pb.page_id = NEW.id AND mid IS NOT NULL
    ON CONFLICT (media_id, source_kind, source_id) DO NOTHING;
    RETURN NEW;
  END IF;

  -- Plain update (or insert) of pages.seo or status: rewrite page_seo refs.
  v_seo_url := NEW.seo->>'ogImageUrl';
  v_urls := CASE WHEN v_seo_url IS NULL OR v_seo_url = '' THEN ARRAY[]::text[]
                 ELSE ARRAY[v_seo_url] END;
  PERFORM public.sites_sync_media_refs('page_seo', NEW.id, v_urls);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pages_media_refs
AFTER INSERT OR UPDATE OF seo, status ON public.pages
FOR EACH ROW EXECUTE FUNCTION public.tg_pages_media_refs();

-- Trigger: sites.config.seo.ogImageUrl
CREATE OR REPLACE FUNCTION public.tg_sites_media_refs()
RETURNS trigger AS $$
DECLARE
  v_url  text;
  v_urls text[];
BEGIN
  v_url := NEW.config->'seo'->>'ogImageUrl';
  v_urls := CASE WHEN v_url IS NULL OR v_url = '' THEN ARRAY[]::text[]
                 ELSE ARRAY[v_url] END;
  PERFORM public.sites_sync_media_refs('site_seo', NEW.id, v_urls);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sites_media_refs
AFTER INSERT OR UPDATE OF config ON public.sites
FOR EACH ROW EXECUTE FUNCTION public.tg_sites_media_refs();
