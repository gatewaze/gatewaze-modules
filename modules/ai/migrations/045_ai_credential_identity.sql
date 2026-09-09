-- ai module — 045: named credentials + per-credential cost attribution.
-- Spec: spec-ai-subscription-tokens.md §8 (cost unification addendum).

alter table public.ai_use_case_credentials
  add column if not exists label text null check (label is null or char_length(label) <= 80);
alter table public.ai_user_credentials
  add column if not exists label text null check (label is null or char_length(label) <= 80);

alter table public.ai_usage_events
  add column if not exists credential_id uuid null,
  add column if not exists credential_last4 text null;
