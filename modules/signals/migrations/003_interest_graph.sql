-- ============================================================================
-- Module: signals
-- Migration: 003_interest_graph
-- Spec: spec-plays-audience-intelligence.md §4/§5
-- Description: Turn signals_interests into the source-tagged, weighted, governed
--   person↔topic HUB the plays audience/personalization layer reads. Additive:
--   - signals_interests gains evidence/lawful_basis/observed_at/updated_at.
--   - signals_interest_sources: runtime-tunable per-source weight + enabled +
--     lawful-basis flag (the knowledge-source registry's config side).
--   - topic_vocabulary + normalize_topic(): a light canonical vocabulary.
--   - url_content_map: resolve a page_view URL → content (for first-party joins).
--   - person_topic_interests VIEW extended: source-weighted + recency-decayed,
--     keeping (person_id,topic,weight) for the existing engine + adding
--     top_source/has_first_party.
--   - person_topics(person_id): the source-agnostic read primitive.
--   Idempotent.
-- ============================================================================

-- ── 1. signals_interests additions ──────────────────────────────────────────
alter table public.signals_interests add column if not exists evidence jsonb;
alter table public.signals_interests add column if not exists lawful_basis text;
alter table public.signals_interests add column if not exists observed_at timestamptz;
alter table public.signals_interests add column if not exists updated_at timestamptz not null default now();
-- internal-only columns: never exposed to anon/authenticated (governance §7).
-- Best-effort: the column-level revoke requires table ownership; if the running
-- role does not own the table (e.g. a manual psql apply as `postgres`), skip it —
-- the person_topic_interests view (the read surface) never exposes these columns
-- regardless, so this is defense-in-depth, not the primary control.
do $$
begin
  execute 'revoke select (evidence, lawful_basis) on public.signals_interests from anon, authenticated';
exception when insufficient_privilege or others then
  raise notice 'skipped column-level revoke on signals_interests (not owner): %', sqlerrm;
end $$;

-- ── 2. knowledge-source registry config (weights + toggles) ─────────────────
create table if not exists public.signals_interest_sources (
  source                text primary key check (source ~ '^[a-z][a-z0-9_-]{0,40}$'),
  label                 text,
  weight                numeric(6,4) not null default 1.0 check (weight >= 0),
  enabled               boolean not null default true,
  requires_lawful_basis boolean not null default false,
  kind                  text not null default 'first_party' check (kind in ('first_party','self_declared','third_party')),
  updated_at            timestamptz not null default now()
);
insert into public.signals_interest_sources (source, label, weight, enabled, requires_lawful_basis, kind) values
  ('first_party_activity', 'First-party activity', 1.0, true,  false, 'first_party'),
  ('self_declared',        'Self-declared',        0.9, true,  false, 'self_declared'),
  ('explicit',             'Explicit (legacy)',    1.0, true,  false, 'self_declared'),
  ('event_registration',   'Event registration',   1.0, true,  false, 'first_party'),
  ('enrichment',           'LinkedIn enrichment',  0.4, false, true,  'third_party'),
  ('lf_events',            'LF Events attendance', 0.5, false, true,  'third_party')
on conflict (source) do nothing;

-- ── 3. canonical topic vocabulary + normalize_topic ─────────────────────────
create table if not exists public.topic_vocabulary (
  slug             text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{0,60}$'),
  label            text not null,
  aliases          text[] not null default '{}',
  parent_slug      text references public.topic_vocabulary(slug),
  status           text not null default 'active' check (status in ('active','deprecated')),
  replacement_slug text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create or replace function public.normalize_topic(raw text)
returns table(slug text, is_mapped boolean)
language plpgsql stable as $$
declare hit record; s text;
begin
  if raw is null or btrim(raw) = '' then return query select ''::text, false; return; end if;
  -- exact canonical
  select tv.slug into hit from public.topic_vocabulary tv where tv.slug = lower(btrim(raw)) and tv.status = 'active' limit 1;
  if found then return query select hit.slug, true; return; end if;
  -- alias match
  select tv.slug into hit from public.topic_vocabulary tv
    where tv.status = 'active' and lower(btrim(raw)) = any(select lower(a) from unnest(tv.aliases) a) limit 1;
  if found then return query select hit.slug, true; return; end if;
  -- deprecated → replacement
  select coalesce(tv.replacement_slug, tv.slug) as slug into hit from public.topic_vocabulary tv
    where tv.slug = lower(btrim(raw)) and tv.status = 'deprecated' limit 1;
  if found then return query select hit.slug, true; return; end if;
  -- slugify fallback (unmapped; never null so nothing is lost)
  s := regexp_replace(lower(btrim(raw)), '[^a-z0-9]+', '-', 'g');
  s := regexp_replace(s, '(^-+|-+$)', '', 'g');
  s := left(s, 61);
  return query select coalesce(nullif(s, ''), 'topic'), false;
end $$;

-- ── 4. URL → content resolver (for first-party activity → topics) ────────────
create table if not exists public.url_content_map (
  path         text primary key,
  content_type text not null check (content_type in ('sr_item','video','event','blog_post','podcast')),
  content_id   uuid not null,
  updated_at   timestamptz not null default now()
);

-- ── 5. extended person_topic_interests view (source-weighted + decayed) ──────
-- Keeps (person_id, topic, weight) so the existing engine (audienceCandidates /
-- contentCandidates) is unaffected; adds top_source + has_first_party. weight is
-- now source.weight × signal.weight × recency_decay(observed_at) (half-life 180d),
-- and DISABLED sources are excluded (source-agnostic, governed read).
create or replace view public.person_topic_interests as
with base as (
  select r.person_id, t.topic,
         (case when r.checked_in then 1.5 else 1.0 end)::real as raw_weight,
         'event_registration'::text as source,
         coalesce(r.registered_at, now()) as observed_at
  from public.events_registrations r
  join public.events e on e.id = r.event_id
  cross join lateral unnest(coalesce(e.event_topics, '{}')) as t(topic)
  where r.person_id is not null and coalesce(r.status, '') not in ('cancelled')
    and t.topic ~ '^[a-z0-9][a-z0-9-]{0,60}$'
  union all
  select si.person_id, si.topic, si.weight as raw_weight, si.source,
         coalesce(si.observed_at, si.created_at) as observed_at
  from public.signals_interests si
),
weighted as (
  select b.person_id, b.topic, b.source,
         b.raw_weight
           * coalesce(s.weight, 1.0)::real
           * exp(-0.6931471805599453 * greatest(0, extract(epoch from (now() - b.observed_at)) / 86400.0) / 180.0)::real as w,
         coalesce(s.kind, 'first_party') as kind
  from base b
  left join public.signals_interest_sources s on s.source = b.source
  where coalesce(s.enabled, true) = true
)
select person_id, topic,
       sum(w)::real as weight,
       (array_agg(source order by w desc))[1] as top_source,
       bool_or(kind in ('first_party', 'self_declared')) as has_first_party
from weighted
group by person_id, topic;

-- ── 6. person_topics(person_id): the source-agnostic read primitive ─────────
create or replace function public.person_topics(p_person_id uuid)
returns table(topic text, affinity real, top_source text, has_first_party boolean)
language sql stable security definer as $$
  select topic, weight as affinity, top_source, has_first_party
  from public.person_topic_interests
  where person_id = p_person_id
  order by weight desc
$$;
grant execute on function public.person_topics(uuid) to authenticated, anon;
grant execute on function public.normalize_topic(text) to authenticated, anon;

-- ── RLS for the new tables (internal module: authenticated read, admin write) ─
do $$
declare t text;
begin
  foreach t in array array['signals_interest_sources','topic_vocabulary','url_content_map'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s_sel" on public.%I', t, t);
    execute format('create policy "%s_sel" on public.%I for select to authenticated using (true)', t, t);
    execute format('drop policy if exists "%s_ins" on public.%I', t, t);
    execute format('create policy "%s_ins" on public.%I for insert to authenticated with check (public.is_admin())', t, t);
    execute format('drop policy if exists "%s_upd" on public.%I', t, t);
    execute format('create policy "%s_upd" on public.%I for update to authenticated using (public.is_admin())', t, t);
  end loop;
end $$;
