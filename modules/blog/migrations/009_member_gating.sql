-- ============================================================================
-- blog — opt-in member gating on post reads
-- ============================================================================
-- Adds content_access_visible('blog_post', id, published_at) to the SELECT RLS
-- so an admin can gate a post (or all posts, or recent posts via embargo_days)
-- to members via the content_access_policies registry. This is a NO-OP until a
-- policy is set: content_access_visible returns true when no policy exists.
-- Admins keep full read on the authenticated policy. content-platform is a
-- declared dependency, so content_access_visible exists at migration time.
-- ============================================================================

-- anon: published + public, AND (when gated) visible to this viewer.
DROP POLICY IF EXISTS "blog_posts_anon_select" ON public.blog_posts;
CREATE POLICY "blog_posts_anon_select" ON public.blog_posts
  FOR SELECT TO anon
  USING (
    status = 'published'
    AND visibility = 'public'
    AND public.content_access_visible('blog_post', id, published_at)
  );

-- authenticated: was USING(true); admins keep full read, everyone else is
-- subject to the gate (still a no-op until a policy exists).
DROP POLICY IF EXISTS "blog_posts_select" ON public.blog_posts;
CREATE POLICY "blog_posts_select" ON public.blog_posts
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.content_access_visible('blog_post', id, published_at));

-- CRITICAL: blog also has SECURITY DEFINER anon read RPCs that BYPASS RLS, so
-- the gate must be added to them too (else gated posts leak via the anon key).
-- Bodies otherwise verbatim from 005_keyword_adapter.sql.
CREATE OR REPLACE FUNCTION public.blog_posts_public_list(
  p_limit int DEFAULT 50, p_offset int DEFAULT 0, p_category_slug text DEFAULT NULL
) RETURNS SETOF public.blog_posts
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT bp.* FROM public.blog_posts bp
  LEFT JOIN public.content_keyword_item_state s
    ON s.content_type = 'blog_post' AND s.content_id = bp.id
  LEFT JOIN public.blog_categories bc ON bc.id = bp.category_id
  WHERE bp.status = 'published'
    AND COALESCE(s.is_visible,
                 (SELECT default_visible_when_no_rules FROM public.content_keyword_adapters WHERE content_type='blog_post'),
                 true) = true
    AND (p_category_slug IS NULL OR bc.slug = p_category_slug)
    AND public.content_access_visible('blog_post', bp.id, bp.published_at)
  ORDER BY bp.published_at DESC NULLS LAST, bp.id DESC
  LIMIT p_limit OFFSET p_offset;
$$;
ALTER FUNCTION public.blog_posts_public_list(int, int, text) OWNER TO gatewaze_module_writer;

CREATE OR REPLACE FUNCTION public.blog_posts_public_get(p_slug text)
RETURNS SETOF public.blog_posts
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT bp.* FROM public.blog_posts bp
  LEFT JOIN public.content_keyword_item_state s
    ON s.content_type = 'blog_post' AND s.content_id = bp.id
  WHERE bp.slug = p_slug AND bp.status = 'published'
    AND COALESCE(s.is_visible,
                 (SELECT default_visible_when_no_rules FROM public.content_keyword_adapters WHERE content_type='blog_post'),
                 true) = true
    AND public.content_access_visible('blog_post', bp.id, bp.published_at);
$$;
ALTER FUNCTION public.blog_posts_public_get(text) OWNER TO gatewaze_module_writer;
