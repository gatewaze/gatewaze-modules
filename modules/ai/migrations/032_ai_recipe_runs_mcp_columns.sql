-- spec-ai-mcp-extensions.md §Data Models §Run warnings & loaded servers.
--
-- Adds the per-run MCP provenance columns to ai_recipe_runs:
--   - loaded_mcp_server_names: text[] of names actually loaded by the
--     spawn (intersection of recipe-declared ∩ allowlisted ∩ enabled).
--   - mcp_warnings: structured warning objects (NOT a text[]; the
--     canonical type is jsonb to carry { code, server, details }).
--   - failure_details: canonical error envelope populated atomically
--     with status='failed' on any mcp_load_failed / recipe_runtime_error.
--   - goose_runtime_overrides_snapshot: snapshot of the use-case's
--     goose_runtime_overrides at run-time, frozen so an audit can
--     answer "what tunings were active for run X" even after the use
--     case has since been edited.

ALTER TABLE public.ai_recipe_runs
  ADD COLUMN IF NOT EXISTS loaded_mcp_server_names        text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS mcp_warnings                   jsonb  NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS failure_details                jsonb,
  ADD COLUMN IF NOT EXISTS goose_runtime_overrides_snapshot jsonb;

-- mcp_warnings MUST be a JSON array. Defence-in-depth against code that
-- accidentally writes a scalar / object.
ALTER TABLE public.ai_recipe_runs
  DROP CONSTRAINT IF EXISTS ai_recipe_runs_mcp_warnings_array;
ALTER TABLE public.ai_recipe_runs
  ADD CONSTRAINT ai_recipe_runs_mcp_warnings_array
  CHECK (jsonb_typeof(mcp_warnings) = 'array');

COMMENT ON COLUMN public.ai_recipe_runs.loaded_mcp_server_names IS
  'MCP server names that the spawn actually loaded for this run. Intersection of recipe.extensions ∩ use_case.allowed_mcp_servers ∩ enabled servers.';
COMMENT ON COLUMN public.ai_recipe_runs.mcp_warnings IS
  'jsonb[] of { code, server, details } objects describing any MCP extension that was declared by the recipe but not loaded (not_allowed | not_registered | disabled | type_mismatch | http_auth_unsupported).';
COMMENT ON COLUMN public.ai_recipe_runs.failure_details IS
  'Canonical failure envelope { code, reason, server_name, stderr_excerpt }. Populated atomically with status=failed.';
COMMENT ON COLUMN public.ai_recipe_runs.goose_runtime_overrides_snapshot IS
  'Frozen snapshot of use_case.goose_runtime_overrides at run start. Audit-only.';
