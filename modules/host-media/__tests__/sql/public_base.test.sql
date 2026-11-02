-- ============================================================================
-- host_media_public_base (migration 017). Run as the table owner against a
-- database with host-media's migrations applied. Everything happens inside
-- one transaction that is rolled back, so it is safe on a dev database.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f modules/host-media/__tests__/sql/public_base.test.sql
--
-- Any failed assertion raises and stops the script.
-- ============================================================================
BEGIN;

INSERT INTO public.installed_modules (id, name, version, status, config)
VALUES ('storage-r2', 'Storage Provider: Cloudflare R2', '0.1.0', 'enabled',
        '{"R2_BUCKET":"test-media","R2_PUBLIC_URL":"https://media.example.com/","R2_SECRET_ACCESS_KEY":"v1:secret"}')
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, config = EXCLUDED.config;

DO $$
BEGIN
  IF public.host_media_public_base('r2', 'test-media') IS DISTINCT FROM 'https://media.example.com' THEN
    RAISE EXCEPTION 'FAIL: public base for the configured bucket';
  END IF;
  IF public.host_media_public_base('r2', 'other-bucket') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: another bucket must have no public base';
  END IF;
  IF public.host_media_public_base('supabase', 'media') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: supabase rows are built by the caller';
  END IF;
  IF public.host_media_public_base('r2'' OR 1=1 --', 'test-media') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: odd provider ids must give nothing';
  END IF;
END $$;

-- An unsafe public URL is never returned.
UPDATE public.installed_modules SET config = config || '{"R2_PUBLIC_URL":"javascript:alert(1)"}' WHERE id = 'storage-r2';
DO $$ BEGIN
  IF public.host_media_public_base('r2', 'test-media') IS NOT NULL THEN RAISE EXCEPTION 'FAIL: unsafe url returned'; END IF;
END $$;

-- A disabled provider has no public base.
UPDATE public.installed_modules SET status = 'disabled', config = config || '{"R2_PUBLIC_URL":"https://media.example.com"}' WHERE id = 'storage-r2';
DO $$ BEGIN
  IF public.host_media_public_base('r2', 'test-media') IS NOT NULL THEN RAISE EXCEPTION 'FAIL: disabled provider'; END IF;
END $$;

-- The portal's anon role can call it and gets only the URL.
UPDATE public.installed_modules SET status = 'enabled' WHERE id = 'storage-r2';
SET LOCAL ROLE anon;
DO $$ BEGIN
  IF public.host_media_public_base('r2', 'test-media') IS DISTINCT FROM 'https://media.example.com' THEN
    RAISE EXCEPTION 'FAIL: anon cannot read the public base';
  END IF;
END $$;
RESET ROLE;

ROLLBACK;
\echo 'host_media_public_base: all assertions passed'
