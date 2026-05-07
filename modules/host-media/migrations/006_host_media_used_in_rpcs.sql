-- ============================================================================
-- Migration: host_media_006_used_in_rpcs
-- Description: RPCs to add/remove entries from host_media.used_in jsonb.
--              Called by host_media_sync_refs() (migration 011) which is
--              itself called by per-consumer triggers. Lifted from sites'
--              usage RPCs.
-- Per spec-host-media-module §4.4.
-- ============================================================================

-- Add a (type, id, name) reference to media.used_in. Idempotent — if
-- the same (type, id) is already present, no-op (name updates accepted).
CREATE OR REPLACE FUNCTION public.host_media_add_usage(
  p_media_id uuid,
  p_consumer_type text,
  p_consumer_id uuid,
  p_consumer_name text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_entry jsonb;
BEGIN
  v_entry := jsonb_build_object(
    'type', p_consumer_type,
    'id', p_consumer_id::text,
    'name', p_consumer_name
  );

  -- Remove any existing entry for this (type, id) to handle name updates,
  -- then append the fresh one. SET (idempotent w.r.t. duplicates).
  UPDATE public.host_media
    SET used_in = COALESCE(
      (SELECT jsonb_agg(e) FROM jsonb_array_elements(used_in) e
        WHERE NOT (e->>'type' = p_consumer_type AND e->>'id' = p_consumer_id::text)),
      '[]'::jsonb
    ) || jsonb_build_array(v_entry)
    WHERE id = p_media_id;
END $$;

-- Remove a (type, id) reference from media.used_in.
CREATE OR REPLACE FUNCTION public.host_media_remove_usage(
  p_media_id uuid,
  p_consumer_type text,
  p_consumer_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.host_media
    SET used_in = COALESCE(
      (SELECT jsonb_agg(e) FROM jsonb_array_elements(used_in) e
        WHERE NOT (e->>'type' = p_consumer_type AND e->>'id' = p_consumer_id::text)),
      '[]'::jsonb
    )
    WHERE id = p_media_id;
END $$;
