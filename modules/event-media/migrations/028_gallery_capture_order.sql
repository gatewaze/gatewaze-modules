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
  -- A year outside living memory is not a capture time, it is a flat
  -- camera battery or a value somebody chose. `cleanTakenAt` keeps the
  -- same window in the application and `exifTakenAt` refuses the same
  -- years when it reads the file; without it here, a row claiming 9999
  -- would sit at the top of every gallery for ever. Bounded by a
  -- constant rather than by now(), so the same row always sorts the
  -- same way.
  IF substring(v_text, 1, 4) !~ '^\d{4}$'
     OR substring(v_text, 1, 4)::int NOT BETWEEN 2000 AND 2100 THEN
    RETURN NULL;
  END IF;
  -- No zone stated? Then it is a wall clock, read as UTC.
  IF v_text !~ '(Z|[+-]\d{2}:?\d{2})$' THEN
    v_text := v_text || 'Z';
  END IF;
  BEGIN
    RETURN v_text::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    -- A date that parses as text but not as a calendar -- 31 February,
    -- month 13 -- lands here. The exception block costs a subtransaction
    -- per row, which is why nothing indexes this and why the alternative
    -- (a pattern strict enough to need no handler) does not exist: no
    -- regex rules out 30 February.
    RETURN NULL;
  END;
END $$;

-- A pure function of its argument that exposes no data, but nothing
-- outside the gallery has any use for it either.
REVOKE ALL ON FUNCTION public.event_media_taken_at(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.event_media_taken_at(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.event_media_taken_at(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.event_media_taken_at(jsonb) TO service_role;

COMMENT ON FUNCTION public.event_media_taken_at(jsonb) IS
  'When a photograph was taken, from event-media metadata. A bare clock is read as UTC. NULL if absent or unparseable.';

-- Only the columns the gallery reads. Spelling them out rather than
-- SELECT * means a column added to host_media later cannot silently
-- change what this exposes.
-- security_invoker: the view reads host_media as whoever queries it, not
-- as its owner. Today only service_role may select it and service_role
-- bypasses RLS anyway, so this changes nothing -- but it means that if
-- anybody ever grants this view to `authenticated`, host_media's RLS
-- still applies to them instead of being quietly stepped over.
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
-- READ ONLY, and said twice on purpose. A view over a single table with
-- no aggregate in it is UPDATABLE in Postgres, and Supabase's default
-- privileges hand service_role every verb on anything new in `public` --
-- so without this revoke an insert or a delete aimed at this view would
-- quietly land in host_media. Nothing should ever write through a
-- reading convenience.
REVOKE ALL ON public.event_media_gallery FROM service_role;
GRANT SELECT ON public.event_media_gallery TO service_role;
