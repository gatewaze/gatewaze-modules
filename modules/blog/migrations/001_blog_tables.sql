-- ============================================================================
-- Module: blog
-- Migration: 001_blog_tables
-- Description: Create blog tables for posts, categories, tags management
-- ============================================================================

-- Blog categories
CREATE TABLE IF NOT EXISTS public.blog_categories (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              varchar(255) NOT NULL,
  slug              varchar(255) NOT NULL UNIQUE,
  description       text,
  color             varchar(50) NOT NULL DEFAULT '#6B7280',
  image_url         text,
  post_count        integer NOT NULL DEFAULT 0,
  is_featured       boolean NOT NULL DEFAULT false,
  meta_title        varchar(255),
  meta_description  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.blog_categories IS 'Categories for blog posts';

CREATE INDEX IF NOT EXISTS idx_blog_categories_slug ON public.blog_categories (slug);

CREATE TRIGGER blog_categories_updated_at
  BEFORE UPDATE ON public.blog_categories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Blog tags
CREATE TABLE IF NOT EXISTS public.blog_tags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            varchar(255) NOT NULL,
  slug            varchar(255) NOT NULL UNIQUE,
  description     text,
  color           varchar(50) NOT NULL DEFAULT '#6B7280',
  post_count      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.blog_tags IS 'Tags for blog posts';

CREATE INDEX IF NOT EXISTS idx_blog_tags_slug ON public.blog_tags (slug);

CREATE TRIGGER blog_tags_updated_at
  BEFORE UPDATE ON public.blog_tags
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Blog posts
CREATE TABLE IF NOT EXISTS public.blog_posts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                 varchar(500) NOT NULL,
  slug                  varchar(500) NOT NULL UNIQUE,
  excerpt               text,
  content               text NOT NULL DEFAULT '',
  featured_image        text,
  featured_image_alt    varchar(500),
  status                varchar(20) NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'archived')),
  visibility            varchar(20) NOT NULL DEFAULT 'public'
                        CHECK (visibility IN ('public', 'private', 'password_protected')),
  password              varchar(255),
  -- SEO fields
  meta_title            varchar(255),
  meta_description      text,
  canonical_url         text,
  -- Social media fields
  og_title              varchar(255),
  og_description        text,
  og_image              text,
  twitter_title         varchar(255),
  twitter_description   text,
  twitter_image         text,
  -- Content management
  reading_time          integer,
  word_count            integer,
  allow_comments        boolean NOT NULL DEFAULT true,
  is_featured           boolean NOT NULL DEFAULT false,
  -- Analytics
  view_count            integer NOT NULL DEFAULT 0,
  like_count            integer NOT NULL DEFAULT 0,
  share_count           integer NOT NULL DEFAULT 0,
  -- Timestamps
  published_at          timestamptz,
  scheduled_for         timestamptz,
  -- Relationships
  category_id           uuid REFERENCES public.blog_categories (id) ON DELETE SET NULL,
  author_id             uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.blog_posts IS 'Blog posts with SEO, social media, and analytics fields';

CREATE INDEX IF NOT EXISTS idx_blog_posts_slug         ON public.blog_posts (slug);
CREATE INDEX IF NOT EXISTS idx_blog_posts_status       ON public.blog_posts (status);
CREATE INDEX IF NOT EXISTS idx_blog_posts_category     ON public.blog_posts (category_id);
CREATE INDEX IF NOT EXISTS idx_blog_posts_author       ON public.blog_posts (author_id);
CREATE INDEX IF NOT EXISTS idx_blog_posts_published_at ON public.blog_posts (published_at DESC);

CREATE TRIGGER blog_posts_updated_at
  BEFORE UPDATE ON public.blog_posts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Blog post tags junction table
CREATE TABLE IF NOT EXISTS public.blog_post_tags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         uuid NOT NULL REFERENCES public.blog_posts (id) ON DELETE CASCADE,
  tag_id          uuid NOT NULL REFERENCES public.blog_tags (id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_blog_post_tags_post ON public.blog_post_tags (post_id);
CREATE INDEX IF NOT EXISTS idx_blog_post_tags_tag  ON public.blog_post_tags (tag_id);

-- RPC function for incrementing view count
CREATE OR REPLACE FUNCTION public.increment_post_views(post_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE public.blog_posts
  SET view_count = view_count + 1
  WHERE id = post_id;
$$;

-- ============================================================================
-- RLS
-- ============================================================================
ALTER TABLE public.blog_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_post_tags ENABLE ROW LEVEL SECURITY;

-- SELECT: authenticated users
CREATE POLICY "blog_categories_select" ON public.blog_categories FOR SELECT TO authenticated USING (true);
CREATE POLICY "blog_tags_select" ON public.blog_tags FOR SELECT TO authenticated USING (true);
CREATE POLICY "blog_posts_select" ON public.blog_posts FOR SELECT TO authenticated USING (true);
CREATE POLICY "blog_post_tags_select" ON public.blog_post_tags FOR SELECT TO authenticated USING (true);

-- INSERT/UPDATE/DELETE: admin only
CREATE POLICY "blog_categories_insert" ON public.blog_categories FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "blog_categories_update" ON public.blog_categories FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "blog_categories_delete" ON public.blog_categories FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "blog_tags_insert" ON public.blog_tags FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "blog_tags_update" ON public.blog_tags FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "blog_tags_delete" ON public.blog_tags FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "blog_posts_insert" ON public.blog_posts FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "blog_posts_update" ON public.blog_posts FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "blog_posts_delete" ON public.blog_posts FOR DELETE TO authenticated USING (public.is_admin());

CREATE POLICY "blog_post_tags_insert" ON public.blog_post_tags FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "blog_post_tags_update" ON public.blog_post_tags FOR UPDATE TO authenticated USING (public.is_admin());
CREATE POLICY "blog_post_tags_delete" ON public.blog_post_tags FOR DELETE TO authenticated USING (public.is_admin());
