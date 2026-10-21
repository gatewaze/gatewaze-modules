-- ============================================================================
-- blog — inbox detail for the Content Inbox drawer
--
-- Registers blog_inbox_detail as the blog_post type's inbox_detail_fn
-- (content-platform/012), so the drawer can link to the original post, show
-- its featured image and preview the stored body before a reviewer approves.
--
--   url        canonical_url, https only (external posts link to the source)
--   image_url  featured_image, else og_image, https only
--   body_html  content (sanitised when it was stored; the admin sanitises
--              again before rendering)
--
-- Same ACL as the other blog adapter functions (011): service_role only.
-- Registration is guarded so this is a no-op without content-platform/012.
-- Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.blog_inbox_detail(p_id uuid)
RETURNS TABLE(url text, image_url text, body_html text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN b.canonical_url ~* '^https://' THEN b.canonical_url END::text,
         CASE
           WHEN b.featured_image ~* '^https://' THEN b.featured_image
           WHEN b.og_image ~* '^https://' THEN b.og_image
         END::text,
         b.content::text
  FROM public.blog_posts b WHERE b.id = p_id;
$$;

DO $owner$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gatewaze_module_writer') THEN
    CREATE ROLE gatewaze_module_writer NOLOGIN;
  END IF;
  EXECUTE format('GRANT gatewaze_module_writer TO %I', current_user);
  ALTER FUNCTION public.blog_inbox_detail(uuid) OWNER TO gatewaze_module_writer;

  REVOKE ALL ON FUNCTION public.blog_inbox_detail(uuid) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.blog_inbox_detail(uuid) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.blog_inbox_detail(uuid) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.blog_inbox_detail(uuid) TO service_role;
  END IF;
END
$owner$;

DO $register$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'content_publish_adapters'
       AND column_name = 'inbox_detail_fn'
  ) THEN
    RAISE NOTICE '[blog/013] content-platform inbox_detail_fn not available; skipping registration';
    RETURN;
  END IF;

  UPDATE public.content_publish_adapters
     SET inbox_detail_fn = 'public.blog_inbox_detail(uuid)'::regprocedure
   WHERE content_type = 'blog_post';
END
$register$;
