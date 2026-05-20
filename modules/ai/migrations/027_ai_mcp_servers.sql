-- spec-ai-mcp-extensions.md §Data Models — operator-managed MCP server registry.
--
-- One row per registered MCP server. The `type` column discriminates
-- between stdio (cmd + args via execve), streamable_http (uri +
-- optional bearer token), and builtin (Goose-bundled extensions like
-- `memory`, `developer`).
--
-- Secrets (`envs_ciphertext`, `bearer_token_ciphertext`) reuse the
-- same AES-256-GCM envelope as ai_agent_sources.auth_token_ciphertext
-- and ai_credentials — `v1:<base64(nonce||ciphertext||tag)>` written
-- via lib/secrets/* helpers. Plaintext never lands in the DB.

CREATE TABLE IF NOT EXISTS public.ai_mcp_servers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  name            text NOT NULL CHECK (name ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  display_name    text NOT NULL,
  description     text,

  type            text NOT NULL CHECK (type IN ('stdio', 'streamable_http', 'builtin')),
  enabled         boolean NOT NULL DEFAULT true,

  -- stdio fields
  cmd             text,
  args            jsonb,
  env_keys        jsonb NOT NULL DEFAULT '[]'::jsonb,
  envs_ciphertext text,

  -- streamable_http fields
  uri             text,
  bearer_token_ciphertext text,
  headers         jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- builtin fields
  builtin_name    text,

  timeout_seconds integer NOT NULL DEFAULT 300 CHECK (timeout_seconds > 0 AND timeout_seconds <= 3600),

  -- Last test-probe results.
  last_tested_at      timestamptz,
  last_tested_status  text CHECK (last_tested_status IN ('ok', 'error') OR last_tested_status IS NULL),
  last_tested_error   text,
  last_tested_tools   jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,

  -- Per-type required-column shape. Non-applicable columns MUST be
  -- NULL so a row never sits in a mixed/ambiguous state.
  CONSTRAINT ai_mcp_servers_type_fields_check CHECK (
    CASE type
      WHEN 'stdio' THEN
        cmd IS NOT NULL AND args IS NOT NULL
        AND uri IS NULL AND bearer_token_ciphertext IS NULL
        AND builtin_name IS NULL
      WHEN 'streamable_http' THEN
        uri IS NOT NULL
        AND cmd IS NULL AND args IS NULL AND envs_ciphertext IS NULL
        AND builtin_name IS NULL
      WHEN 'builtin' THEN
        builtin_name IS NOT NULL
        AND cmd IS NULL AND args IS NULL AND envs_ciphertext IS NULL
        AND uri IS NULL AND bearer_token_ciphertext IS NULL
    END
  ),

  -- args jsonb must be an array of strings when present.
  CONSTRAINT ai_mcp_servers_args_string_array CHECK (
    args IS NULL OR (
      jsonb_typeof(args) = 'array'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(args) e WHERE jsonb_typeof(e) <> 'string'
      )
    )
  ),

  -- env_keys must be array of uppercase identifier strings.
  CONSTRAINT ai_mcp_servers_env_keys_string_array CHECK (
    jsonb_typeof(env_keys) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(env_keys) e WHERE e !~ '^[A-Z][A-Z0-9_]*$'
    )
  ),

  -- headers must be a JSON object (not array, not scalar).
  CONSTRAINT ai_mcp_servers_headers_object CHECK (jsonb_typeof(headers) = 'object'),

  -- streamable_http URIs MUST be https.
  CONSTRAINT ai_mcp_servers_uri_https CHECK (uri IS NULL OR uri ~ '^https://')
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_mcp_servers_name_key
  ON public.ai_mcp_servers(name);

CREATE INDEX IF NOT EXISTS ai_mcp_servers_type_enabled_idx
  ON public.ai_mcp_servers(type, enabled) WHERE enabled = true;

-- updated_at autobump on UPDATE.
CREATE OR REPLACE FUNCTION public.touch_ai_mcp_servers_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_mcp_servers_touch_updated_at
  BEFORE UPDATE ON public.ai_mcp_servers
  FOR EACH ROW EXECUTE FUNCTION public.touch_ai_mcp_servers_updated_at();

ALTER TABLE public.ai_mcp_servers ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_mcp_servers_select_authenticated
  ON public.ai_mcp_servers FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY ai_mcp_servers_service_role_all
  ON public.ai_mcp_servers FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ai_mcp_servers IS
  'Operator-managed registry of MCP servers consumable by Goose-driven AI workloads. spec-ai-mcp-extensions.md.';
