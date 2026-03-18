-- ============================================================================
-- Module: event-topics
-- Migration: 001_event_topics_tables
-- Description: Taxonomy system - event categories, topics, tags, their junctions,
--              and topic categorization system
-- ============================================================================

-- ==========================================================================
-- 1. Categories (hierarchical via parent_id)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text UNIQUE NOT NULL,
  description text,
  parent_id   uuid REFERENCES public.events_categories(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.events_categories IS 'Event categories with optional hierarchy';

CREATE TABLE IF NOT EXISTS public.events_category_links (
  event_id    uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.events_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, category_id)
);

-- ==========================================================================
-- 2. Topics
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_topics (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text UNIQUE NOT NULL,
  display_order integer DEFAULT 0
);

COMMENT ON TABLE public.events_topics IS 'Event topics / subject areas';

CREATE TABLE IF NOT EXISTS public.events_topic_links (
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES public.events_topics(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, topic_id)
);

-- ==========================================================================
-- 3. Tags
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_tags (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL
);

COMMENT ON TABLE public.events_tags IS 'Freeform tags for events';

CREATE TABLE IF NOT EXISTS public.events_tag_links (
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  tag_id   uuid NOT NULL REFERENCES public.events_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, tag_id)
);

-- ==========================================================================
-- 4. Topic categories (for organizing topics into groups)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS public.events_topic_categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  parent_id     uuid REFERENCES public.events_topic_categories(id) ON DELETE SET NULL,
  display_order integer DEFAULT 0
);

COMMENT ON TABLE public.events_topic_categories IS 'Categories for organizing topics into groups';

-- Junction: topic <-> topic_category
CREATE TABLE IF NOT EXISTS public.events_topic_category_memberships (
  topic_id    uuid NOT NULL REFERENCES public.events_topics(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.events_topic_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (topic_id, category_id)
);

COMMENT ON TABLE public.events_topic_category_memberships IS 'Many-to-many link between topics and topic categories';

-- ==========================================================================
-- 5. RLS
-- ==========================================================================
ALTER TABLE public.events_topic_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events_topic_category_memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read access" ON public.events_topic_categories
  FOR SELECT USING (true);

CREATE POLICY "Authenticated users can manage" ON public.events_topic_categories
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Public read access" ON public.events_topic_category_memberships
  FOR SELECT USING (true);

CREATE POLICY "Authenticated users can manage" ON public.events_topic_category_memberships
  FOR ALL USING (auth.role() = 'authenticated');
