-- ============================================================================
-- Migration: host_media_011_sync_refs_fn
-- Description: Single PL/pgSQL fn called by per-consumer triggers when
--              their content rows insert/update/delete. Diffs old vs new
--              jsonb for media URL keys, calls
--              host_media_add_usage / host_media_remove_usage to keep
--              host_media.used_in in sync.
-- Per spec-host-media-module §4.4.
--
-- The reference-extraction key allowlist is hardcoded here:
--     image, image_url, src, href, background_image, *_image,
--     cover_url, thumbnail_url
-- Depth-capped at 10 levels of jsonb nesting to bound CPU.
-- The metadata field on host_media itself is never walked (see spec §8.15).
-- ============================================================================

-- Helper: extract every host_media row id referenced by a content jsonb.
-- Returns a set of (media_id uuid). The walker descends arrays + objects
-- up to 10 levels, then matches keys in the allowlist whose value looks
-- like a host_media URL or UUID. Specifically: we look for entries where
-- the value is either a UUID string OR a URL whose path contains
-- /<host_kind>/<host_id>/<media_id_uuid>/<filename>.
CREATE OR REPLACE FUNCTION public.host_media_extract_refs(p_content jsonb)
  RETURNS TABLE(media_id uuid) LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_uuid_re text := '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
BEGIN
  RETURN QUERY
  WITH RECURSIVE walker(node, depth) AS (
    SELECT p_content, 0
    UNION ALL
    -- arrays: descend into each element
    SELECT v, depth + 1
      FROM walker, jsonb_array_elements(node) v
      WHERE jsonb_typeof(node) = 'array' AND depth < 10
    UNION ALL
    -- objects: descend into values whose key is in the allowlist OR
    -- ends with _image (e.g. background_image, hero_image)
    SELECT value, depth + 1
      FROM walker, jsonb_each(node)
      WHERE jsonb_typeof(node) = 'object' AND depth < 10
        AND (
          key IN ('image','image_url','src','href','background_image','cover_url','thumbnail_url')
          OR key LIKE '%\_image' ESCAPE '\'
        )
  )
  SELECT (regexp_matches(node #>> '{}', v_uuid_re, 'g'))[1]::uuid
    FROM walker
    WHERE jsonb_typeof(node) = 'string'
      AND (node #>> '{}') ~ v_uuid_re;
END $$;

-- The dispatcher called by per-consumer triggers. Diffs old vs new
-- content; for each removed media ref, calls host_media_remove_usage;
-- for each added media ref, calls host_media_add_usage.
CREATE OR REPLACE FUNCTION public.host_media_sync_refs(
  p_host_kind text,
  p_host_id uuid,
  p_old_content jsonb,
  p_new_content jsonb,
  p_consumer_type text,
  p_consumer_id uuid,
  p_consumer_name text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_old_ids uuid[];
  v_new_ids uuid[];
  v_added_id uuid;
  v_removed_id uuid;
BEGIN
  SELECT COALESCE(array_agg(DISTINCT media_id), ARRAY[]::uuid[]) INTO v_old_ids
    FROM public.host_media_extract_refs(p_old_content);
  SELECT COALESCE(array_agg(DISTINCT media_id), ARRAY[]::uuid[]) INTO v_new_ids
    FROM public.host_media_extract_refs(p_new_content);

  -- Removed = in old, not in new.
  FOREACH v_removed_id IN ARRAY v_old_ids LOOP
    IF NOT (v_removed_id = ANY (v_new_ids)) THEN
      PERFORM public.host_media_remove_usage(v_removed_id, p_consumer_type, p_consumer_id);
    END IF;
  END LOOP;

  -- Added = in new, not in old. (Repeated names get refreshed on every
  -- update — host_media_add_usage is idempotent w.r.t. (type, id).)
  FOREACH v_added_id IN ARRAY v_new_ids LOOP
    IF NOT (v_added_id = ANY (v_old_ids)) THEN
      -- Only attach the usage if the media is owned by the same host.
      -- Cross-host references would be a permission leak.
      IF EXISTS (
        SELECT 1 FROM public.host_media
          WHERE id = v_added_id
            AND host_kind = p_host_kind
            AND host_id = p_host_id
      ) THEN
        PERFORM public.host_media_add_usage(v_added_id, p_consumer_type, p_consumer_id, p_consumer_name);
      END IF;
    END IF;
  END LOOP;

  -- Re-add the usage on every UPDATE (even if media list unchanged) to
  -- keep names current when the consumer's name field changes.
  FOREACH v_added_id IN ARRAY v_new_ids LOOP
    IF v_added_id = ANY (v_old_ids) AND EXISTS (
      SELECT 1 FROM public.host_media
        WHERE id = v_added_id AND host_kind = p_host_kind AND host_id = p_host_id
    ) THEN
      PERFORM public.host_media_add_usage(v_added_id, p_consumer_type, p_consumer_id, p_consumer_name);
    END IF;
  END LOOP;
END $$;

COMMENT ON FUNCTION public.host_media_sync_refs IS
  'Called by per-consumer AFTER INSERT/UPDATE/DELETE triggers. Diffs old vs new content jsonb and updates host_media.used_in via host_media_add_usage / host_media_remove_usage.';
