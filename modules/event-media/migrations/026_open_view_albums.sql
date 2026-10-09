-- The album register opens up to albums that are not projector views.
--
-- event_media_view_albums began as "which album is which projector view"
-- (migration 006), and the public gallery grew to read it as the album
-- register: the join to host_media_albums is where the gallery takes its
-- display names from. A conference's photos arrive from Drive into
-- albums with their own names -- "Day 1", "Workshops" -- which are not
-- views and never will be, so the CHECK that kept the column to the
-- eight view words would keep those albums off the portal entirely
-- (spec-conference-recap-stages-and-event-photos §7.0).
--
-- The column now holds the album's gallery slug: one of the eight view
-- words for the projector's albums, exactly as before, or any
-- slug-shaped value for a registered album. The shape is the same one
-- the API serves (its ALBUM_SLUG_RE) and slugify() produces: lowercase
-- letters, digits and hyphens, starting with a letter or digit, at most
-- sixty characters.
--
-- Nothing else widens. event_media_view_album() still makes albums for
-- the eight views only, and the host_media insert trigger still joins
-- only view-tagged uploads; an ingest registers its own albums directly
-- with the service role, which is the only role with INSERT here.

ALTER TABLE public.event_media_view_albums
  DROP CONSTRAINT IF EXISTS event_media_view_albums_view_check;
ALTER TABLE public.event_media_view_albums
  ADD CONSTRAINT event_media_view_albums_view_check
  CHECK (view ~ '^[a-z0-9][a-z0-9-]{0,59}$');

COMMENT ON COLUMN public.event_media_view_albums.view IS
  'The album''s gallery slug: a projector view (seed/night/ready/day/evening/booth/elsewhere/photographer) or a registered album''s own slug.';

COMMENT ON TABLE public.event_media_view_albums IS
  'The gallery''s album register, per event: the projector''s view albums plus any ingested album served on the portal.';
