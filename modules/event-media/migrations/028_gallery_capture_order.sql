-- The gallery in the order the photographs were taken.
--
-- It ordered by created_at, which is when a file ARRIVED. For a guest
-- that is near enough -- they upload as the day happens -- but for a
-- professional it is meaningless: Paul delivered 851 photographs weeks
-- afterwards in one sitting, so every one of them "happened" the evening
-- he handed them over, in whatever order the browser got round to them
-- (asked 2026-10-17).
--
-- So the gallery sorts by when a photograph was taken, and falls back to
-- when it arrived for one that does not say. That is a per-photograph
-- fallback rather than two blocks, which is the one thing PostgREST
-- cannot express in an `order=`: it sorts by columns, and this is a
-- COALESCE over a JSONB field. Hence a view.
--
-- It is a view and not a column because `host_media` belongs to the
-- `host-media` module. Reading it from here is fair; altering its shape
-- from here is not.

-- A capture time out of event-media's own metadata, or nothing.
--
-- `metadata.taken_at` is written by `cleanTakenAt`, which guarantees the
-- shape, but this view spans rows written before it existed and rows
-- written by other paths. A value that will not parse must yield NULL
-- rather than failing every query that touches the view, so the cast is
-- caught.
--
-- THE ZONE IS SUPPLIED ON PURPOSE. EXIF carries none -- the time is the
-- clock on the camera that took the photograph -- and casting a zone-
-- less string leaves the answer to the server's TimeZone setting, so the
-- same row would sort differently depending on who asked. A bare clock
-- is read as UTC, which is what `atClock` in lib/view-albums.ts does, so
-- the database and the module agree. A value that already states a zone
-- is taken at its word.
--
-- STABLE, not IMMUTABLE: it is honest about depending on nothing but its
-- argument, and nothing indexes it. Declaring a timestamp cast IMMUTABLE
-- to make it indexable is how an index comes to disagree with the table.
CREATE OR REPLACE FUNCTION public.event_media_taken_at(p_metadata jsonb)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_text text;
BEGIN
  v_text := p_metadata ->> 'taken_at';
  IF v_text IS NULL OR btrim(v_text) = '' THEN
    RETURN NULL;
  END IF;
  v_text := btrim(v_text);
  -- No zone stated? Then it is a wall clock, read as UTC.
  IF v_text !~ '(Z|[+-]\d{2}:?\d{2})$' THEN
    v_text := v_text || 'Z';
  END IF;
  BEGIN
    RETURN v_text::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
END $$;

COMMENT ON FUNCTION public.event_media_taken_at(jsonb) IS
  'When a photograph was taken, from event-media metadata. A bare clock is read as UTC. NULL if absent or unparseable.';

-- Only the columns the gallery reads. Spelling them out rather than
-- SELECT * means a column added to host_media later cannot silently
-- change what this exposes.
CREATE OR REPLACE VIEW public.event_media_gallery AS
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
  COALESCE(public.event_media_taken_at(h.metadata), h.created_at) AS captured_at
FROM public.host_media h;

COMMENT ON VIEW public.event_media_gallery IS
  'host_media for the event gallery, with captured_at = taken_at else created_at.';

-- Read by the api's service-role client only. The gallery route does its
-- own filtering (approved, public, not hidden, not blocked), and no
-- guest or browser ever reaches this directly.
REVOKE ALL ON public.event_media_gallery FROM PUBLIC;
REVOKE ALL ON public.event_media_gallery FROM anon;
REVOKE ALL ON public.event_media_gallery FROM authenticated;
GRANT SELECT ON public.event_media_gallery TO service_role;
