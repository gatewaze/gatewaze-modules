-- spec-ai-mcp-extensions.md §Data Models §Memory backing store.
--
-- Replaces Goose's local-FS memory storage with a Gatewaze-owned
-- backing store. When 'memory' is allowlisted on a use case, the
-- wrapper substitutes Gatewaze's gatewaze-memory MCP server (which
-- advertises the same store_memory/retrieve_memory/list_memory tool
-- surface) for Goose's --with-builtin memory. Memory entries land
-- here; the Goose-local FS is never written to.
--
-- Scoping discriminator:
--   thread    → keyed by (use_case, thread_id, key)
--   use_case  → keyed by (use_case, key) — shared across all threads
--   user      → keyed by (use_case, user_id, key) — per-user notes
--
-- retrieve_memory(key) without an explicit scope falls through
-- thread → use_case → user in code.

CREATE TABLE IF NOT EXISTS public.ai_memory (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  use_case    text NOT NULL REFERENCES public.ai_use_cases(id) ON DELETE CASCADE,
  scope       text NOT NULL CHECK (scope IN ('thread', 'use_case', 'user')),
  thread_id   uuid REFERENCES public.ai_threads(id) ON DELETE CASCADE,
  user_id     uuid,

  key         text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  value       jsonb NOT NULL,

  expires_at  timestamptz,

  written_by_message_id uuid REFERENCES public.ai_messages(id) ON DELETE SET NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ai_memory_scope_shape CHECK (
    (scope = 'thread'   AND thread_id IS NOT NULL AND user_id IS NULL) OR
    (scope = 'use_case' AND thread_id IS NULL     AND user_id IS NULL) OR
    (scope = 'user'     AND thread_id IS NULL     AND user_id IS NOT NULL)
  )
);

-- Per-scope key uniqueness via partial indexes. store_memory(key=X)
-- upserts the existing row at the same scope rather than accumulating.
CREATE UNIQUE INDEX IF NOT EXISTS ai_memory_thread_key_uniq
  ON public.ai_memory(use_case, thread_id, key) WHERE scope = 'thread';

CREATE UNIQUE INDEX IF NOT EXISTS ai_memory_use_case_key_uniq
  ON public.ai_memory(use_case, key) WHERE scope = 'use_case';

CREATE UNIQUE INDEX IF NOT EXISTS ai_memory_user_key_uniq
  ON public.ai_memory(use_case, user_id, key) WHERE scope = 'user';

-- TTL sweeper index.
CREATE INDEX IF NOT EXISTS ai_memory_expires_at_idx
  ON public.ai_memory(expires_at) WHERE expires_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.touch_ai_memory_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_memory_touch_updated_at
  BEFORE UPDATE ON public.ai_memory
  FOR EACH ROW EXECUTE FUNCTION public.touch_ai_memory_updated_at();

ALTER TABLE public.ai_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_memory_select_authenticated ON public.ai_memory
  FOR SELECT TO authenticated USING (true);
CREATE POLICY ai_memory_service_role_all ON public.ai_memory
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ai_memory IS
  'Gatewaze-owned key/value store backing the substituted memory MCP server. Replaces Goose`s local-FS memory storage. spec-ai-mcp-extensions.md §Memory backing store.';
