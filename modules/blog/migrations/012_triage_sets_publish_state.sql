-- ============================================================================
-- blog — triage decisions set publish_state as well as status
-- ============================================================================
-- 004's approve/reject/submit only write blog_posts.status. The Content Inbox
-- and the verdict handler read publish_state (the portal reads status), so
-- approving a post in the inbox left it at publish_state = 'pending_review'
-- and it came back into the inbox on the next verdict. Same shape as
-- videos/004, which writes both columns.
--
-- Signatures, SECURITY DEFINER and search_path are unchanged, so the
-- content_triage_adapters regprocedure references still hold.
--
-- CREATE OR REPLACE keeps each function's ACL, so the anon/authenticated
-- revoke done in 011 still applies to these definitions.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.blog_triage_approve(
  p_content_id  uuid,
  p_categories  text[],
  p_featured    boolean,
  p_reviewer    uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_category_id uuid;
BEGIN
  IF p_categories IS NOT NULL AND array_length(p_categories, 1) > 0 THEN
    SELECT id INTO v_category_id FROM public.blog_categories WHERE slug = p_categories[1] LIMIT 1;
  END IF;

  UPDATE public.blog_posts
     SET status = 'published',
         publish_state = 'published',
         category_id = COALESCE(v_category_id, category_id),
         content_category = COALESCE(p_categories[1], content_category)
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blog post % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.blog_triage_reject(
  p_content_id uuid,
  p_reason     text,
  p_reviewer   uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.blog_posts
     SET status = 'rejected',
         publish_state = 'rejected',
         rejection_reason = p_reason
   WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blog post % not found', p_content_id USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.blog_triage_submit(
  p_content_id uuid,
  p_reopen     boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_reopen THEN
    UPDATE public.blog_posts
       SET status = 'pending_review', publish_state = 'pending_review'
     WHERE id = p_content_id AND status = 'published';
  ELSE
    UPDATE public.blog_posts
       SET status = 'pending_review', publish_state = 'pending_review'
     WHERE id = p_content_id AND status NOT IN ('pending_review','rejected','published','archived');
  END IF;
END $$;

-- Backfill the two status/publish_state mismatches:
--   1. status published but publish_state pending_review: approved in the
--      inbox by the old functions, or published from the blog admin editor,
--      which still writes status only (tracked as a follow-up);
--   2. status pending_review but publish_state published: scraped by a
--      scraper that set only status, so publish_state kept its default and
--      the post never reached the inbox. Move it to review and queue it.
UPDATE public.blog_posts
   SET publish_state = 'published'
 WHERE status = 'published' AND publish_state = 'pending_review';

DO $backfill$
DECLARE
  v_ids uuid[];
BEGIN
  -- Without the verdict queue nothing would submit the moved posts to
  -- triage, and this WHERE would not match them again, so leave them as is.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'content_publish_state_event_queue'
  ) THEN
    RETURN;
  END IF;

  WITH moved AS (
    UPDATE public.blog_posts
       SET publish_state = 'pending_review'
     WHERE status = 'pending_review' AND publish_state = 'published'
    RETURNING id
  )
  SELECT array_agg(id) INTO v_ids FROM moved;

  -- Queue a verdict event for each so the verdict handler submits it to
  -- triage, the same path FeedScraper posts take.
  IF v_ids IS NOT NULL THEN
    INSERT INTO public.content_publish_state_event_queue (content_type, content_id, trigger, payload)
    SELECT 'blog_post', id, 'blog_012_backfill', '{}'::jsonb FROM unnest(v_ids) AS id;
  END IF;
END
$backfill$;
