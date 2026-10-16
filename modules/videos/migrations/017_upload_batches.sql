-- ============================================================================
-- Module: videos
-- Migration: 017_upload_batches
-- Description: upload batches, for a folder of masters that arrives through a
--              desktop client rather than the browser.
--
-- A batch is issued to one person for one event. It owns a prefix in the
-- master bucket (`batches/<id>/`) and a Backblaze application key that can
-- only write and list under that prefix, for a fixed number of days. The
-- person connects Cyberduck or rclone with that key and drags the folder in;
-- a cron lists the prefix, adopts each file as a master attached to the
-- batch, and queues the studio pass. Closing the batch deletes the key.
--
-- Only the key's id is stored. The key itself is shown once at creation.
--
-- Additive.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.video_upload_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  -- The event whose agenda the files are matched against. No FK: the events
  -- table belongs to another module, and a deleted event must not delete the
  -- record of what was uploaded.
  event_id uuid,
  prefix text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed', 'expired')),

  -- Who the batch was issued to. An admin user when there is one; a name and
  -- an address for a contractor who has no login.
  issued_to_name text,
  issued_to_email text,
  issued_to_user_id uuid,

  -- The Backblaze application key id (never the key), and when it dies.
  key_id text,
  key_expires_at timestamptz,

  objects_seen integer NOT NULL DEFAULT 0,
  adopted integer NOT NULL DEFAULT 0,
  -- Things the sync noticed and did not act on: a replaced file, an
  -- unsupported type. [{path, note, at}].
  flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_synced_at timestamptz,

  created_by uuid,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS video_upload_batches_open
  ON public.video_upload_batches (key_expires_at) WHERE state = 'open';

COMMENT ON TABLE public.video_upload_batches IS
  'A folder of masters uploaded by one person with a prefix-restricted, expiring Backblaze key. The sync cron adopts what lands under the prefix.';

-- An adopted master remembers its batch and the object's ETag at adoption,
-- so a later upload under the same name is noticed rather than trusted.
ALTER TABLE public.video_assets
  ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES public.video_upload_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS etag text;

CREATE INDEX IF NOT EXISTS video_assets_batch ON public.video_assets (batch_id) WHERE batch_id IS NOT NULL;

ALTER TABLE public.video_assets DROP CONSTRAINT IF EXISTS video_assets_source_check;
ALTER TABLE public.video_assets
  ADD CONSTRAINT video_assets_source_check
  CHECK (source IN ('upload', 'youtube_import', 'recap', 'drive_import', 'bucket_import', 'studio', 'batch_import'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'video_upload_batches_touch_updated_at') THEN
    CREATE TRIGGER video_upload_batches_touch_updated_at
      BEFORE UPDATE ON public.video_upload_batches
      FOR EACH ROW EXECUTE FUNCTION public.videos_touch_updated_at();
  END IF;
END $$;

-- Admins only: a batch names a person and the key that lets them write to
-- the bucket. Writes are service-role through the module API.
ALTER TABLE public.video_upload_batches ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='video_upload_batches' AND policyname='video_upload_batches_select') THEN
    CREATE POLICY video_upload_batches_select ON public.video_upload_batches
      FOR SELECT TO authenticated
      USING (public.is_admin());
  END IF;
END $$;
