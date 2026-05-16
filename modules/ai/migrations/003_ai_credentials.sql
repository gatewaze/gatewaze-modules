-- ============================================================================
-- Module: ai
-- Migration: 003_ai_credentials
-- Description: Per-user + per-use-case API-key credentials. The provider
--              router consults these in order: user → use_case → env var.
--              Cleartext is NEVER returned via SELECT (RLS + API enforce).
--
--              Encryption uses pgsodium symmetric — matches the existing
--              sites_secrets pattern.
-- ============================================================================

-- pgsodium is set up at the platform level; if it isn't installed, the
-- module install will fail loudly (intended — credentials cannot be
-- stored unencrypted).
CREATE EXTENSION IF NOT EXISTS pgsodium;

-- ── User credentials ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_user_credentials (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider                 text NOT NULL CHECK (provider IN ('openai','anthropic','gemini')),

  api_key_ciphertext       bytea NOT NULL,             -- encrypted via pgsodium
  api_key_nonce            bytea NOT NULL,             -- per-row nonce
  last_4                   text  NOT NULL,             -- last 4 chars for ops disambiguation; safe to expose

  status                   text  NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','disabled','rotating')),
  status_reason            text,                        -- 'provider_401', 'manual_disable', ...
  last_used_at             timestamptz,
  failure_count            integer NOT NULL DEFAULT 0,  -- bumped on 401 from provider; reset on success

  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  rotated_at               timestamptz,

  CONSTRAINT ai_user_credentials_user_provider_unique
    UNIQUE (user_id, provider)                          -- one active key per (user, provider)
);

COMMENT ON TABLE public.ai_user_credentials IS
  'Per-user API-key overrides. Provider router consults this first; falls back to ai_use_case_credentials, then env vars. Cleartext NEVER exposed by SELECT or API responses.';

CREATE INDEX IF NOT EXISTS ai_user_credentials_user_provider_active_idx
  ON public.ai_user_credentials (user_id, provider) WHERE status = 'active';

ALTER TABLE public.ai_user_credentials ENABLE ROW LEVEL SECURITY;

-- Users see ONLY their own credential metadata (never ciphertext or
-- nonce — handled at API layer via column projection).
DROP POLICY IF EXISTS "ai_user_credentials_select_owner" ON public.ai_user_credentials;
CREATE POLICY "ai_user_credentials_select_owner"
  ON public.ai_user_credentials FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "ai_user_credentials_admin_write" ON public.ai_user_credentials;
CREATE POLICY "ai_user_credentials_admin_write"
  ON public.ai_user_credentials FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ── Use-case credentials ────────────────────────────────────────────────────
-- Pinned (use_case, provider) → key. Primarily for cron-driven use-cases
-- where personal user keys are deliberately skipped.
CREATE TABLE IF NOT EXISTS public.ai_use_case_credentials (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  use_case                 text NOT NULL REFERENCES public.ai_use_cases(id) ON DELETE CASCADE,
  provider                 text NOT NULL CHECK (provider IN ('openai','anthropic','gemini')),

  api_key_ciphertext       bytea NOT NULL,
  api_key_nonce            bytea NOT NULL,
  last_4                   text  NOT NULL,

  status                   text  NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','disabled','rotating')),
  status_reason            text,
  last_used_at             timestamptz,
  failure_count            integer NOT NULL DEFAULT 0,

  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  rotated_at               timestamptz,

  CONSTRAINT ai_use_case_credentials_use_case_provider_unique
    UNIQUE (use_case, provider)
);

COMMENT ON TABLE public.ai_use_case_credentials IS
  'Per-use-case pinned API keys. Used for cron-driven use-cases (e.g. daily-briefing-research) that deliberately bypass user-level overrides.';

CREATE INDEX IF NOT EXISTS ai_use_case_credentials_use_case_provider_active_idx
  ON public.ai_use_case_credentials (use_case, provider) WHERE status = 'active';

ALTER TABLE public.ai_use_case_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_use_case_credentials_admin_only" ON public.ai_use_case_credentials;
CREATE POLICY "ai_use_case_credentials_admin_only"
  ON public.ai_use_case_credentials FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
