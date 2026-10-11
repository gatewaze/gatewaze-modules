-- ============================================================================
-- Module: videos
-- Migration: 008_publication_copy
-- Description: Tie generated copy to the PUBLICATION rather than the video,
--              and bind the four lf-agents recipes that produce it.
-- ============================================================================
--
-- Why copy belongs on the publication.
--
-- 007 put a draft title and description on video_publications already, but
-- treated them as one set of words per video. Measuring what the two AAIF
-- channels actually publish, on 2026-10-11 across their 30 most recent
-- videos, says that is wrong:
--
--   @AgenticAI-Foundation (40.8k subs): no hashtags in 15 of 15, no @mentions
--     in 15 of 15, long four-part descriptions.
--   @AAIFLive (467 subs): hashtags in the title in 6 of 15, @mentions of the
--     guest's company in 10 of 15, descriptions of 50-200 characters.
--
-- So the same recording published to both channels needs two different sets
-- of words, and the unit that owns them is the publication — one video, one
-- connection, one title.
--
-- The same measurement killed the old title format. 0 of 30 published titles
-- use the "Talk title | Speaker" shape the deterministic template emitted,
-- 0 name the speaker at all, and the median length is 40 characters against a
-- 100-character budget. The template now emits the talk title alone and the
-- recipe writes the hook.

SET statement_timeout = '300s';

-- ==========================================================================
-- 1. Copy, per publication
-- ==========================================================================
ALTER TABLE public.video_publications
  ADD COLUMN IF NOT EXISTS copy_source      text
    CHECK (copy_source IS NULL OR copy_source IN ('recipe', 'template', 'human')),
  ADD COLUMN IF NOT EXISTS copy_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS hashtags          text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS chapters          jsonb  NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS thumbnail_asset_id uuid REFERENCES public.video_assets(id) ON DELETE SET NULL,
  -- What the editor changed after generation, so a regenerate can refuse to
  -- overwrite it. Same posture as the schedule importer's edit preservation.
  ADD COLUMN IF NOT EXISTS copy_edited_fields text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.video_publications.copy_source IS
  '"recipe" when the ai module wrote it, "template" when the deterministic fallback in lib/titles.ts did, "human" once an editor has changed it. A regenerate never overwrites a field listed in copy_edited_fields.';

COMMENT ON COLUMN public.video_publications.chapters IS
  'YouTube chapter list as [{seconds, label}], from the video-chapters recipe. Rendered into the description as the Timestamps block. Empty when the transcript could not support a valid list — YouTube requires at least three chapters, the first at 0:00, each at least 10 seconds, or none of them render.';

COMMENT ON COLUMN public.video_publications.hashtags IS
  'Lower-case hashtags. Populated for the @AAIFLive profile and for shorts; empty for @AgenticAI-Foundation, which uses none on any of its 15 most recent videos.';

-- ==========================================================================
-- 2. Which channel's house style a connection follows
-- ==========================================================================
--
-- video_publications.connection_id has pointed at nothing since 007, because
-- the connections table belongs to the unbuilt publisher half. This is the
-- narrow piece needed NOW: the copy recipe has to know which of the two
-- channel profiles applies, and that is a property of the account.
--
-- Deliberately NOT the full video_platform_connections table. That one needs
-- OAuth credentials, metric collection state and a per-platform adapter, and
-- inventing its shape here would commit the publisher build to a guess.
CREATE TABLE IF NOT EXISTS public.video_channel_profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform      text NOT NULL,
  -- The platform's own id for the account: a YouTube channel id, a TikTok
  -- handle. Unique per platform so one account cannot be registered twice
  -- and double its numbers when metrics land.
  external_id   text NOT NULL,
  label         text NOT NULL,
  -- Which editorial profile in the video-publication-copy skill applies.
  profile       text NOT NULL DEFAULT 'foundation'
    CHECK (profile IN ('foundation', 'live', 'shorts')),
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, external_id)
);

-- At most one default per platform. `((platform))` and not `((true))`:
-- one default per platform is the rule, not one default overall.
CREATE UNIQUE INDEX IF NOT EXISTS video_channel_profiles_one_default
  ON public.video_channel_profiles ((platform))
  WHERE is_default;

COMMENT ON TABLE public.video_channel_profiles IS
  'One row per publishing account, carrying only what the copy recipes need: which editorial profile the account follows. AAIF runs two YouTube channels with measurably different house styles, so this cannot be a per-platform setting. Credentials and metrics belong to the unbuilt video_platform_connections table, not here.';

ALTER TABLE public.video_channel_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS video_channel_profiles_read ON public.video_channel_profiles;
CREATE POLICY video_channel_profiles_read
  ON public.video_channel_profiles FOR SELECT
  USING (public.can_edit_any_videos());

REVOKE ALL ON public.video_channel_profiles FROM anon;

-- The two real channels, measured 2026-10-11. Idempotent on (platform,
-- external_id) so re-running never duplicates an account.
INSERT INTO public.video_channel_profiles (platform, external_id, label, profile, is_default)
VALUES
  ('youtube', 'UCG6qpjVnBTTT8wLGBygANOQ', 'Agentic AI Foundation', 'foundation', true),
  ('youtube', 'UCLAh-x7caEkg2jsbhNmg-3Q', 'AAIF Live',             'live',       false),
  ('tiktok',    'agentic.conversations',  'Agentic Conversations', 'shorts',     true),
  ('instagram', 'agentic.conversations',  'Agentic Conversations', 'shorts',     true)
ON CONFLICT (platform, external_id) DO NOTHING;

-- ==========================================================================
-- 3. Bind the four recipes
-- ==========================================================================
DO $$
DECLARE
  v_source_id uuid;
  r record;
BEGIN
  IF to_regclass('public.ai_use_cases') IS NULL
     OR to_regclass('public.ai_agent_sources') IS NULL THEN
    RAISE NOTICE 'ai module not installed — skipping the video copy use-case seeds; the deterministic template in lib/titles.ts covers it';
    RETURN;
  END IF;

  SELECT id INTO v_source_id
    FROM public.ai_agent_sources
   WHERE git_url = 'https://github.com/gatewaze/lf-agents.git' AND branch = 'main';

  IF v_source_id IS NULL THEN
    INSERT INTO public.ai_agent_sources (label, description, git_url, branch, path_prefix)
    VALUES ('LF Agents', 'Shared goose recipes + skills (gatewaze/lf-agents)',
            'https://github.com/gatewaze/lf-agents.git', 'main', '')
    RETURNING id INTO v_source_id;
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('video-publication-copy', 'Video publication copy',
       'Writes the hook-first title and four-part description one video gets on one specific channel, in that channel''s measured house style.',
       'claude-sonnet-5', 12000),
      ('video-chapters', 'Video chapters',
       'Turns a timestamped transcript into a valid YouTube chapter list, refusing rather than guessing when it cannot.',
       'claude-sonnet-5', 8000),
      ('video-short-caption', 'Video short caption',
       'Writes the hook-first caption and hashtags for one short vertical clip, per platform.',
       'claude-sonnet-5', 6000),
      ('video-thumbnail', 'Video thumbnail',
       'Renders the thumbnail for a talk video (16:9) or the poster frame for a short (9:16). Resolved as a prompt template, not executed by goose.',
       'gemini-2.5-flash-image', 4000)
    ) AS t(id, label, description, model, max_tokens)
  LOOP
    INSERT INTO public.ai_use_cases
      (id, label, description, default_provider, default_model, allowed_models,
       allowed_web_tools, max_output_tokens, daily_cost_cap_micro_usd)
    VALUES (
      r.id, r.label, r.description,
      CASE WHEN r.model LIKE 'gemini%' THEN 'gemini' ELSE 'anthropic' END,
      r.model, ARRAY[r.model],
      -- No web tools: every one of these writes from the prompt only.
      ARRAY[]::text[], r.max_tokens, 5000000
    ) ON CONFLICT (id) DO NOTHING;

    UPDATE public.ai_use_cases SET
        recipe_source_id = v_source_id,
        recipe_file_path = 'recipes/' || r.id || '/recipe.yaml',
        updated_at = now()
      WHERE id = r.id;
  END LOOP;

  RAISE NOTICE 'seeded 4 video copy use-cases (source %)', v_source_id;
END
$$;
