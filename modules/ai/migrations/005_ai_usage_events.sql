-- ============================================================================
-- Module: ai
-- Migration: 005_ai_usage_events
-- Description: Append-only cost ledger. One row per LLM call, tool call,
--              embedding batch, or image generation. Materialised view
--              ai_usage_daily refreshes nightly for the dashboard.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_usage_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at       timestamptz NOT NULL DEFAULT now(),

  user_id           uuid REFERENCES auth.users(id) ON DELETE SET NULL,  -- null = system user (cron)
  use_case          text NOT NULL REFERENCES public.ai_use_cases(id) ON DELETE RESTRICT,
  thread_id         uuid REFERENCES public.ai_threads(id) ON DELETE SET NULL,
  message_id        uuid REFERENCES public.ai_messages(id) ON DELETE SET NULL,

  kind              text NOT NULL CHECK (kind IN ('llm','tool','embedding','image')),
  provider          text NOT NULL,                       -- 'anthropic','openai','gemini','scrapling'
  model             text NOT NULL,                       -- model id or tool name

  input_tokens      integer NOT NULL DEFAULT 0,
  output_tokens     integer NOT NULL DEFAULT 0,
  cached_tokens     integer NOT NULL DEFAULT 0,
  image_outputs     integer NOT NULL DEFAULT 0,
  bytes_in          bigint  NOT NULL DEFAULT 0,
  bytes_out         bigint  NOT NULL DEFAULT 0,
  browser_seconds   numeric NOT NULL DEFAULT 0,          -- scrapling browser-mode

  cost_micro_usd    bigint  NOT NULL DEFAULT 0,
  latency_ms        integer NOT NULL DEFAULT 0,

  status            text NOT NULL CHECK (status IN ('ok','error','rate_limited','timeout','budget_blocked','cancelled')),
  error             text,
  request_id        text                                  -- provider-side request id
);

COMMENT ON TABLE public.ai_usage_events IS
  'Append-only cost ledger. One row per LLM/embedding/image/tool call. user_id=NULL for cron-driven system runs. cost_micro_usd computed at write time using ai_model_prices effective at occurred_at.';

CREATE INDEX IF NOT EXISTS ai_usage_events_user_date_idx
  ON public.ai_usage_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_events_use_case_date_idx
  ON public.ai_usage_events (use_case, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_events_thread_idx
  ON public.ai_usage_events (thread_id);
CREATE INDEX IF NOT EXISTS ai_usage_events_provider_model_idx
  ON public.ai_usage_events (provider, model, occurred_at DESC);

ALTER TABLE public.ai_usage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_usage_events_select_admin" ON public.ai_usage_events;
CREATE POLICY "ai_usage_events_select_admin"
  ON public.ai_usage_events FOR SELECT TO authenticated
  USING (public.is_admin());

-- Inserts always via service-role key (the platform's standard pattern);
-- no INSERT policy for authenticated users.

-- Add the deferred FK from ai_messages.usage_event_id now that the
-- referenced table exists.
ALTER TABLE public.ai_messages
  ADD CONSTRAINT ai_messages_usage_event_id_fkey
  FOREIGN KEY (usage_event_id) REFERENCES public.ai_usage_events(id) ON DELETE SET NULL;
