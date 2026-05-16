-- ============================================================================
-- Module: ai
-- Migration: 007_ai_seed_use_cases
-- Description: Seed the use-case registry with the seven entry points
--              identified in spec-ai-module §1. Each has defaults +
--              allowed_models + allowed_web_tools. Operators tweak via
--              /admin/ai/use-cases.
-- ============================================================================

INSERT INTO public.ai_use_cases
  (id, label, description, default_provider, default_model, allowed_models, allowed_web_tools, max_output_tokens, daily_cost_cap_micro_usd)
VALUES
  (
    'editor-ai-copilot',
    'Canvas editor copilot',
    'AI sidebar in the Puck-based site/newsletter editor. Generates or revises pages from prompts; tool-uses fetch_url for source-document grounding.',
    'auto',
    'claude-sonnet-4-5',
    ARRAY['claude-sonnet-4-5','claude-opus-4-5','gpt-5','gpt-5-mini','gemini-3-pro'],
    ARRAY['web_search','fetch_url']::text[],
    8000,
    NULL  -- no cap; operators set per tenant
  ),
  (
    'daily-briefing-research',
    'Daily Briefing research autopilot',
    'Multi-turn research pass for the EXAMPLE daily-briefing module. Web-searches the past 24 hours of agentic-AI news and returns candidate stories with sources.',
    'anthropic',
    'claude-sonnet-4-5',
    ARRAY['claude-sonnet-4-5','claude-haiku-4-5'],
    ARRAY['web_search','fetch_url']::text[],
    8000,
    5000000  -- ~$5/day soft cap; cron-driven so cost is predictable
  ),
  (
    'daily-briefing-cover',
    'Daily Briefing cover image',
    'Generates the newspaper-comic cover image for a daily briefing using Gemini Nano Banana.',
    'gemini',
    'gemini-2.5-flash-image',
    ARRAY['gemini-2.5-flash-image','gpt-image-1'],
    ARRAY[]::text[],
    0,  -- not a chat use-case; image-gen only
    1000000  -- ~$1/day
  ),
  (
    'portal-chat',
    'Portal chat assistant',
    'Public-facing chat on the portal home page for event discovery, registration help, networking matching.',
    'anthropic',
    'claude-haiku-4-5',
    ARRAY['claude-haiku-4-5','claude-sonnet-4-5','gpt-5-mini'],
    ARRAY[]::text[],
    4000,
    20000000  -- ~$20/day (public-facing, higher volume)
  ),
  (
    'portal-ai-search',
    'Portal semantic search embeddings',
    'Generates embeddings for the hybrid keyword+vector search on the portal.',
    'openai',
    'text-embedding-3-small',
    ARRAY['text-embedding-3-small','text-embedding-3-large'],
    ARRAY[]::text[],
    0,
    5000000  -- ~$5/day
  ),
  (
    'attendee-matching',
    'Event attendee networking pairs',
    'Generates optimal 1:1 networking pairings for event registrants. Triggered on registration close.',
    'anthropic',
    'claude-haiku-4-5',
    ARRAY['claude-haiku-4-5','claude-sonnet-4-5'],
    ARRAY[]::text[],
    8000,
    2000000  -- ~$2 per event
  ),
  (
    'content-pipeline-embed',
    'Content pipeline embeddings',
    'Generates vector embeddings for content discovery + taxonomy on indexing.',
    'openai',
    'text-embedding-3-small',
    ARRAY['text-embedding-3-small','text-embedding-3-large'],
    ARRAY[]::text[],
    0,
    10000000  -- ~$10/day (bulk indexing)
  )
ON CONFLICT (id) DO NOTHING;
