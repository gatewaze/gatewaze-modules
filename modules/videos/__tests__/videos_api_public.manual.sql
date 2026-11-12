-- ============================================================================
-- Manual test script for videos migrations 021 and 022: the videos_api_public
-- view behind /api/v1/videos and /api/v1/content, the discovery lease, and
-- the triage view's protections.
--
-- The view is the only thing between an API key and a draft, private,
-- unlisted or keyword-hidden video, so its rules are checked here. One
-- transaction, a DO block per case that RAISEs on failure, ROLLBACK at the
-- end; a clean run prints only NOTICEs.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f modules/videos/__tests__/videos_api_public.manual.sql
--
-- Needs the videos migrations (001 to 023). The keyword case runs only where
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

-- case 5: the discovery lease is taken once, refused while held, released
-- only by the run that holds it, and taken over when stale.
DO $$
DECLARE
  c uuid := 'd1000000-0000-0000-0000-000000000001';
  s1 timestamptz;
  s2 timestamptz;
BEGIN
  INSERT INTO public.video_platform_connections (id, platform, external_account_id, label) VALUES (c, 'youtube', 'UCzzzzzzzzzzzzzzzzzzzzzz', 'zz');
  s1 := public.claim_video_discovery(c);
  IF s1 IS NULL THEN RAISE EXCEPTION 'case5: first claim refused'; END IF;
  IF public.claim_video_discovery(c) IS NOT NULL THEN RAISE EXCEPTION 'case5: second claim taken while held'; END IF;
  IF public.finish_video_discovery(c, s1 - interval '1 second', 'x') THEN RAISE EXCEPTION 'case5: a wrong start released the lease'; END IF;
  IF NOT public.finish_video_discovery(c, s1, 'Read 3 uploads.') THEN RAISE EXCEPTION 'case5: the holder could not release'; END IF;
  s2 := public.claim_video_discovery(c);
  IF s2 IS NULL THEN RAISE EXCEPTION 'case5: claim refused after finish'; END IF;
  -- Stale: the holder vanished three hours ago.
  UPDATE public.video_platform_connections SET discovery_started_at = clock_timestamp() - interval '3 hours', discovery_finished_at = NULL WHERE id = c;
  s2 := public.claim_video_discovery(c);
  IF s2 IS NULL THEN RAISE EXCEPTION 'case5: stale lease not taken over'; END IF;
  -- The vanished run comes back and must not release the new lease.
  IF public.finish_video_discovery(c, clock_timestamp() - interval '3 hours', 'late') THEN RAISE EXCEPTION 'case5: an old run released the new lease'; END IF;
  IF public.claim_video_discovery('d1000000-0000-0000-0000-00000000ffff') IS NOT NULL THEN RAISE EXCEPTION 'case5: unknown connection claimed'; END IF;
  RAISE NOTICE 'case5 ok';
END $$;

-- case 6: the replaced triage view keeps 010's protections and gains columns.
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.videos_unassigned', 'SELECT') THEN RAISE EXCEPTION 'case6: anon can read videos_unassigned'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'videos_unassigned' AND 'security_invoker=true' = ANY (reloptions)) THEN
    RAISE EXCEPTION 'case6: videos_unassigned lost security_invoker';
  END IF;
  PERFORM status, visibility FROM public.videos_unassigned LIMIT 1;
  IF has_function_privilege('authenticated', 'public.claim_video_discovery(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.finish_video_discovery(uuid, timestamptz, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'case6: authenticated can take or release a lease';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.videos_unassigned', 'SELECT') THEN
    RAISE EXCEPTION 'case6: authenticated lost its SELECT on videos_unassigned';
  END IF;
  RAISE NOTICE 'case6 ok';
END $$;

-- case 7: publishing through publish_state lands in the API view.
DO $$
BEGIN
  UPDATE public.videos SET publish_state = 'draft', status = 'draft' WHERE id = 'd0000000-0000-0000-0000-000000000002';
  UPDATE public.videos SET publish_state = 'published' WHERE id = 'd0000000-0000-0000-0000-000000000002';
  IF NOT EXISTS (SELECT 1 FROM public.videos_api_public WHERE id = 'd0000000-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'case7: published draft not in the view';
  END IF;
  UPDATE public.videos SET publish_state = 'unpublished' WHERE id = 'd0000000-0000-0000-0000-000000000002';
  IF EXISTS (SELECT 1 FROM public.videos_api_public WHERE id = 'd0000000-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'case7: unpublished video still in the view';
  END IF;
  RAISE NOTICE 'case7 ok';
END $$;

-- case 8: 023's triage view picks the same view count video_metrics_latest
-- would: the newest 'ok' day per publication (a newer no_data day does not
-- blank it), and the publication with the most views when there are two.
DO $$
DECLARE
  v uuid := 'd0000000-0000-0000-0000-000000000002';
  c1 uuid := 'd1000000-0000-0000-0000-000000000011';
  c2 uuid := 'd1000000-0000-0000-0000-000000000012';
  p1 uuid := 'd2000000-0000-0000-0000-000000000001';
  p2 uuid := 'd2000000-0000-0000-0000-000000000002';
  r record;
BEGIN
  INSERT INTO public.video_platform_connections (id, platform, external_account_id, label) VALUES
    (c1, 'youtube', 'UCzzzzzzzzzzzzzzzzzzzz01', 'zz1'),
    (c2, 'youtube', 'UCzzzzzzzzzzzzzzzzzzzz02', 'zz2');
  INSERT INTO public.video_publications (id, video_id, connection_id, platform) VALUES
    (p1, v, c1, 'youtube'), (p2, v, c2, 'youtube');
  INSERT INTO public.video_metrics (publication_id, collected_for, status, views) VALUES
    (p1, current_date - 2, 'ok', 50),
    (p1, current_date - 1, 'ok', 70),
    (p1, current_date,     'no_data', NULL),
    (p2, current_date - 1, 'ok', 40),
    (p2, current_date,     'ok', 45);
  SELECT latest_views, views_as_of INTO r FROM public.videos_unassigned WHERE id = v;
  IF r.latest_views IS DISTINCT FROM 70::bigint OR r.views_as_of IS DISTINCT FROM current_date - 1 THEN
    RAISE EXCEPTION 'case8: expected 70 views as of yesterday, got % as of %', r.latest_views, r.views_as_of;
  END IF;
  IF EXISTS (SELECT 1 FROM public.videos_unassigned u WHERE u.id = 'd0000000-0000-0000-0000-000000000001' AND u.latest_views IS NOT NULL) THEN
    RAISE EXCEPTION 'case8: a video with no metrics has a view count';
  END IF;
  IF to_regclass('public.video_publications_video') IS NULL THEN
    RAISE EXCEPTION 'case8: the video_id index is missing';
  END IF;
  RAISE NOTICE 'case8 ok';
END $$;

ROLLBACK;
