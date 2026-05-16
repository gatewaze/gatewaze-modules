-- ============================================================================
-- Module: ai
-- Migration: 002_ai_threads_messages
-- Description: Persistent chat thread + append-only message tables.
--              `(use_case, host_kind, host_id, thread_key)` is the natural
--              addressable key — any host module can mint or look up its
--              own threads without colliding.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  use_case        text NOT NULL REFERENCES public.ai_use_cases(id) ON DELETE RESTRICT,
  host_kind       text NOT NULL,                 -- 'site' | 'daily_briefing_day' | 'portal_session' | ...
  host_id         text NOT NULL,                 -- opaque string from caller; usually a uuid but not enforced
  thread_key      text NOT NULL DEFAULT '',      -- groups messages within a host (e.g. page_id under a site)

  status          text NOT NULL DEFAULT 'idle'
                  CHECK (status IN ('idle','running','ready','failed','cancelled')),
  last_error      text,
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  cost_micro_usd  bigint  NOT NULL DEFAULT 0,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  CONSTRAINT ai_threads_addressable_unique
    UNIQUE (use_case, host_kind, host_id, thread_key)
);

COMMENT ON TABLE public.ai_threads IS
  'Chat threads. Keyed by (use_case, host_kind, host_id, thread_key); one row per logical conversation. Host modules embed their own scope via host_kind+host_id without coupling to this table.';

CREATE INDEX IF NOT EXISTS ai_threads_host_idx
  ON public.ai_threads (host_kind, host_id);
CREATE INDEX IF NOT EXISTS ai_threads_use_case_status_idx
  ON public.ai_threads (use_case, status);
CREATE INDEX IF NOT EXISTS ai_threads_running_idx
  ON public.ai_threads (created_at) WHERE status = 'running';

DROP TRIGGER IF EXISTS ai_threads_updated_at ON public.ai_threads;
CREATE TRIGGER ai_threads_updated_at
  BEFORE UPDATE ON public.ai_threads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.ai_threads ENABLE ROW LEVEL SECURITY;

-- Operators (admin) see everything; regular authenticated users see only
-- threads they created. Non-admins can't see another user's chats.
DROP POLICY IF EXISTS "ai_threads_select_owner_or_admin" ON public.ai_threads;
CREATE POLICY "ai_threads_select_owner_or_admin"
  ON public.ai_threads FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "ai_threads_admin_write" ON public.ai_threads;
CREATE POLICY "ai_threads_admin_write"
  ON public.ai_threads FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ── Messages ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id       uuid NOT NULL REFERENCES public.ai_threads(id) ON DELETE CASCADE,

  role            text NOT NULL CHECK (role IN ('system','user','assistant','tool_summary')),
  status          text NOT NULL DEFAULT 'complete'
                  CHECK (status IN ('pending','running','complete','failed','cancelled')),

  content         text NOT NULL DEFAULT '',
  -- Structured output produced by the assistant's structured-output tool
  -- (e.g. `submit_candidates`). NULL for plain narrative turns.
  structured      jsonb,

  provider        text,                          -- 'anthropic' | 'openai' | 'gemini' | null for user turns
  model           text,                          -- resolved model id; null for user turns
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  cost_micro_usd  bigint  NOT NULL DEFAULT 0,
  latency_ms      integer NOT NULL DEFAULT 0,

  error_code      text,                          -- 'provider_error','rate_limited',... (see runner.ts)
  error_message   text,

  -- Cross-reference to the cost ledger entry for this turn.
  usage_event_id  uuid,                          -- FK declared in 005 once ai_usage_events exists

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.ai_messages IS
  'Append-only conversation turns. status drives the async lifecycle; structured carries the JSON sidecar for structured-output turns; usage_event_id back-links to the cost ledger.';

CREATE INDEX IF NOT EXISTS ai_messages_thread_created_idx
  ON public.ai_messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS ai_messages_status_idx
  ON public.ai_messages (status) WHERE status IN ('pending','running');

ALTER TABLE public.ai_messages ENABLE ROW LEVEL SECURITY;

-- Mirrors ai_threads policy: authenticated owner can see their own
-- thread's messages; admin sees all.
DROP POLICY IF EXISTS "ai_messages_select_owner_or_admin" ON public.ai_messages;
CREATE POLICY "ai_messages_select_owner_or_admin"
  ON public.ai_messages FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.ai_threads t
      WHERE t.id = ai_messages.thread_id AND t.created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS "ai_messages_admin_write" ON public.ai_messages;
CREATE POLICY "ai_messages_admin_write"
  ON public.ai_messages FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
