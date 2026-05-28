-- =============================================================================
-- 001_canvas_ai_audit_log — audit + quota table for editor-ai-copilot.
--
-- Spec: gatewaze-environments/specs/spec-canvas-ai-copilot.md §5.1
--
-- One row per AI generation attempt — success, validation failure,
-- provider error, timeout, rate-limit. The 24-h-per-user budget
-- (§4.3) is enforced by counting rows in this table over the window.
--
-- Reads gated to super_admins (RLS); writes via service-role only.
-- Service-role bypasses RLS, so the API can write freely while UI
-- consumers go through an admin route that proxies via service-role.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.canvas_ai_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Polymorphic owner of the target (sites / newsletters / future).
  host_kind       text NOT NULL CHECK (host_kind IN ('site','newsletter')),
  host_id         uuid NOT NULL,
  -- The page or edition the AI was generating into.
  target_id      uuid NOT NULL,
  -- For mode='edit-block', the block being edited. NULL otherwise.
  block_id        uuid,
  user_id         uuid NOT NULL,
  prompt          text NOT NULL,
  mode            text NOT NULL CHECK (mode IN ('replace','append','insert-after','edit','edit-block')),
  provider        text NOT NULL CHECK (provider IN ('anthropic','openai')),
  model           text NOT NULL,
  input_tokens    int NOT NULL DEFAULT 0,
  output_tokens   int NOT NULL DEFAULT 0,
  duration_ms     int NOT NULL DEFAULT 0,
  status          text NOT NULL CHECK (status IN (
                    'ok','invalid_output','provider_error','timeout',
                    'rate_limited','validation_dropped_all','no_blocks',
                    'block_not_found'
                  )),
  blocks_returned int NOT NULL DEFAULT 0,
  blocks_dropped  int NOT NULL DEFAULT 0,
  -- doc_ids referenced in the request (Phase F). Empty array when
  -- the user didn't attach any source documents.
  doc_ids         uuid[] NOT NULL DEFAULT '{}',
  warnings        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS canvas_ai_audit_log_user_window_idx
  ON public.canvas_ai_audit_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS canvas_ai_audit_log_host_window_idx
  ON public.canvas_ai_audit_log (host_kind, host_id, created_at DESC);

CREATE INDEX IF NOT EXISTS canvas_ai_audit_log_target_idx
  ON public.canvas_ai_audit_log (target_id, created_at DESC);

ALTER TABLE public.canvas_ai_audit_log ENABLE ROW LEVEL SECURITY;

-- Drop existing policies before recreating — idempotency.
DROP POLICY IF EXISTS ai_audit_read_admin ON public.canvas_ai_audit_log;
DROP POLICY IF EXISTS ai_audit_write_service ON public.canvas_ai_audit_log;

-- Read: super_admins only. auth.uid() returns NULL under service-role
-- so service-role callers bypass RLS entirely (their canonical access
-- path). UI consumers MUST hit an admin route that proxies via
-- service-role + does its own super-admin check.
CREATE POLICY ai_audit_read_admin ON public.canvas_ai_audit_log
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- Write: service_role only.
CREATE POLICY ai_audit_write_service ON public.canvas_ai_audit_log
  FOR INSERT TO service_role
  WITH CHECK (true);

COMMENT ON TABLE public.canvas_ai_audit_log IS
  'AI-generation audit log + per-user-per-day quota source for editor-ai-copilot. Per spec-canvas-ai-copilot.md §5.1.';

COMMENT ON COLUMN public.canvas_ai_audit_log.doc_ids IS
  'Source-document refs (Phase F). Joins to public.canvas_ai_documents.';
