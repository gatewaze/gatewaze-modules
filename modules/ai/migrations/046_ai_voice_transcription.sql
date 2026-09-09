-- ai — 046: voice transcription (spec-ai-voice-transcription.md).
--
-- Use cases gain a modality so the transcription endpoint can refuse chat
-- use cases (no smuggling audio spend), an audience so a member JWT can't
-- burn an admin use case's budget, and an opt-in hosted fallback model for
-- when the local Whisper container is down (null = never leave our infra —
-- the default, and the right default for health audio).
ALTER TABLE public.ai_use_cases
  ADD COLUMN IF NOT EXISTS modality text NOT NULL DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS fallback_model text NULL;

ALTER TABLE public.ai_use_cases
  DROP CONSTRAINT IF EXISTS ai_use_cases_modality_check;
ALTER TABLE public.ai_use_cases
  ADD CONSTRAINT ai_use_cases_modality_check
  CHECK (modality IN ('chat', 'embedding', 'image', 'transcription'));

ALTER TABLE public.ai_use_cases
  DROP CONSTRAINT IF EXISTS ai_use_cases_audience_check;
ALTER TABLE public.ai_use_cases
  ADD CONSTRAINT ai_use_cases_audience_check
  CHECK (audience IN ('member', 'admin'));

-- Transcribed seconds, for cost recompute and per-use-case volume reporting.
-- fallback attribution needs no extra column: provider/model already record
-- what actually served the request.
ALTER TABLE public.ai_usage_events
  ADD COLUMN IF NOT EXISTS media_seconds numeric(8,2) NULL;

-- Ledger rows for transcription calls. NOT VALID + VALIDATE so re-adding
-- the check never takes a long lock on the ledger (largest table we own).
ALTER TABLE public.ai_usage_events
  DROP CONSTRAINT IF EXISTS ai_usage_events_kind_check;
ALTER TABLE public.ai_usage_events
  ADD CONSTRAINT ai_usage_events_kind_check
  CHECK (kind IN ('llm', 'tool', 'embedding', 'image', 'mcp_tool', 'transcription')) NOT VALID;
ALTER TABLE public.ai_usage_events
  VALIDATE CONSTRAINT ai_usage_events_kind_check;
