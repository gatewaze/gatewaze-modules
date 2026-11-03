-- Where the faces are in a photograph. BOXES ONLY.
--
-- This table holds no face templates, no embeddings and no identity. A
-- rectangle and a confidence score are personal data, because they are
-- about a person in a photograph we already hold; they are NOT biometric
-- data under Article 9, because nothing here can tell one person from
-- another. That line is the whole point of this migration, and it is
-- worth keeping: everything below is useful on its own, and none of it
-- needs anybody's explicit consent.
--
-- What it is for today:
--
--   * Reframing without cutting heads off. `lib/framing.ts` crops to
--     3:2 and 2:3 by rule, with no idea what is in the picture. A box
--     lets the crop keep the faces.
--   * Choosing an album cover worth looking at -- the most faces, the
--     largest face, nobody clipped by the frame edge.
--   * Knowing how many people are in a photograph, which the Media tab
--     can show and sort by.
--
-- What it is NOT for: finding the same person twice. That needs a
-- template per face and a different conversation about consent, and it
-- would be a separate table with its own switch.
--
-- Detection happens in the ORGANISER'S BROWSER, never in the api. Same
-- rule as every other pixel in this module, same outages behind it (see
-- lib/bounded.ts and admin/utils/enhanceMedia.ts). The api takes
-- rectangles as numbers and writes rows.

CREATE TABLE IF NOT EXISTS public.events_media_faces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  -- The photograph. A face cannot outlive the picture it is in, so this
  -- cascades: a deleted photograph takes its boxes with it, with no
  -- sweep to remember to run.
  media_id    uuid NOT NULL REFERENCES public.host_media(id) ON DELETE CASCADE,
  -- Which face within the photograph, 0 upwards, in the order the
  -- detector returned them.
  face_index  smallint NOT NULL CHECK (face_index >= 0),

  -- The box, as a FRACTION of the frame rather than pixels, so it stays
  -- correct whatever size the photograph is served at -- and it is
  -- served at half a dozen widths through the CDN.
  box_x       real NOT NULL CHECK (box_x >= -0.5 AND box_x <= 1.5),
  box_y       real NOT NULL CHECK (box_y >= -0.5 AND box_y <= 1.5),
  box_w       real NOT NULL CHECK (box_w > 0 AND box_w <= 2),
  box_h       real NOT NULL CHECK (box_h > 0 AND box_h <= 2),
  -- Boxes may hang slightly outside the frame: a detector will happily
  -- report a face half out of shot, and that is true and useful.

  score       real NOT NULL CHECK (score >= 0 AND score <= 1),
  -- The size of the face in the ORIGINAL's pixels, which is what decides
  -- whether it is worth anything. A box of 0.02 of the frame is a
  -- different thing on a 4000px photograph and on a phone snap.
  face_px     integer CHECK (face_px IS NULL OR face_px >= 0),

  -- Which detector, so a re-run with a better one can be told apart
  -- from a row that is already current.
  model_id    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (media_id, face_index)
);

CREATE INDEX IF NOT EXISTS events_media_faces_event_idx
  ON public.events_media_faces (event_id);
CREATE INDEX IF NOT EXISTS events_media_faces_media_idx
  ON public.events_media_faces (media_id);

COMMENT ON TABLE public.events_media_faces IS
  'Face RECTANGLES per photograph, for framing and covers. No templates, no identity, not Article 9 biometric data.';

-- A photograph that has been looked at and had no faces in it must be
-- distinguishable from one nobody has looked at yet, or every run would
-- examine the empty ones again for ever. A row per photograph, written
-- once the detector has finished with it whatever it found.
CREATE TABLE IF NOT EXISTS public.events_media_face_scans (
  media_id    uuid PRIMARY KEY REFERENCES public.host_media(id) ON DELETE CASCADE,
  event_id    uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  faces       integer NOT NULL DEFAULT 0 CHECK (faces >= 0),
  model_id    text NOT NULL,
  -- How long the detector took on this one, in milliseconds. Kept
  -- because nobody has ever measured what this costs in a real browser,
  -- and an average over a real album is the only number worth having.
  took_ms     integer CHECK (took_ms IS NULL OR took_ms >= 0),
  scanned_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_media_face_scans_event_idx
  ON public.events_media_face_scans (event_id);

COMMENT ON TABLE public.events_media_face_scans IS
  'One row per photograph the face detector has finished with, including the ones with no faces in them.';

-- Written and read by the api's service-role client only. The organiser
-- reaches both through the admin routes, which check can_admin_host_media
-- first; no guest, and no browser, touches either table directly.
ALTER TABLE public.events_media_faces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_media_face_scans ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.events_media_faces FROM PUBLIC;
REVOKE ALL ON public.events_media_faces FROM anon;
REVOKE ALL ON public.events_media_faces FROM authenticated;
GRANT ALL ON public.events_media_faces TO service_role;

REVOKE ALL ON public.events_media_face_scans FROM PUBLIC;
REVOKE ALL ON public.events_media_face_scans FROM anon;
REVOKE ALL ON public.events_media_face_scans FROM authenticated;
GRANT ALL ON public.events_media_face_scans TO service_role;

-- ERASURE HAPPENS BY CASCADE, NOT BY REGISTRATION.
--
-- The first version of this registered both tables with the compliance
-- engine using the `parent` form against host_media. That does nothing,
-- and it is worth writing down why so nobody adds it back believing it
-- works: the engine resolves a parent by looking the parent table up in
-- compliance_personal_data_registry (002_erasure_engine.sql:413-423),
-- and if it finds no row it adds NO predicate at all. `host_media` is
-- registered nowhere in this repo. The predicate came back NULL and the
-- face rows would never have been touched, while the migration claimed
-- they were covered -- which is worse than not registering them.
--
-- The honest position: a box carries no identity. There is no column
-- here that resolves to a person, so "erase this person's boxes" cannot
-- be expressed as a match. What CAN be expressed is that a box does not
-- outlive the photograph it describes, and that is enforced above by
-- ON DELETE CASCADE on media_id -- verified by deleting a host_media row
-- and watching both the boxes and the scan row go with it.
--
-- So: erasing somebody's photographs erases their boxes. If face data
-- ever grows an identity of its own -- a template, a cluster, a name --
-- that table WILL need a real registration, and this comment should not
-- be taken as a precedent for skipping one.
