-- Face filters — "make me look like the bride/groom" for guest selfies.
--
-- A filter is a reference face (one photo of the person whose likeness
-- is applied) plus a label. The swap itself runs server-side through a
-- generation provider; nothing here stores generated output, because a
-- preview is only persisted if the guest chooses to upload it.
--
-- Deliberately opt-in at BOTH levels: the provider must be configured
-- for the deployment, and the individual upload link must allow it.
-- A wedding guest's face is being altered, so this can never be a
-- default-on behaviour.

ALTER TABLE public.events_media_upload_links
  ADD COLUMN IF NOT EXISTS allow_face_filter boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.events_media_face_filters (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  label        text NOT NULL,                 -- "Dan", "Sarah"
  source_path  text NOT NULL,                 -- storage path of the reference face
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_media_face_filters_event
  ON public.events_media_face_filters(event_id);

ALTER TABLE public.events_media_face_filters ENABLE ROW LEVEL SECURITY;

-- Admin-only, like the links table. Guests reach the active filters
-- through the public API with the service-role client; the short code
-- is the authorization.
DROP POLICY IF EXISTS admin_all ON public.events_media_face_filters;
CREATE POLICY admin_all ON public.events_media_face_filters
  FOR ALL TO authenticated
  USING (public.can_admin_event(event_id))
  WITH CHECK (public.can_admin_event(event_id));
