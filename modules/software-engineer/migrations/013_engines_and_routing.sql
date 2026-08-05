-- Model routing + pluggable engines (Codex). Three layers of model selection, resolved per phase
-- by lib/model-select.ts with precedence: issue-label override > escalation > per-phase map >
-- project default:
--   * se_projects.phase_models    — {"<phase>": {"engine": "claude"|"codex", "model": "..."}}
--                                   partial map; unlisted phases use the project default.
--   * se_projects.escalation_model — when set, a run that trips a failure signal (2nd CI-fix
--                                   attempt, 2nd revise round) re-runs its remaining code phases on
--                                   this stronger model (se_runs.model_escalated latches it).
--   * se_runs.model_override /    — parsed once at intake from issue labels agent:model:<alias|id>
--     engine_override               and agent:engine:<claude|codex>; pin a run regardless of maps.
-- Codex runs need an OpenAI credential, sealed per-instance like the other project secrets.
alter table public.se_projects add column if not exists phase_models jsonb not null default '{}'::jsonb;
alter table public.se_projects add column if not exists escalation_model text;
alter table public.se_projects add column if not exists openai_cred_ciphertext text;
alter table public.se_projects add column if not exists openai_cred_last4 text;

alter table public.se_runs add column if not exists model_override text;
alter table public.se_runs add column if not exists engine_override text;
alter table public.se_runs add column if not exists model_escalated boolean not null default false;

-- Which harness actually ran the phase ('claude' = Claude Agent SDK, 'codex' = OpenAI Codex SDK);
-- also selects the price-book provider for cost_usd (anthropic vs openai).
alter table public.se_phases add column if not exists engine text;

comment on column public.se_projects.phase_models is
  'Partial per-phase routing map {"<phase>":{"engine":"claude"|"codex","model":"<id>"}}; unlisted phases fall back to the project default model on the claude engine.';
comment on column public.se_projects.escalation_model is
  'Escalation-ladder target: when a run trips a failure signal its remaining code phases re-run on this model (claude engine). Null disables the ladder.';
comment on column public.se_runs.model_escalated is
  'Latched by the escalation ladder (2nd CI-fix attempt / 2nd revise round): remaining code phases resolve to escalation_model.';
