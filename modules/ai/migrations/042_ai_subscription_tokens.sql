-- ai module — 042: subscription-token credentials, call caps, usage kind.
-- Spec: gatewaze-roadmap/specs/spec-ai-subscription-tokens.md.

alter table public.ai_use_case_credentials
  add column if not exists kind text not null default 'api_key'
  check (kind in ('api_key','claude_subscription'));

alter table public.ai_user_credentials
  add column if not exists kind text not null default 'api_key'
  check (kind in ('api_key','claude_subscription'));

alter table public.ai_use_cases
  add column if not exists daily_call_cap int null
  check (daily_call_cap is null or daily_call_cap > 0);

alter table public.ai_usage_events
  add column if not exists credential_kind text null;

-- Supports the pre-flight daily_call_cap count and the existing cost gate.
create index if not exists ai_usage_events_use_case_time_idx
  on public.ai_usage_events (use_case, occurred_at);
