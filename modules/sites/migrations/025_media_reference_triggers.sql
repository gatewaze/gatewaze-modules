-- ============================================================================
-- Migration: sites_025_media_reference_triggers
-- Description: DB triggers that maintain host_media.used_in transactionally
--              when content is written. Backstop to the API-level
--              MediaReferenceTracker for direct DB writes (migrations,
--              admin tooling, exec_sql).
--              Per spec §18.4.
-- ============================================================================

-- Helper: extract media path strings from a JSONB value, depth-limited.
-- Recognizes keys matching ^(image|image_url|src|href|background_image|.*_image)$
-- Returns text[] of relative storage paths (with leading / stripped).
CREATE OR REPLACE FUNCTION public.extract_media_refs_from_jsonb(p_value jsonb, p_depth int DEFAULT 0)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_refs text[] := '{}';
  v_kv record;
  v_text text;
BEGIN
  IF p_value IS NULL OR p_depth > 10 THEN
    RETURN '{}';
  END IF;

  IF jsonb_typeof(p_value) = 'object' THEN
    FOR v_kv IN SELECT * FROM jsonb_each(p_value) LOOP
      IF jsonb_typeof(v_kv.value) = 'string'
         AND v_kv.key ~ '^(image|image_url|src|href|background_image|.*_image)$' THEN
        v_text := v_kv.value #>> '{}';
        -- Strip query strings + leading slashes
        v_text := split_part(split_part(v_text, '?', 1), '#', 1);
        v_text := regexp_replace(v_text, '^/+', '');
        IF length(v_text) > 0 AND v_text NOT LIKE 'http%' THEN
          v_refs := v_refs || v_text;
        END IF;
      ELSE
        v_refs := v_refs || public.extract_media_refs_from_jsonb(v_kv.value, p_depth + 1);
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(p_value) = 'array' THEN
    FOR v_kv IN SELECT * FROM jsonb_array_elements(p_value) AS value LOOP
      v_refs := v_refs || public.extract_media_refs_from_jsonb(v_kv.value, p_depth + 1);
    END LOOP;
  END IF;

  RETURN v_refs;
END $$;

COMMENT ON FUNCTION public.extract_media_refs_from_jsonb(jsonb, int) IS
  'Walks a JSONB value depth-limited to 10 levels and returns all storage paths matching the media-key regex per spec §18.4.';

-- ============================================================================
-- Diff helpers — call host_media_add_usage / remove_usage for the symmetric
-- diff between OLD and NEW content.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._sync_media_refs(
  p_old_refs text[],
  p_new_refs text[],
  p_host_kind text,
  p_host_id uuid,
  p_content_type text,
  p_content_id text,
  p_content_name text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_path text;
BEGIN
  -- Added refs
  FOR v_path IN SELECT unnest(p_new_refs) EXCEPT SELECT unnest(p_old_refs) LOOP
    PERFORM public.host_media_add_usage(v_path, p_host_kind, p_host_id, p_content_type, p_content_id, p_content_name);
  END LOOP;
  -- Removed refs
  FOR v_path IN SELECT unnest(p_old_refs) EXCEPT SELECT unnest(p_new_refs) LOOP
    PERFORM public.host_media_remove_usage(v_path, p_host_kind, p_host_id, p_content_type, p_content_id);
  END LOOP;
END $$;

-- ============================================================================
-- Trigger functions per content table
-- ============================================================================

-- pages.content (schema-mode pages)
CREATE OR REPLACE FUNCTION public.trg_pages_sync_media_refs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_host_kind text;
  v_host_id uuid;
BEGIN
  -- Determine host (pages.host_kind = 'site' for site-owned pages)
  IF TG_OP = 'DELETE' THEN
    v_host_kind := OLD.host_kind;
    v_host_id := OLD.host_id;
    PERFORM public.host_media_remove_all_usage_for(v_host_kind, v_host_id, 'page', OLD.id::text);
    RETURN OLD;
  END IF;

  v_host_kind := NEW.host_kind;
  v_host_id := NEW.host_id;
  IF v_host_id IS NULL THEN RETURN NEW; END IF;

  PERFORM public._sync_media_refs(
    public.extract_media_refs_from_jsonb(COALESCE(OLD.content, '{}'::jsonb)),
    public.extract_media_refs_from_jsonb(COALESCE(NEW.content, '{}'::jsonb)),
    v_host_kind, v_host_id,
    'page', NEW.id::text, NEW.title
  );
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pages_sync_media_refs_iud ON public.pages;
CREATE TRIGGER trg_pages_sync_media_refs_iud
  AFTER INSERT OR UPDATE OF content OR DELETE ON public.pages
  FOR EACH ROW EXECUTE FUNCTION public.trg_pages_sync_media_refs();

-- page_blocks.content (blocks-mode pages)
CREATE OR REPLACE FUNCTION public.trg_page_blocks_sync_media_refs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_host_kind text;
  v_host_id uuid;
  v_page_title text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT p.host_kind, p.host_id, p.title INTO v_host_kind, v_host_id, v_page_title
      FROM public.pages p WHERE p.id = OLD.page_id;
    IF v_host_id IS NOT NULL THEN
      PERFORM public.host_media_remove_all_usage_for(v_host_kind, v_host_id, 'page_block', OLD.id::text);
    END IF;
    RETURN OLD;
  END IF;

  SELECT p.host_kind, p.host_id, p.title INTO v_host_kind, v_host_id, v_page_title
    FROM public.pages p WHERE p.id = NEW.page_id;
  IF v_host_id IS NULL THEN RETURN NEW; END IF;

  PERFORM public._sync_media_refs(
    public.extract_media_refs_from_jsonb(COALESCE(OLD.content, '{}'::jsonb)),
    public.extract_media_refs_from_jsonb(COALESCE(NEW.content, '{}'::jsonb)),
    v_host_kind, v_host_id,
    'page_block', NEW.id::text, COALESCE(v_page_title, '(untitled)')
  );
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_page_blocks_sync_media_refs_iud ON public.page_blocks;
CREATE TRIGGER trg_page_blocks_sync_media_refs_iud
  AFTER INSERT OR UPDATE OF content OR DELETE ON public.page_blocks
  FOR EACH ROW EXECUTE FUNCTION public.trg_page_blocks_sync_media_refs();

-- newsletters_edition_blocks.content
CREATE OR REPLACE FUNCTION public.trg_edition_blocks_sync_media_refs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_list_id uuid;
  v_subject text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Look up the edition's list for the host_id
    SELECT e.list_id, e.title INTO v_list_id, v_subject
      FROM public.newsletters_editions e WHERE e.id = OLD.edition_id;
    IF v_list_id IS NOT NULL THEN
      PERFORM public.host_media_remove_all_usage_for('list', v_list_id, 'edition_block', OLD.id::text);
    END IF;
    RETURN OLD;
  END IF;

  SELECT e.list_id, e.title INTO v_list_id, v_subject
    FROM public.newsletters_editions e WHERE e.id = NEW.edition_id;
  IF v_list_id IS NULL THEN RETURN NEW; END IF;

  PERFORM public._sync_media_refs(
    public.extract_media_refs_from_jsonb(COALESCE(OLD.content, '{}'::jsonb)),
    public.extract_media_refs_from_jsonb(COALESCE(NEW.content, '{}'::jsonb)),
    'list', v_list_id,
    'edition_block', NEW.id::text, COALESCE(v_subject, '(untitled)')
  );
  RETURN NEW;
END $$;

-- Only attach if newsletters_edition_blocks exists (newsletters module installed)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'newsletters_edition_blocks') THEN
    DROP TRIGGER IF EXISTS trg_edition_blocks_sync_media_refs_iud ON public.newsletters_edition_blocks;
    CREATE TRIGGER trg_edition_blocks_sync_media_refs_iud
      AFTER INSERT OR UPDATE OF content OR DELETE ON public.newsletters_edition_blocks
      FOR EACH ROW EXECUTE FUNCTION public.trg_edition_blocks_sync_media_refs();
  END IF;
END $$;
