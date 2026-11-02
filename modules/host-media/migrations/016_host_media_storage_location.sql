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
-- deletes with the service role in whatever store and at whatever path a
-- row names, so the trigger below guards those columns, not just
-- MEDIA_PATCH_FIELDS.

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

-- Which rows a caller may write files into. The API routes use the service
-- role and check everything themselves. Any other PostgREST caller (a host
-- admin, through host_media_admin_all) gets:
--   INSERT  the default location, and a storage_path and variants inside
--           the row's own host folder.
--   UPDATE  no change to where the row's files are: location, storage_path,
--           variants, host_kind or host_id.
-- Without this a host admin could point a row at another host's file, or
-- another bucket's, and have the service role stream, sign or delete it.
--
-- Trusted: the service role, or a session that is neither anon nor
-- authenticated and carries no JWT claims (migrations, operators). The
-- database role is checked as well as the claims, because the claims are a
-- setting a session can change.
CREATE OR REPLACE FUNCTION public.host_media_guard_storage_location()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  claims text := COALESCE(current_setting('request.jwt.claims', true), '');
  claim_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
  folder text;
  v record;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') AND claims = '' AND claim_role = '' THEN
    RETURN NEW;
  END IF;
  -- NULL-safe: no role claim must mean "not the service role".
  IF COALESCE(auth.role() = 'service_role', false) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.storage_provider IS DISTINCT FROM 'supabase' OR NEW.storage_bucket IS NOT NULL THEN
      RAISE EXCEPTION 'host_media storage location is set by the server' USING ERRCODE = '42501';
    END IF;
    folder := NEW.host_kind || '/' || NEW.host_id || '/';
    IF NEW.storage_path IS NULL OR left(NEW.storage_path, length(folder)) <> folder OR position('..' in NEW.storage_path) > 0 THEN
      RAISE EXCEPTION 'host_media storage_path must be inside its host folder' USING ERRCODE = '42501';
    END IF;
    IF NEW.variants IS NOT NULL AND jsonb_typeof(NEW.variants) = 'object' THEN
      FOR v IN SELECT value FROM jsonb_each_text(NEW.variants) LOOP
        IF v.value !~* '^https?://' AND (left(v.value, length(folder)) <> folder OR position('..' in v.value) > 0) THEN
          RAISE EXCEPTION 'host_media variants must be inside its host folder' USING ERRCODE = '42501';
        END IF;
      END LOOP;
    END IF;
  ELSIF NEW.storage_provider IS DISTINCT FROM OLD.storage_provider
     OR NEW.storage_bucket IS DISTINCT FROM OLD.storage_bucket
     OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.variants IS DISTINCT FROM OLD.variants
     OR NEW.host_kind IS DISTINCT FROM OLD.host_kind
     OR NEW.host_id IS DISTINCT FROM OLD.host_id THEN
    RAISE EXCEPTION 'where a host_media row''s files are is set by the server' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS host_media_guard_storage_location ON public.host_media;
CREATE TRIGGER host_media_guard_storage_location
  BEFORE INSERT OR UPDATE ON public.host_media
  FOR EACH ROW EXECUTE FUNCTION public.host_media_guard_storage_location();
