-- Blog Module: Core Tables
-- Migration: 001_blog_tables.sql

-- 1. Blog categories
CREATE TABLE IF NOT EXISTS public.module_blog_categories (
  id bigserial PRIMARY KEY,
  name text UNIQUE NOT NULL,
  slug text UNIQUE NOT NULL,
  description text,
  created_at timestamptz DEFAULT now()
);

-- 2. Blog posts
CREATE TABLE IF NOT EXISTS public.module_blog_posts (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  slug text UNIQUE NOT NULL,
  content text,
  excerpt text,
  category_id bigint REFERENCES public.module_blog_categories(id) ON DELETE SET NULL,
  author_name text,
  status text NOT NULL DEFAULT 'draft', -- draft, published, archived
  featured_image_url text,
  published_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_module_blog_posts_status ON public.module_blog_posts(status);
CREATE INDEX IF NOT EXISTS idx_module_blog_posts_category ON public.module_blog_posts(category_id);
CREATE INDEX IF NOT EXISTS idx_module_blog_posts_published ON public.module_blog_posts(published_at DESC);

-- 3. RLS
ALTER TABLE public.module_blog_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_blog_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_module_blog_categories" ON public.module_blog_categories FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_blog_posts" ON public.module_blog_posts FOR ALL TO authenticated USING (true) WITH CHECK (true);
