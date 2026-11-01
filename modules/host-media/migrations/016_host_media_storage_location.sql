-- Where each media file is kept (modules/storage).
--
-- storage_provider: 'supabase' for every row written before this migration
-- and by every writer that has not moved onto the storage module.
-- storage_bucket: NULL means host-media's configured Supabase bucket
-- (HOST_MEDIA_BUCKET, normally `media`), so a brand that set another bucket
-- keeps reading its old rows from it.
--
-- The server decides both columns. The host_media_admin_all policy lets a
-- host admin write rows through PostgREST, and the API reads, signs and
-- deletes with the service role in whatever store a row names, so these two
-- columns are guarded by a trigger rather than by MEDIA_PATCH_FIELDS alone.

ALTER TABLE public.host_media
  ADD COLUMN IF NOT EXISTS storage_provider text NOT NULL DEFAULT 'supabase',
  ADD COLUMN IF NOT EXISTS storage_bucket   text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'host_media_storage_provider_shape') THEN
    ALTER TABLE public.host_media
      ADD CONSTRAINT host_media_storage_provider_shape
      CHECK (storage_provider ~ '^[a-z0-9][a-z0-9-]{0,30}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'host_media_storage_bucket_shape') THEN
    ALTER TABLE public.host_media
      ADD CONSTRAINT host_media_storage_bucket_shape
      CHECK (storage_bucket IS NULL OR storage_bucket ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$');
  END IF;
END $$;

COMMENT ON COLUMN public.host_media.storage_provider IS
  'Storage provider holding the file and its variants: supabase, or the id of a storage-<id> module (e.g. r2). Set by the server only.';
COMMENT ON COLUMN public.host_media.storage_bucket IS
  'Bucket holding the file and its variants, within storage_provider. NULL means host-media''s configured Supabase bucket. Set by the server only.';

-- Only the service role, or a session outside PostgREST (migrations,
-- operators), may set or change where a row's files are. A PostgREST
-- caller with any other role can insert rows only with the defaults and can
-- never change the columns.
CREATE OR REPLACE FUNCTION public.host_media_guard_storage_location()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  claims text := COALESCE(current_setting('request.jwt.claims', true), '');
  claim_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
BEGIN
  IF claims = '' AND claim_role = '' THEN
    RETURN NEW;
  END IF;
  -- NULL-safe: no role claim must mean "not the service role".
  IF COALESCE(auth.role() = 'service_role', false) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.storage_provider IS DISTINCT FROM 'supabase' OR NEW.storage_bucket IS NOT NULL THEN
      RAISE EXCEPTION 'host_media storage location is set by the server'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.storage_provider IS DISTINCT FROM OLD.storage_provider
     OR NEW.storage_bucket IS DISTINCT FROM OLD.storage_bucket THEN
    RAISE EXCEPTION 'host_media storage location is set by the server'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS host_media_guard_storage_location ON public.host_media;
CREATE TRIGGER host_media_guard_storage_location
  BEFORE INSERT OR UPDATE ON public.host_media
  FOR EACH ROW EXECUTE FUNCTION public.host_media_guard_storage_location();
