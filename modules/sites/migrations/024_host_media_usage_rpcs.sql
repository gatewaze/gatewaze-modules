-- ============================================================================
-- Migration: sites_024_host_media_usage_rpcs
-- Description: RPCs called by MediaReferenceTracker to maintain
--              host_media.used_in.
-- ============================================================================

-- Add a content reference to a media item's used_in array.
-- Idempotent: skips if the {type, id} pair is already present.
CREATE OR REPLACE FUNCTION public.host_media_add_usage(
  p_storage_path text,
  p_host_kind text,
  p_host_id uuid,
  p_content_type text,
  p_content_id text,
  p_content_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_media_id uuid;
  v_new_entry jsonb;
BEGIN
  SELECT id INTO v_media_id FROM public.host_media
    WHERE host_kind = p_host_kind AND host_id = p_host_id AND storage_path = p_storage_path
    LIMIT 1;
  IF v_media_id IS NULL THEN RETURN; END IF;

  v_new_entry := jsonb_build_object('type', p_content_type, 'id', p_content_id, 'name', p_content_name);

  UPDATE public.host_media
  SET used_in = used_in
    || (
      CASE
        WHEN used_in @> jsonb_build_array(jsonb_build_object('type', p_content_type, 'id', p_content_id))
        THEN '[]'::jsonb
        ELSE jsonb_build_array(v_new_entry)
      END
    )
  WHERE id = v_media_id;
END $$;

-- Remove a single content reference from a media item's used_in array.
CREATE OR REPLACE FUNCTION public.host_media_remove_usage(
  p_storage_path text,
  p_host_kind text,
  p_host_id uuid,
  p_content_type text,
  p_content_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_media_id uuid;
BEGIN
  SELECT id INTO v_media_id FROM public.host_media
    WHERE host_kind = p_host_kind AND host_id = p_host_id AND storage_path = p_storage_path
    LIMIT 1;
  IF v_media_id IS NULL THEN RETURN; END IF;

  UPDATE public.host_media
  SET used_in = COALESCE(
    (SELECT jsonb_agg(elem)
     FROM jsonb_array_elements(used_in) AS elem
     WHERE NOT (elem->>'type' = p_content_type AND elem->>'id' = p_content_id)),
    '[]'::jsonb
  )
  WHERE id = v_media_id;
END $$;

-- Remove ALL references to a content id from every media item's used_in.
-- Called when a content row is fully deleted.
CREATE OR REPLACE FUNCTION public.host_media_remove_all_usage_for(
  p_host_kind text,
  p_host_id uuid,
  p_content_type text,
  p_content_id text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE public.host_media
  SET used_in = COALESCE(
    (SELECT jsonb_agg(elem)
     FROM jsonb_array_elements(used_in) AS elem
     WHERE NOT (elem->>'type' = p_content_type AND elem->>'id' = p_content_id)),
    '[]'::jsonb
  )
  WHERE host_kind = p_host_kind AND host_id = p_host_id
    AND used_in @> jsonb_build_array(jsonb_build_object('type', p_content_type, 'id', p_content_id));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
