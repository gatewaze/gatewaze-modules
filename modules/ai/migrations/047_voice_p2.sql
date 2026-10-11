-- ai — 047: voice transcription P2/P3 (spec-ai-voice-transcription.md §5).
--
-- Per-use-case duration cap (P3): null = the platform default of 180 s.
ALTER TABLE public.ai_use_cases
  ADD COLUMN IF NOT EXISTS max_media_seconds integer NULL
    CHECK (max_media_seconds IS NULL OR (max_media_seconds BETWEEN 5 AND 600));

-- The admin chat widget's dictation use case (P2). Admin audience: a member
-- JWT is refused at the route. Self-hosted default, no hosted fallback.
INSERT INTO public.ai_use_cases
  (id, label, description, default_provider, default_model, allowed_models,
   modality, audience, max_output_tokens, daily_call_cap)
VALUES
  ('admin-chat-dictation',
   'Admin chat dictation',
   'Voice-note transcription for the AI admin chat widget composer.',
   'openai',
   'whisper-local-small',
   ARRAY['whisper-local-small', 'whisper-local-large-v3-turbo', 'gpt-4o-mini-transcribe', 'whisper-1'],
   'transcription',
   'admin',
   0,
   300)
ON CONFLICT (id) DO UPDATE SET
  modality = EXCLUDED.modality,
  audience = EXCLUDED.audience,
  allowed_models = EXCLUDED.allowed_models;
