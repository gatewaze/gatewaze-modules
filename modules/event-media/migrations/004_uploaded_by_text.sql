-- ============================================================================
-- Module: event-media
-- Migration: 004_uploaded_by_text
-- Description: Convert events_media.uploaded_by from uuid to text so it can
--   hold the role marker ('admin' | 'attendee') the client code already
--   sends. The actual uploader user UUID lives in `uploader_id` (added in
--   migration 001/003 alongside upload_source etc.) — that column keeps
--   its uuid type.
-- ============================================================================

DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type INTO col_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'events_media'
    AND column_name = 'uploaded_by';

  -- Only migrate when still uuid; re-running on text is a no-op.
  IF col_type = 'uuid' THEN
    -- USING clause coerces existing uuid values to their canonical text
    -- representation. Existing rows are rare in practice (module is
    -- typically installed into an empty events_media) but this keeps
    -- the migration safe for instances that already have data.
    EXECUTE 'ALTER TABLE public.events_media
             ALTER COLUMN uploaded_by TYPE text
             USING uploaded_by::text';
  END IF;
END $$;

-- Constrain to the documented role values. Nulls allowed for legacy rows.
ALTER TABLE public.events_media
  DROP CONSTRAINT IF EXISTS events_media_uploaded_by_check;

ALTER TABLE public.events_media
  ADD CONSTRAINT events_media_uploaded_by_check
  CHECK (uploaded_by IS NULL OR uploaded_by IN ('admin', 'attendee'));
