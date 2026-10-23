-- ============================================================================
-- Module: social-posts
-- Migration: 001_social_posts
-- Description: social post drafts written from curated content, the link from
--              each draft to the content it was written from, and the AI use
--              case the generator runs under. Drafts only: nothing here posts
--              to a network. scheduled/posted and the external_* columns are
--              for a later poster, so a draft saved today can be scheduled or
--              posted without a schema change. Idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. social_post_drafts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.social_post_drafts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform           text NOT NULL DEFAULT 'linkedin'
                     CHECK (platform IN ('linkedin')),
  format             text NOT NULL
                     CHECK (format IN ('announcement','event_promo','roundup','article_share','recap')),
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','ready','scheduled','posted','archived')),
  -- LinkedIn's hard limit is 3,000 characters; no supported platform allows more.
  body               text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 3000),
  hashtags           text[] NOT NULL DEFAULT '{}'::text[],
  mentions           text[] NOT NULL DEFAULT '{}'::text[],
  instructions       text CHECK (instructions IS NULL OR char_length(instructions) <= 1000),
  -- The model that wrote the first version, as reported by the editor's client.
  -- Informational only; the cost of every call is in ai_usage_events.
  ai_model           text CHECK (ai_model IS NULL OR ai_model ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  generated_at       timestamptz,
  scheduled_for      timestamptz,
  posted_at          timestamptz,
  external_post_id   text,
  external_url       text CHECK (external_url IS NULL OR external_url ~ '^https://'),
  created_by         uuid,
  updated_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.social_post_drafts IS
  'Social post drafts written from curated content (social-posts module). Drafts only; a later poster moves them to scheduled/posted.';

CREATE INDEX IF NOT EXISTS social_post_drafts_status_updated
  ON public.social_post_drafts (status, updated_at DESC);

DROP TRIGGER IF EXISTS social_post_drafts_updated_at ON public.social_post_drafts;
CREATE TRIGGER social_post_drafts_updated_at
  BEFORE UPDATE ON public.social_post_drafts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. social_post_draft_sources — which curated items a draft was written from.
--    content_type is the content-platform type key (blog_post, video, event,
--    sr_item). No FK to the content tables: they belong to other modules and
--    any of them may be absent. title/url are a snapshot taken at save time so
--    the draft still reads correctly if the item is later edited or removed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.social_post_draft_sources (
  draft_id      uuid NOT NULL REFERENCES public.social_post_drafts(id) ON DELETE CASCADE,
  content_type  text NOT NULL CHECK (content_type IN ('blog_post','video','event','sr_item')),
  content_id    uuid NOT NULL,
  position      smallint NOT NULL DEFAULT 0,
  title         text,
  url           text,
  PRIMARY KEY (draft_id, content_type, content_id)
);
CREATE INDEX IF NOT EXISTS social_post_draft_sources_content
  ON public.social_post_draft_sources (content_type, content_id);

-- ---------------------------------------------------------------------------
-- 3. RLS: admins only, matching discovery_sources and the other content
--    registries. On a portal brand every signed-in member is `authenticated`,
--    and drafts are unpublished copy. The module's API uses the service role
--    after its own is_admin() check.
-- ---------------------------------------------------------------------------
ALTER TABLE public.social_post_drafts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS social_post_drafts_admin_select ON public.social_post_drafts;
CREATE POLICY social_post_drafts_admin_select ON public.social_post_drafts
  FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS social_post_drafts_admin_write ON public.social_post_drafts;
CREATE POLICY social_post_drafts_admin_write ON public.social_post_drafts
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.social_post_drafts TO authenticated;
GRANT ALL ON public.social_post_drafts TO service_role;

ALTER TABLE public.social_post_draft_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS social_post_draft_sources_admin_select ON public.social_post_draft_sources;
CREATE POLICY social_post_draft_sources_admin_select ON public.social_post_draft_sources
  FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS social_post_draft_sources_admin_write ON public.social_post_draft_sources;
CREATE POLICY social_post_draft_sources_admin_write ON public.social_post_draft_sources
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.social_post_draft_sources TO authenticated;
GRANT ALL ON public.social_post_draft_sources TO service_role;

-- ---------------------------------------------------------------------------
-- 4. AI use case. runChat refuses an unregistered use case; this row carries
--    the model allow-list and the daily cost cap ($2/day) the generator runs
--    under. No web tools: the post is written only from the curated items.
--    ON CONFLICT DO NOTHING keeps operator edits on a re-run. Skipped when the
--    ai module is absent (the generate endpoint then answers 503).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.ai_use_cases') IS NULL THEN
    RAISE NOTICE 'social-posts: ai module not installed — skipping the social-posts-linkedin use case';
    RETURN;
  END IF;
  INSERT INTO public.ai_use_cases
    (id, label, description, default_provider, default_model, allowed_models,
     allowed_web_tools, max_output_tokens, daily_cost_cap_micro_usd)
  VALUES (
    'social-posts-linkedin',
    'Social posts: LinkedIn',
    'Writes a LinkedIn post draft (hook, short paragraphs, links, hashtags, member mentions) from curated content items. Forced tool use, no web tools.',
    'anthropic',
    'claude-sonnet-5',
    ARRAY['claude-sonnet-5','claude-sonnet-4-5','claude-haiku-4-5'],
    ARRAY[]::text[],
    2000,
    2000000
  ) ON CONFLICT (id) DO NOTHING;
END $$;
