-- The legacy events_media tables retire.
--
-- Two models of an event's photographs have run side by side: host_media
-- (polymorphic, approval- and access-gated, what the Media tab and the
-- /photos gallery read) and the original events_media (event-only,
-- anon-readable, fed by retired upload paths). Everything that wrote the
-- legacy tables is gone -- the zip pipeline unpacks in the browser into
-- host_media, the YouTube reconciler lives in host-media -- and the last
-- readers (calendars' portal queries) moved to host_media with this
-- release (spec-conference-recap-stages-and-event-photos §2.1).
--
-- Four tables go: events_media, events_media_albums,
-- event_media_album_items and events_media_zip_uploads. The other
-- events_media_* tables (upload links, booth settings, guest claims and
-- blocks, face filters, key people, sponsor tags) are live and stay.
--
-- Copy first, drop second, in one transaction. Every legacy row is
-- copied into host_media UNDER ITS OWN ID, so re-running the copy is a
-- no-op and the album-item mapping stays trivial; if any row cannot be
-- accounted for, the whole migration aborts and nothing is dropped.
-- Already-dropped tables mean a finished earlier run: skip everything.

DO $$
DECLARE
  v_missing bigint;
BEGIN
  IF to_regclass('public.events_media') IS NULL THEN
    RAISE NOTICE 'event-media 027: events_media already dropped; nothing to do';
    RETURN;
  END IF;

  -- ------------------------------------------------------------------
  -- 1. Copy media rows not already represented, under their legacy ids.
  --
  -- access_level = 'public' and the row's own is_approved: the legacy
  -- table was anon-readable, so public-and-approved is what these rows
  -- have always been. The mime type prefers the stored one, then the
  -- filename's extension, then the honest unknown. thumbnail_path and
  -- metadata.medium_path were storage paths in the media bucket, which
  -- is exactly what host_media.variants holds ({thumb, medium} paths --
  -- see media-process-image), so they map across; the gallery remakes
  -- its sizes from the original at the edge regardless. YouTube display
  -- columns map to host_media's own; the upload-pipeline bookkeeping
  -- (status, retries) goes to metadata.legacy_youtube and
  -- youtube_next_retry_at stays NULL, so the live youtube-poll worker
  -- never claims a row from the dead pipeline.
  -- ------------------------------------------------------------------
  INSERT INTO public.host_media (
    id, host_kind, host_id, storage_path, filename, mime_type, bytes,
    width, height, duration, caption, sponsor_id, is_featured,
    is_approved, access_level, uploaded_by, created_at, updated_at,
    youtube_video_id, youtube_url, youtube_embed_url,
    youtube_thumbnail_url, youtube_uploaded_at,
    variants, metadata
  )
  SELECT
    em.id,
    'event',
    em.event_id,
    coalesce(nullif(em.storage_path, ''), nullif(em.url, ''), 'legacy-events-media/' || em.id::text),
    coalesce(
      nullif(em.file_name, ''),
      nullif(regexp_replace(coalesce(em.storage_path, ''), '^.*/', ''), ''),
      'legacy-' || em.id::text
    ),
    coalesce(
      nullif(em.mime_type, ''),
      CASE lower(nullif(regexp_replace(coalesce(em.file_name, ''), '^.*\.', ''), coalesce(em.file_name, '')))
        WHEN 'jpg'  THEN 'image/jpeg'
        WHEN 'jpeg' THEN 'image/jpeg'
        WHEN 'png'  THEN 'image/png'
        WHEN 'gif'  THEN 'image/gif'
        WHEN 'webp' THEN 'image/webp'
        WHEN 'heic' THEN 'image/heic'
        WHEN 'mp4'  THEN 'video/mp4'
        WHEN 'm4v'  THEN 'video/mp4'
        WHEN 'mov'  THEN 'video/quicktime'
        WHEN 'webm' THEN 'video/webm'
        WHEN 'avi'  THEN 'video/x-msvideo'
        ELSE NULL
      END,
      'application/octet-stream'
    ),
    coalesce(em.file_size, 0),
    em.width,
    em.height,
    em.duration,
    em.caption,
    em.sponsor_id,
    coalesce(em.is_featured, false),
    coalesce(em.is_approved, true),
    'public',
    em.uploader_id,
    em.created_at,
    coalesce(em.updated_at, em.created_at),
    em.youtube_video_id,
    em.youtube_url,
    em.youtube_embed_url,
    em.youtube_thumbnail_url,
    em.youtube_uploaded_at,
    nullif(jsonb_strip_nulls(jsonb_build_object(
      'thumb',  nullif(em.thumbnail_path, ''),
      'medium', nullif(em.metadata ->> 'medium_path', '')
    )), '{}'::jsonb),
    coalesce(em.metadata, '{}'::jsonb)
      || jsonb_build_object('legacy_events_media_id', em.id)
      || jsonb_strip_nulls(jsonb_build_object(
           'legacy_url', nullif(em.url, ''),
           'legacy_album_name', nullif(em.album, ''),
           'legacy_upload_method', nullif(em.upload_method, ''),
           'legacy_upload_source', nullif(em.upload_source, ''),
           'legacy_uploaded_by_role', em.uploaded_by,
           'legacy_sort_order', nullif(coalesce(em.sort_order, 0), 0),
           'legacy_display_order', nullif(coalesce(em.display_order, 0), 0),
           'legacy_youtube', CASE
             WHEN em.youtube_upload_status IS NOT NULL
               OR em.youtube_error_message IS NOT NULL
               OR coalesce(em.youtube_retry_count, 0) > 0
             THEN jsonb_strip_nulls(jsonb_build_object(
                    'upload_status', em.youtube_upload_status,
                    'channel_id', em.youtube_channel_id,
                    'retry_count', em.youtube_retry_count,
                    'error_message', em.youtube_error_message))
             ELSE NULL
           END))
      || CASE
           WHEN nullif(left(trim(both '-' from regexp_replace(lower(coalesce(em.album, '')), '[^a-z0-9]+', '-', 'g')), 60), '') IS NOT NULL
           THEN jsonb_build_object('album', left(trim(both '-' from regexp_replace(lower(em.album), '[^a-z0-9]+', '-', 'g')), 60))
           ELSE '{}'::jsonb
         END
  FROM public.events_media em
  WHERE NOT EXISTS (SELECT 1 FROM public.host_media hm WHERE hm.id = em.id);

  -- ------------------------------------------------------------------
  -- 2. Copy the albums, under their legacy ids where the event has no
  -- album of that name yet; where it does, the existing album is the
  -- target. The map drives the item copy, the register and the backfill.
  -- ------------------------------------------------------------------
  DROP TABLE IF EXISTS _em_album_map;
  CREATE TEMP TABLE _em_album_map ON COMMIT DROP AS
  SELECT
    la.id AS legacy_id,
    la.event_id,
    la.name,
    left(trim(both '-' from regexp_replace(lower(coalesce(la.name, '')), '[^a-z0-9]+', '-', 'g')), 60) AS slug
  FROM public.events_media_albums la;

  INSERT INTO public.host_media_albums (id, host_kind, host_id, name, description, sort_order, is_default, created_at)
  SELECT la.id, 'event', la.event_id, la.name, la.description,
         coalesce(la.sort_order, 0), coalesce(la.is_default, false), la.created_at
  FROM public.events_media_albums la
  WHERE NOT EXISTS (SELECT 1 FROM public.host_media_albums h WHERE h.id = la.id)
    AND NOT EXISTS (
      SELECT 1 FROM public.host_media_albums h
      WHERE h.host_kind = 'event' AND h.host_id = la.event_id
        AND lower(h.name) = lower(la.name)
    );

  ALTER TABLE _em_album_map ADD COLUMN target_id uuid;
  UPDATE _em_album_map m
  SET target_id = coalesce(
    (SELECT h.id FROM public.host_media_albums h WHERE h.id = m.legacy_id),
    (SELECT h.id FROM public.host_media_albums h
      WHERE h.host_kind = 'event' AND h.host_id = m.event_id
        AND lower(h.name) = lower(m.name)
      ORDER BY h.created_at LIMIT 1)
  );

  -- Covers point at media copied under the same id, so they carry over.
  UPDATE public.host_media_albums h
  SET cover_media_id = la.cover_media_id
  FROM public.events_media_albums la
  WHERE h.id = la.id
    AND h.cover_media_id IS NULL
    AND la.cover_media_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.host_media hm WHERE hm.id = la.cover_media_id);

  -- Membership, via the preserved media ids and the album map.
  INSERT INTO public.host_media_album_items (album_id, media_id, sort_order)
  SELECT m.target_id, li.media_id, coalesce(li.sort_order, 0)
  FROM public.event_media_album_items li
  JOIN _em_album_map m ON m.legacy_id = li.album_id
  WHERE m.target_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.host_media hm WHERE hm.id = li.media_id)
  ON CONFLICT (album_id, media_id) DO NOTHING;

  -- Register each copied album in the gallery's register (migration 026
  -- opened the CHECK) so the portal serves it. View slugs are never
  -- registered here -- those registrations mean something else -- and an
  -- event's existing registration of a slug wins.
  -- DISTINCT ON (event, slug): two legacy albums whose names collapse to
  -- the same slug register once, for the older one, which also keeps the
  -- statement off both unique constraints.
  INSERT INTO public.event_media_view_albums (album_id, event_id, view)
  SELECT DISTINCT ON (m.event_id, m.slug) m.target_id, m.event_id, m.slug
  FROM _em_album_map m
  WHERE m.target_id IS NOT NULL
    AND m.slug ~ '^[a-z0-9][a-z0-9-]{0,59}$'
    AND m.slug NOT IN ('seed', 'night', 'ready', 'day', 'evening', 'booth', 'elsewhere', 'photographer')
    AND NOT EXISTS (SELECT 1 FROM public.event_media_view_albums v WHERE v.album_id = m.target_id)
    AND NOT EXISTS (SELECT 1 FROM public.event_media_view_albums v
                     WHERE v.event_id = m.event_id AND v.view = m.slug)
  ORDER BY m.event_id, m.slug, m.legacy_id;

  -- Backfill album_id and the gallery tag on the copied rows, from their
  -- album membership. Only rows this migration copied (they carry the
  -- legacy marker), so nothing an organiser has since arranged moves.
  UPDATE public.host_media hm
  SET album_id = coalesce(hm.album_id, x.target_id),
      metadata = coalesce(hm.metadata, '{}'::jsonb) || jsonb_build_object('album', x.slug)
  FROM (
    SELECT DISTINCT ON (li.media_id) li.media_id, m.target_id, m.slug
    FROM public.event_media_album_items li
    JOIN _em_album_map m ON m.legacy_id = li.album_id
    WHERE m.target_id IS NOT NULL
      AND m.slug ~ '^[a-z0-9][a-z0-9-]{0,59}$'
    ORDER BY li.media_id, li.created_at
  ) x
  WHERE hm.id = x.media_id
    AND hm.metadata ? 'legacy_events_media_id';

  -- ------------------------------------------------------------------
  -- 3. Nothing drops unless everything is accounted for.
  -- ------------------------------------------------------------------
  SELECT count(*) INTO v_missing
  FROM public.events_media em
  WHERE NOT EXISTS (SELECT 1 FROM public.host_media hm WHERE hm.id = em.id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'event-media 027: % events_media rows have no host_media counterpart; aborting, nothing dropped', v_missing;
  END IF;

  -- ------------------------------------------------------------------
  -- 4. Drop the four, dependents first.
  -- ------------------------------------------------------------------
  DROP TABLE IF EXISTS public.event_media_album_items;
  DROP TABLE IF EXISTS public.events_media_zip_uploads;
  DROP TABLE IF EXISTS public.events_media_albums;
  DROP TABLE IF EXISTS public.events_media;

  RAISE NOTICE 'event-media 027: legacy events_media tables copied into host_media and dropped';
END $$;
