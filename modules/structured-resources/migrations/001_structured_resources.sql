-- ============================================================
-- Structured Resources Module - Migration 001
-- Creates all tables, indexes, RLS policies, triggers, and RPC functions
-- ============================================================

-- ============================================================
-- Collections: top-level resource groupings
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sr_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  cover_image_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  access TEXT NOT NULL DEFAULT 'inherit' CHECK (access IN ('public', 'authenticated', 'inherit')),
  meta_title TEXT,
  meta_description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sr_collections_slug ON public.sr_collections(slug);
CREATE INDEX IF NOT EXISTS idx_sr_collections_status ON public.sr_collections(status);
CREATE INDEX IF NOT EXISTS idx_sr_collections_access ON public.sr_collections(access);

-- ============================================================
-- Section Templates: define expected sections per collection
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sr_section_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES public.sr_collections(id) ON DELETE CASCADE,
  heading TEXT NOT NULL,
  description TEXT,
  is_required BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(collection_id, heading)
);

CREATE INDEX IF NOT EXISTS idx_sr_section_templates_collection ON public.sr_section_templates(collection_id);

-- ============================================================
-- Categories: groupings within a collection
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sr_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES public.sr_collections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(collection_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_sr_categories_collection ON public.sr_categories(collection_id);

-- ============================================================
-- Items: individual resources within a category
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sr_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES public.sr_collections(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES public.sr_categories(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  subtitle TEXT,
  external_url TEXT,
  featured_image_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(collection_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_sr_items_collection ON public.sr_items(collection_id);
CREATE INDEX IF NOT EXISTS idx_sr_items_category ON public.sr_items(category_id);
CREATE INDEX IF NOT EXISTS idx_sr_items_status ON public.sr_items(status);

-- Full-text search: stored tsvector column on items (title + subtitle)
ALTER TABLE public.sr_items ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(subtitle, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_sr_items_search ON public.sr_items USING GIN(search_vector);

-- ============================================================
-- Sections: content blocks within an item
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sr_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES public.sr_items(id) ON DELETE CASCADE,
  template_id UUID REFERENCES public.sr_section_templates(id) ON DELETE SET NULL,
  heading TEXT NOT NULL,
  content TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sr_sections_item ON public.sr_sections(item_id);

-- Full-text search: stored tsvector column on sections (content)
ALTER TABLE public.sr_sections ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', COALESCE(content, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_sr_sections_search ON public.sr_sections USING GIN(search_vector);

-- ============================================================
-- Updated_at triggers
-- ============================================================
CREATE OR REPLACE FUNCTION sr_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sr_collections_updated_at ON public.sr_collections;
CREATE TRIGGER sr_collections_updated_at BEFORE UPDATE ON public.sr_collections
  FOR EACH ROW EXECUTE FUNCTION sr_update_timestamp();

DROP TRIGGER IF EXISTS sr_section_templates_updated_at ON public.sr_section_templates;
CREATE TRIGGER sr_section_templates_updated_at BEFORE UPDATE ON public.sr_section_templates
  FOR EACH ROW EXECUTE FUNCTION sr_update_timestamp();

DROP TRIGGER IF EXISTS sr_categories_updated_at ON public.sr_categories;
CREATE TRIGGER sr_categories_updated_at BEFORE UPDATE ON public.sr_categories
  FOR EACH ROW EXECUTE FUNCTION sr_update_timestamp();

DROP TRIGGER IF EXISTS sr_items_updated_at ON public.sr_items;
CREATE TRIGGER sr_items_updated_at BEFORE UPDATE ON public.sr_items
  FOR EACH ROW EXECUTE FUNCTION sr_update_timestamp();

DROP TRIGGER IF EXISTS sr_sections_updated_at ON public.sr_sections;
CREATE TRIGGER sr_sections_updated_at BEFORE UPDATE ON public.sr_sections
  FOR EACH ROW EXECUTE FUNCTION sr_update_timestamp();

-- ============================================================
-- RLS Policies
-- ============================================================
ALTER TABLE public.sr_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sr_section_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sr_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sr_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sr_sections ENABLE ROW LEVEL SECURITY;

-- Admin full access (CRUD)
DROP POLICY IF EXISTS "sr_collections_admin_all" ON public.sr_collections;
CREATE POLICY "sr_collections_admin_all" ON public.sr_collections
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "sr_section_templates_admin_all" ON public.sr_section_templates;
CREATE POLICY "sr_section_templates_admin_all" ON public.sr_section_templates
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "sr_categories_admin_all" ON public.sr_categories;
CREATE POLICY "sr_categories_admin_all" ON public.sr_categories
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "sr_items_admin_all" ON public.sr_items;
CREATE POLICY "sr_items_admin_all" ON public.sr_items
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "sr_sections_admin_all" ON public.sr_sections;
CREATE POLICY "sr_sections_admin_all" ON public.sr_sections
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- Authenticated portal users: read-only on published content (all collections)
-- NOTE: The 'access' column is intentionally NOT checked here. All authenticated users
-- can read all published content. The 'access' field (public/authenticated/inherit)
-- controls portal UI rendering only — whether anon visitors see the content.
-- This is by design per spec: "all authenticated portal users see all published content."
DROP POLICY IF EXISTS "sr_collections_auth_select" ON public.sr_collections;
CREATE POLICY "sr_collections_auth_select" ON public.sr_collections
  FOR SELECT TO authenticated
  USING (status = 'published');

DROP POLICY IF EXISTS "sr_section_templates_auth_select" ON public.sr_section_templates;
CREATE POLICY "sr_section_templates_auth_select" ON public.sr_section_templates
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.sr_collections
    WHERE id = sr_section_templates.collection_id AND status = 'published'
  ));

DROP POLICY IF EXISTS "sr_categories_auth_select" ON public.sr_categories;
CREATE POLICY "sr_categories_auth_select" ON public.sr_categories
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.sr_collections
    WHERE id = sr_categories.collection_id AND status = 'published'
  ));

DROP POLICY IF EXISTS "sr_items_auth_select" ON public.sr_items;
CREATE POLICY "sr_items_auth_select" ON public.sr_items
  FOR SELECT TO authenticated
  USING (
    status = 'published'
    AND EXISTS (
      SELECT 1 FROM public.sr_collections
      WHERE id = sr_items.collection_id AND status = 'published'
    )
  );

DROP POLICY IF EXISTS "sr_sections_auth_select" ON public.sr_sections;
CREATE POLICY "sr_sections_auth_select" ON public.sr_sections
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.sr_items
    WHERE id = sr_sections.item_id AND status = 'published'
    AND EXISTS (
      SELECT 1 FROM public.sr_collections
      WHERE id = sr_items.collection_id AND status = 'published'
    )
  ));

-- Anon users: collection metadata for all published (teaser support)
DROP POLICY IF EXISTS "sr_collections_anon_select" ON public.sr_collections;
CREATE POLICY "sr_collections_anon_select" ON public.sr_collections
  FOR SELECT TO anon
  USING (status = 'published');

-- Anon users: full content access ONLY for explicitly public collections
DROP POLICY IF EXISTS "sr_categories_anon_select" ON public.sr_categories;
CREATE POLICY "sr_categories_anon_select" ON public.sr_categories
  FOR SELECT TO anon
  USING (EXISTS (
    SELECT 1 FROM public.sr_collections
    WHERE id = sr_categories.collection_id
    AND status = 'published' AND access = 'public'
  ));

DROP POLICY IF EXISTS "sr_items_anon_select" ON public.sr_items;
CREATE POLICY "sr_items_anon_select" ON public.sr_items
  FOR SELECT TO anon
  USING (
    status = 'published'
    AND EXISTS (
      SELECT 1 FROM public.sr_collections
      WHERE id = sr_items.collection_id
      AND status = 'published' AND access = 'public'
    )
  );

DROP POLICY IF EXISTS "sr_sections_anon_select" ON public.sr_sections;
CREATE POLICY "sr_sections_anon_select" ON public.sr_sections
  FOR SELECT TO anon
  USING (EXISTS (
    SELECT 1 FROM public.sr_items
    WHERE id = sr_sections.item_id AND status = 'published'
    AND EXISTS (
      SELECT 1 FROM public.sr_collections
      WHERE id = sr_items.collection_id
      AND status = 'published' AND access = 'public'
    )
  ));

DROP POLICY IF EXISTS "sr_section_templates_anon_select" ON public.sr_section_templates;
CREATE POLICY "sr_section_templates_anon_select" ON public.sr_section_templates
  FOR SELECT TO anon
  USING (EXISTS (
    SELECT 1 FROM public.sr_collections
    WHERE id = sr_section_templates.collection_id
    AND status = 'published' AND access = 'public'
  ));

-- ============================================================
-- RPC: Full-text search across items and sections
-- ============================================================
CREATE OR REPLACE FUNCTION sr_search_items(
  p_collection_id UUID,
  p_query TEXT,
  p_category_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  item_id UUID,
  item_title TEXT,
  item_slug TEXT,
  item_subtitle TEXT,
  category_id UUID,
  category_name TEXT,
  category_slug TEXT,
  relevance REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (i.id)
    i.id AS item_id,
    i.title AS item_title,
    i.slug AS item_slug,
    i.subtitle AS item_subtitle,
    c.id AS category_id,
    c.name AS category_name,
    c.slug AS category_slug,
    ts_rank(
      i.search_vector || COALESCE(s.search_vector, ''::tsvector),
      plainto_tsquery('english', p_query)
    ) AS relevance
  FROM public.sr_items i
  JOIN public.sr_categories c ON c.id = i.category_id
  LEFT JOIN public.sr_sections s ON s.item_id = i.id
  WHERE i.collection_id = p_collection_id
    AND i.status = 'published'
    AND (p_category_id IS NULL OR i.category_id = p_category_id)
    AND (
      i.search_vector @@ plainto_tsquery('english', p_query)
      OR EXISTS (
        SELECT 1 FROM public.sr_sections sec
        WHERE sec.item_id = i.id
        AND sec.search_vector @@ plainto_tsquery('english', p_query)
      )
    )
  ORDER BY i.id, relevance DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
