-- Guest upload links — hidden QR-code upload access for event guests.
--
-- One row per shareable link. The short_code is a bearer credential
-- (like invite_parties.short_code, but 10 chars and rate-limited at the
-- API): guests never authenticate, so there are deliberately NO anon RLS
-- policies here — all guest access goes through the public API with the
-- service-role client, and the short code is the authorization.
--
-- Per spec-event-media-guest-uploads §4.

CREATE TABLE IF NOT EXISTS public.events_media_upload_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  short_code      varchar(16) UNIQUE NOT NULL,   -- 10 base36 chars, crypto-random, server-generated
  label           text NOT NULL,                 -- "Wedding day QR"
  is_active       boolean NOT NULL DEFAULT true,
  expires_at      timestamptz,                   -- NULL = never
  -- behaviour
  require_name    boolean NOT NULL DEFAULT true,
  allow_video     boolean NOT NULL DEFAULT true,
  auto_approve    boolean NOT NULL DEFAULT true,
  show_gallery    boolean NOT NULL DEFAULT true,
  max_photo_bytes bigint NOT NULL DEFAULT 52428800,     -- 50 MB
  max_video_bytes bigint NOT NULL DEFAULT 2147483648,   -- 2 GB
  -- display page
  logo_url        text,                          -- overlay logo (storage path or absolute URL)
  -- bookkeeping
  uploads_count   integer NOT NULL DEFAULT 0,    -- incremented atomically on complete
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_media_upload_links_event
  ON public.events_media_upload_links(event_id);

ALTER TABLE public.events_media_upload_links ENABLE ROW LEVEL SECURITY;

-- Admin-only, dispatched through the same predicate the rest of the
-- event surface uses. No anon/select-for-all policies by design.
DROP POLICY IF EXISTS admin_all ON public.events_media_upload_links;
CREATE POLICY admin_all ON public.events_media_upload_links
  FOR ALL TO authenticated
  USING (public.can_admin_event(event_id))
  WITH CHECK (public.can_admin_event(event_id));

-- Atomic uploads counter. Completes race (a phone fires several batches
-- concurrently), so the increment must happen in SQL, never
-- read-modify-write through PostgREST.
CREATE OR REPLACE FUNCTION public.events_media_upload_links_increment(
  p_link_id uuid,
  p_n integer
) RETURNS void
LANGUAGE sql AS $$
  UPDATE public.events_media_upload_links
     SET uploads_count = uploads_count + GREATEST(p_n, 0),
         updated_at = now()
   WHERE id = p_link_id;
$$;
