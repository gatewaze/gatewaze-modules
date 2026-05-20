-- spec-ai-mcp-extensions.md §Data Models §Use-case templates — seed
-- the five built-in templates as is_builtin=true rows. These are
-- immutable (admin API rejects PATCH/DELETE on is_builtin=true rows).

INSERT INTO public.ai_use_case_templates (
  name, display_name, description, is_builtin,
  suggested_provider, suggested_model,
  suggested_allowed_web_tools, suggested_allowed_mcp_server_names,
  goose_runtime_overrides,
  hint_recipe_file_pattern, hint_skill_dir_pattern
) VALUES
  (
    'research',
    'Research (long-horizon, many tool calls)',
    'Web research workflows that legitimately fire many tool calls. High tool-call budget, longer turn budget, delayed compaction, suggested MCP servers for web search and page fetching.',
    true,
    'auto', 'claude-sonnet-4-5',
    '["web_search","fetch_url","gatewaze_search"]'::jsonb,
    '["brave-search","scrapling-fetcher"]'::jsonb,
    '{"GOOSE_TOOL_CALL_CUTOFF": 50000, "GATEWAZE_GOOSE_MAX_TURNS": 500, "GATEWAZE_GOOSE_MAX_TOOL_REPETITIONS": 200, "GOOSE_AUTO_COMPACT_THRESHOLD": 0.85}'::jsonb,
    'recipes/%-research/recipe.yaml',
    NULL
  ),
  (
    'interactive-chat-approval',
    'Interactive chat (approval-required)',
    'Conversational use cases where the operator confirms each tool call before it fires. Conservative tool budget, short turn limit, no MCP by default.',
    true,
    'auto', 'claude-haiku-4-5',
    '[]'::jsonb,
    '[]'::jsonb,
    '{"GOOSE_MODE": "approval", "GOOSE_TOOL_CALL_CUTOFF": 1000, "GATEWAZE_GOOSE_MAX_TURNS": 30}'::jsonb,
    NULL,
    NULL
  ),
  (
    'image-gen',
    'Image generation',
    'Single-shot image generation. Minimal turn/tool budget. Gemini Nano Banana by default. Skill binding pattern hints at the matching cover-image skill.',
    true,
    'gemini', 'gemini-2.5-flash-image',
    '[]'::jsonb,
    '[]'::jsonb,
    '{"GATEWAZE_GOOSE_MAX_TURNS": 10, "GATEWAZE_GOOSE_MAX_TOOL_REPETITIONS": 5}'::jsonb,
    NULL,
    'skills/%-cover-image'
  ),
  (
    'brief-qa',
    'Brief Q&A',
    'Short fact-lookup or definition questions. Aggressive compaction (cost optimisation), tiny turn budget.',
    true,
    'anthropic', 'claude-haiku-4-5',
    '[]'::jsonb,
    '[]'::jsonb,
    '{"GATEWAZE_GOOSE_MAX_TURNS": 5, "GOOSE_AUTO_COMPACT_THRESHOLD": 0.5}'::jsonb,
    NULL,
    NULL
  ),
  (
    'recipe-autopilot',
    'Recipe autopilot',
    'Generic recipe-driven autopilot. Auto-mode tool confirmation, generous turn/tool budget. Pairs with any recipe binding.',
    true,
    'auto', 'auto',
    '["web_search"]'::jsonb,
    '[]'::jsonb,
    '{"GOOSE_MODE": "auto", "GATEWAZE_GOOSE_MAX_TURNS": 500, "GATEWAZE_GOOSE_MAX_TOOL_REPETITIONS": 200}'::jsonb,
    NULL,
    NULL
  )
ON CONFLICT (name) DO NOTHING;
