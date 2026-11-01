-- ============================================================================
-- host_media_guard_storage_location (migration 016). Run as the table owner
-- against a database with host-media's migrations applied and at least one
-- host_media row. Everything happens inside one transaction that is rolled
-- back, so it is safe on a dev database.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f modules/host-media/__tests__/sql/storage_location_guard.test.sql
--
-- Any failed assertion raises and stops the script.
-- ============================================================================
BEGIN;

CREATE TEMP TABLE r ON COMMIT DROP AS
  SELECT id, host_kind, host_id FROM public.host_media ORDER BY id LIMIT 1;

-- A PostgREST caller that is not the service role.
SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);
DO $$
DECLARE x record;
BEGIN
  SELECT * INTO x FROM r;
  IF x.id IS NULL THEN RAISE EXCEPTION 'needs at least one host_media row'; END IF;

  BEGIN
    UPDATE public.host_media SET storage_bucket = 'video-masters' WHERE id = x.id;
    RAISE EXCEPTION 'FAIL: location change allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    UPDATE public.host_media SET storage_path = x.host_kind || '/00000000-0000-0000-0000-000000000000/a.jpg' WHERE id = x.id;
    RAISE EXCEPTION 'FAIL: storage_path change allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    UPDATE public.host_media SET variants = '{"x":"event/other/x.jpg"}' WHERE id = x.id;
    RAISE EXCEPTION 'FAIL: variants change allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- Moderation still works.
  UPDATE public.host_media SET is_approved = NOT COALESCE(is_approved, false) WHERE id = x.id;

  INSERT INTO public.host_media (host_kind, host_id, storage_path, filename, mime_type, bytes)
  VALUES (x.host_kind, x.host_id, x.host_kind || '/' || x.host_id || '/m/a.jpg', 'a.jpg', 'image/jpeg', 1);

  BEGIN
    INSERT INTO public.host_media (host_kind, host_id, storage_path, filename, mime_type, bytes)
    VALUES (x.host_kind, x.host_id, 'event/someone-else/a.jpg', 'a.jpg', 'image/jpeg', 1);
    RAISE EXCEPTION 'FAIL: insert outside the host folder allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    INSERT INTO public.host_media (host_kind, host_id, storage_path, filename, mime_type, bytes, storage_provider)
    VALUES (x.host_kind, x.host_id, x.host_kind || '/' || x.host_id || '/m/b.jpg', 'b.jpg', 'image/jpeg', 1, 'r2');
    RAISE EXCEPTION 'FAIL: insert with a provider allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    INSERT INTO public.host_media (host_kind, host_id, storage_path, filename, mime_type, bytes, variants)
    VALUES (x.host_kind, x.host_id, x.host_kind || '/' || x.host_id || '/m/c.jpg', 'c.jpg', 'image/jpeg', 1,
            '{"thumb":"https://cdn.example/x.jpg","depth":"event/zzz/d.png"}');
    RAISE EXCEPTION 'FAIL: variant outside the host folder allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;

-- The service role may set everything.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
UPDATE public.host_media SET storage_provider = 'r2', storage_bucket = 'other-bucket' WHERE id = (SELECT id FROM r);

-- So may a session outside PostgREST (migrations).
SELECT set_config('request.jwt.claims', '', true);
UPDATE public.host_media SET storage_provider = 'supabase', storage_bucket = NULL WHERE id = (SELECT id FROM r);

-- Shapes are checked whoever writes.
DO $$
BEGIN
  BEGIN
    UPDATE public.host_media SET storage_provider = '../x' WHERE id = (SELECT id FROM r);
    RAISE EXCEPTION 'FAIL: bad provider accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public.host_media SET storage_bucket = 'Bad_Bucket' WHERE id = (SELECT id FROM r);
    RAISE EXCEPTION 'FAIL: bad bucket accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

SELECT 'storage_location_guard: all assertions passed' AS result;
ROLLBACK;
