-- =============================================================================
-- 002_canvas_ai_documents — short-TTL parsed source documents (Phase F).
--
-- Spec: gatewaze-environments/specs/spec-canvas-ai-copilot.md §5.2
--
-- One row per uploaded file or fetched URL. Stores ONLY the parsed
-- text (capped at request time); the raw file is never persisted to
-- avoid the compliance regime that comes with a document store.
--
-- TTL is 1 hour from upload. A 15-minute cron sweep deletes expired
-- rows (backstop only — the primary protection is an
-- expires_at > now() filter at generate-time).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.canvas_ai_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,
  -- Polymorphic owner — matches canvas_ai_audit_log shape.
  host_kind       text NOT NULL CHECK (host_kind IN ('site','newsletter')),
  host_id         uuid NOT NULL,
  target_id       uuid NOT NULL,
  source          text NOT NULL CHECK (source IN ('upload','url')),
  filename        text NOT NULL,
  source_url      text,                 -- NULL for uploads
  mime_type       text NOT NULL,
  -- Parsed plain text. Capped by SITES_CANVAS_AI_MAX_DOC_CHARS
  -- (default 200000) before INSERT. The LLM-side budget (50k tokens
  -- across all referenced docs) is enforced at request time.
  extracted_text  text NOT NULL,
  extracted_chars int NOT NULL,
  byte_size       int NOT NULL,
  warnings        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '1 hour')
);

CREATE INDEX IF NOT EXISTS canvas_ai_documents_user_target_idx
  ON public.canvas_ai_documents (user_id, host_kind, host_id, target_id);

CREATE INDEX IF NOT EXISTS canvas_ai_documents_expires_idx
  ON public.canvas_ai_documents (expires_at);

ALTER TABLE public.canvas_ai_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_documents_read_owner ON public.canvas_ai_documents;
DROP POLICY IF EXISTS ai_documents_write_service ON public.canvas_ai_documents;

-- Read: only the uploading user (under JWT). Service-role bypass
-- applies for the API path — same caveat as canvas_ai_audit_log.
CREATE POLICY ai_documents_read_owner ON public.canvas_ai_documents
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Write: service_role only (the API is the only writer).
CREATE POLICY ai_documents_write_service ON public.canvas_ai_documents
  FOR INSERT TO service_role
  WITH CHECK (true);

COMMENT ON TABLE public.canvas_ai_documents IS
  'Short-TTL parsed source documents for editor-ai-copilot (Phase F). 1-hour TTL; raw files never persisted. Per spec-canvas-ai-copilot.md §5.2.';
