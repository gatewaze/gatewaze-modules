-- spec-ai-mcp-extensions.md §Data Models — per-use-case MCP server allowlist.
--
-- Join table rather than `text[] allowed_mcp_servers` on the use-case
-- row because it gives us:
--   - hard FK integrity (can't reference a non-existent server)
--   - explicit DELETE RESTRICT (server can't be deleted while in use)
--   - clean per-use-case audit trail (created_at / created_by)
--
-- The admin API surface accepts server NAMES (operator-friendly);
-- storage joins by ID.

CREATE TABLE IF NOT EXISTS public.ai_use_case_mcp_allowlist (
  use_case_id   text NOT NULL REFERENCES public.ai_use_cases(id) ON DELETE CASCADE,
  mcp_server_id uuid NOT NULL REFERENCES public.ai_mcp_servers(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  PRIMARY KEY (use_case_id, mcp_server_id)
);

CREATE INDEX IF NOT EXISTS ai_use_case_mcp_allowlist_use_case_idx
  ON public.ai_use_case_mcp_allowlist(use_case_id);

CREATE INDEX IF NOT EXISTS ai_use_case_mcp_allowlist_server_idx
  ON public.ai_use_case_mcp_allowlist(mcp_server_id);

ALTER TABLE public.ai_use_case_mcp_allowlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_use_case_mcp_allowlist_select_authenticated
  ON public.ai_use_case_mcp_allowlist FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY ai_use_case_mcp_allowlist_service_role_all
  ON public.ai_use_case_mcp_allowlist FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ai_use_case_mcp_allowlist IS
  'Per-use-case allowlist of MCP servers. Recipe-bound use cases additionally intersect against the recipe`s declared extensions; chat use cases use this allowlist directly. spec-ai-mcp-extensions.md.';
