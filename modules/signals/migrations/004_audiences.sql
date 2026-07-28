-- ============================================================================
-- Module: signals
-- Migration: 004_audiences
-- Spec: spec-plays-audience-intelligence.md §4.7 (audience_rule DSL + list_build)
-- Description: Resolved-audience snapshots + the topic-affinity resolution RPC.
--   signals_audiences         — one resolved audience (header: rule + counts).
--   signals_audience_members  — its resolved person set (a stable snapshot).
--   people_by_topics()        — people with affinity to any of a topic set, above
--                               a threshold, optionally restricted to first-party
--                               evidence (source_allow). Reads person_topic_interests
--                               (source-weighted + decayed), so it is governed +
--                               source-agnostic. This is the core clause the
--                               audience resolver (build-audience worker) composes
--                               with geo/region/exclusions.
--   Idempotent.
-- ============================================================================

create table if not exists public.signals_audiences (
  id             uuid primary key default gen_random_uuid(),
  site_id        uuid,
  name           text,
  context_type   text,
  context_id     uuid,
  rule           jsonb not null default '{}'::jsonb,
  resolved_count integer not null default 0,
  lawful_excluded integer not null default 0,
  suppressed_excluded integer not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists signals_audiences_context_idx on public.signals_audiences (context_type, context_id);

create table if not exists public.signals_audience_members (
  audience_id uuid not null references public.signals_audiences(id) on delete cascade,
  person_id   uuid not null references public.people(id) on delete cascade,
  matched     jsonb,
  primary key (audience_id, person_id)
);

-- People with affinity to ANY of the given topics at/above a threshold. When
-- p_first_party_only is true, only people with first-party/self-declared evidence
-- for that topic qualify (compliance-sensitive sends). Returns the max affinity
-- per person across the matched topics.
create or replace function public.people_by_topics(
  p_topics text[],
  p_min_affinity real default 0.5,
  p_first_party_only boolean default false
)
returns table(person_id uuid, affinity real, matched_topics text[])
language sql stable security definer as $$
  select pti.person_id,
         max(pti.weight)::real as affinity,
         array_agg(distinct pti.topic) as matched_topics
  from public.person_topic_interests pti
  where pti.topic = any(p_topics)
    and pti.weight >= p_min_affinity
    and (not p_first_party_only or pti.has_first_party)
  group by pti.person_id
$$;
grant execute on function public.people_by_topics(text[], real, boolean) to authenticated, anon;

-- People registered for an event (used by the exclude:registered_for_context clause).
create or replace function public.people_registered_for_event(p_event_id uuid)
returns table(person_id uuid)
language sql stable security definer as $$
  select distinct r.person_id
  from public.events_registrations r
  where r.event_id = p_event_id and r.person_id is not null
    and coalesce(r.status,'') not in ('cancelled')
$$;
grant execute on function public.people_registered_for_event(uuid) to authenticated, anon;

-- RLS
do $$
declare t text;
begin
  foreach t in array array['signals_audiences','signals_audience_members'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s_sel" on public.%I', t, t);
    execute format('create policy "%s_sel" on public.%I for select to authenticated using (true)', t, t);
    execute format('drop policy if exists "%s_all" on public.%I', t, t);
    execute format('create policy "%s_all" on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t, t);
  end loop;
end $$;
