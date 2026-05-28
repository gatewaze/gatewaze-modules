-- Add content_category to blog_posts table.
-- This is the platform-wide content category (separate from blog-specific categories).

ALTER TABLE public.blog_posts ADD COLUMN IF NOT EXISTS content_category varchar(100);
CREATE INDEX IF NOT EXISTS idx_blog_posts_content_category ON public.blog_posts (content_category);
