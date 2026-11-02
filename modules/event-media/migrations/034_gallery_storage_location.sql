-- The gallery view (migration 028) lists its columns, so it does not pick
-- up where each file is kept (host-media migration 016). The guest
-- gallery needs it to build each photo's address from the right store.
--
-- host-media owns these columns; they are added here as well, IF NOT
-- EXISTS, only so this migration does not depend on running after
-- host-media's. New columns go at the end, which CREATE OR REPLACE VIEW
-- allows, and the view keeps its grants (read-only, service role).

ALTER TABLE public.host_media
  ADD COLUMN IF NOT EXISTS storage_provider text NOT NULL DEFAULT 'supabase',
  ADD COLUMN IF NOT EXISTS storage_bucket   text;

CREATE OR REPLACE VIEW public.event_media_gallery
WITH (security_invoker = true) AS
SELECT
  h.id,
  h.host_kind,
  h.host_id,
  h.storage_path,
  h.mime_type,
  h.bytes,
  h.width,
  h.height,
  h.variants,
  h.metadata,
  h.created_at,
  h.is_approved,
  h.access_level,
  -- When it was taken, or when it arrived if it does not say.
  COALESCE(public.event_media_taken_at(h.metadata), h.created_at) AS captured_at,
  h.storage_provider,
  h.storage_bucket
FROM public.host_media h;
