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
