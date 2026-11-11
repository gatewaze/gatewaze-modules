-- ============================================================================
-- Manual test script for videos migration 021: the videos_api_public view
-- behind /api/v1/videos and /api/v1/content.
--
-- The view is the only thing between an API key and a draft, private,
-- unlisted or keyword-hidden video, so its rules are checked here. One
-- transaction, a DO block per case that RAISEs on failure, ROLLBACK at the
-- end; a clean run prints only NOTICEs.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f modules/videos/__tests__/videos_api_public.manual.sql
--
-- Needs the videos migrations (001 to 021). The keyword case runs only where
-- content-keywords is installed, and says so.
-- ============================================================================

BEGIN;

INSERT INTO public.videos (id, provider_video_id, url, title, status, visibility, published_at) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'zzPUBLISHED', 'https://www.youtube.com/watch?v=zzPUBLISHED', 'zz published public', 'published', 'public', now()),
  ('d0000000-0000-0000-0000-000000000002', 'zzDRAFT0001', 'https://www.youtube.com/watch?v=zzDRAFT0001', 'zz draft', 'draft', 'public', now()),
  ('d0000000-0000-0000-0000-000000000003', 'zzPRIVATE01', 'https://www.youtube.com/watch?v=zzPRIVATE01', 'zz private', 'published', 'private', now()),
  ('d0000000-0000-0000-0000-000000000004', 'zzARCHIVED1', 'https://www.youtube.com/watch?v=zzARCHIVED1', 'zz archived', 'archived', 'public', now()),
  ('d0000000-0000-0000-0000-000000000005', 'zzUNDATED01', 'javascript:alert(1)', 'zz undated', 'published', 'public', NULL),
  ('d0000000-0000-0000-0000-000000000006', 'zzKEYWORD01', 'https://www.youtube.com/watch?v=zzKEYWORD01', 'zz keyword hidden', 'published', 'public', now());

-- case 1: only published, public videos appear.
DO $$
DECLARE titles text[];
BEGIN
  SELECT array_agg(title ORDER BY title) INTO titles
    FROM public.videos_api_public WHERE title LIKE 'zz %' AND title <> 'zz keyword hidden';
  IF titles IS DISTINCT FROM ARRAY['zz published public', 'zz undated'] THEN
    RAISE EXCEPTION 'case1: expected published public + undated, got %', titles;
  END IF;
  RAISE NOTICE 'case1 ok';
END $$;

-- case 2: a non-http(s) URL comes back NULL; an undated video has a sort date.
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.videos_api_public WHERE id = 'd0000000-0000-0000-0000-000000000005';
  IF r.url IS NOT NULL THEN RAISE EXCEPTION 'case2: javascript: url leaked'; END IF;
  IF r.sort_date IS NULL THEN RAISE EXCEPTION 'case2: undated video has no sort_date'; END IF;
  RAISE NOTICE 'case2 ok';
END $$;

-- case 3: keyword suppression, where content-keywords is installed.
DO $$
BEGIN
  IF to_regclass('public.content_keyword_item_state') IS NULL THEN
    RAISE NOTICE 'case3 skipped: content-keywords not installed';
    RETURN;
  END IF;
  EXECUTE $q$INSERT INTO public.content_keyword_item_state (content_type, content_id, is_visible)
             VALUES ('video', 'd0000000-0000-0000-0000-000000000006', false)$q$;
  IF EXISTS (SELECT 1 FROM public.videos_api_public WHERE id = 'd0000000-0000-0000-0000-000000000006') THEN
    RAISE EXCEPTION 'case3: keyword-hidden video is visible';
  END IF;
  RAISE NOTICE 'case3 ok';
END $$;

-- case 4: only service_role may read the view.
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.videos_api_public', 'SELECT') THEN RAISE EXCEPTION 'case4: anon can read'; END IF;
  IF has_table_privilege('authenticated', 'public.videos_api_public', 'SELECT') THEN RAISE EXCEPTION 'case4: authenticated can read'; END IF;
  IF NOT has_table_privilege('service_role', 'public.videos_api_public', 'SELECT') THEN RAISE EXCEPTION 'case4: service_role cannot read'; END IF;
  RAISE NOTICE 'case4 ok';
END $$;

ROLLBACK;
