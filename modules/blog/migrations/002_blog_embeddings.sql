-- ============================================================================
-- Module: blog
-- Migration: 002_blog_embeddings
-- Description: Add anon RLS policies for portal access, create blog embeddings
--              table and search RPC for AI-powered search
-- ============================================================================

-- ============================================================================
-- Anon SELECT policies (portal is public, uses anon key)
-- Use DROP IF EXISTS to make idempotent (in case a prior run partially applied)
-- ============================================================================
DROP POLICY IF EXISTS "blog_posts_anon_select" ON public.blog_posts;
CREATE POLICY "blog_posts_anon_select" ON public.blog_posts
  FOR SELECT TO anon
  USING (status = 'published' AND visibility = 'public');

DROP POLICY IF EXISTS "blog_categories_anon_select" ON public.blog_categories;
CREATE POLICY "blog_categories_anon_select" ON public.blog_categories
  FOR SELECT TO anon
  USING (true);

DROP POLICY IF EXISTS "blog_tags_anon_select" ON public.blog_tags;
CREATE POLICY "blog_tags_anon_select" ON public.blog_tags
  FOR SELECT TO anon
  USING (true);

DROP POLICY IF EXISTS "blog_post_tags_anon_select" ON public.blog_post_tags;
CREATE POLICY "blog_post_tags_anon_select" ON public.blog_post_tags
  FOR SELECT TO anon
  USING (true);

-- ============================================================================
-- Blog embeddings table (requires pgvector extension)
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.blog_embeddings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id          uuid NOT NULL UNIQUE REFERENCES public.blog_posts(id) ON DELETE CASCADE,
  description_text text NOT NULL DEFAULT '',
  embedding        vector(1536),
  model_version    text NOT NULL DEFAULT 'text-embedding-3-small',
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blog_embeddings_post
  ON public.blog_embeddings (post_id);

-- HNSW index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS idx_blog_embeddings_vector
  ON public.blog_embeddings
  USING hnsw (embedding vector_cosine_ops);

-- RLS
ALTER TABLE public.blog_embeddings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "blog_embeddings_anon_select" ON public.blog_embeddings;
CREATE POLICY "blog_embeddings_anon_select" ON public.blog_embeddings
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "blog_embeddings_select" ON public.blog_embeddings;
CREATE POLICY "blog_embeddings_select" ON public.blog_embeddings
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "blog_embeddings_insert" ON public.blog_embeddings;
CREATE POLICY "blog_embeddings_insert" ON public.blog_embeddings
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "blog_embeddings_update" ON public.blog_embeddings;
CREATE POLICY "blog_embeddings_update" ON public.blog_embeddings
  FOR UPDATE TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "blog_embeddings_delete" ON public.blog_embeddings;
CREATE POLICY "blog_embeddings_delete" ON public.blog_embeddings
  FOR DELETE TO authenticated USING (public.is_admin());

-- ============================================================================
-- Semantic search RPC
-- ============================================================================
CREATE OR REPLACE FUNCTION public.blog_search_similar(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  post_id uuid,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    be.post_id,
    1 - (be.embedding <=> query_embedding) AS similarity
  FROM public.blog_embeddings be
  JOIN public.blog_posts bp ON bp.id = be.post_id
  WHERE bp.status = 'published'
    AND bp.visibility = 'public'
    AND 1 - (be.embedding <=> query_embedding) > match_threshold
  ORDER BY be.embedding <=> query_embedding
  LIMIT match_count;
$$;
