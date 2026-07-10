-- 007: structured blocks (sr_blocks) — typed, individually addressable content
-- objects inside sections, with raw HTML as a permanent first-class kind.
-- Spec: spec-resources-structured-blocks.md (gatewaze-environments/specs).
--
-- Idempotent throughout: guarded DDL, and the backfill skips sections that
-- already have blocks. No down migration ships — rollback is logical (render
-- precedence, kill switch, restore from sr_blocks_migration_audit, _v0 RPC).

set local statement_timeout = '60s';

-- ── Preflight: warn (not fail) if the sr_sections policies have drifted ─────
do $$
declare
  missing text := '';
  p text;
begin
  foreach p in array array['sr_sections_admin_all', 'sr_sections_anon_select', 'sr_sections_auth_select'] loop
    if not exists (select 1 from pg_policies where tablename = 'sr_sections' and policyname = p) then
      missing := missing || p || ' ';
    end if;
  end loop;
  if missing <> '' then
    raise warning 'structured-blocks preflight: sr_sections policies differ from expected (missing: %) — review sr_blocks policy parity for this brand', missing;
  end if;
end $$;

-- ── Composite uniqueness target so the block FK can guarantee section/item
--    consistency declaratively (no trigger needed) ────────────────────────────
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sr_sections_id_item_key') then
    alter table public.sr_sections add constraint sr_sections_id_item_key unique (id, item_id);
  end if;
end $$;

-- ── Table ────────────────────────────────────────────────────────────────────
create table if not exists public.sr_blocks (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.sr_items(id) on delete cascade,
  section_id  uuid not null,
  kind        text not null,          -- no default: an accidental row must fail loudly,
                                      -- not become an empty-payload 'html' block
  slug        text,
  data        jsonb not null default '{}'::jsonb,
  search_text text,                   -- plain-text projection, per-kind (write layer)
  search_vector tsvector generated always as
    (to_tsvector('english', coalesce(search_text, ''))) stored,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint sr_blocks_section_fk
    foreign key (section_id, item_id)
    references public.sr_sections (id, item_id) on delete cascade,
  constraint sr_blocks_slug_format
    check (slug is null or slug ~ '^[a-z0-9][a-z0-9-]{0,120}$'),
  constraint sr_blocks_kind_format
    check (kind ~ '^[a-z][a-z0-9_]{0,40}$'),
  constraint sr_blocks_sort_order_nonneg
    check (sort_order >= 0)
);

-- ── Triggers: updated_at freshness + identity immutability ──────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $fn$
begin new.updated_at = now(); return new; end;
$fn$;

drop trigger if exists sr_blocks_set_updated_at on public.sr_blocks;
create trigger sr_blocks_set_updated_at
  before update on public.sr_blocks
  for each row execute function public.set_updated_at();

-- The write layer only ever delete-then-inserts; an UPDATE that "moves" a
-- block between sections/items is a bug — reject it.
create or replace function public.sr_blocks_forbid_identity_change()
returns trigger language plpgsql as $fn$
begin
  if new.item_id <> old.item_id or new.section_id <> old.section_id then
    raise exception 'sr_blocks.item_id/section_id are immutable; delete and re-insert instead';
  end if;
  return new;
end;
$fn$;

drop trigger if exists sr_blocks_identity_guard on public.sr_blocks;
create trigger sr_blocks_identity_guard
  before update on public.sr_blocks
  for each row execute function public.sr_blocks_forbid_identity_change();

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- anchors are item-scoped: /{collection}/{item}/{slug}
create unique index if not exists sr_blocks_item_slug_key
  on public.sr_blocks (item_id, slug) where slug is not null;
create index if not exists sr_blocks_section_sort_idx
  on public.sr_blocks (section_id, sort_order, id);
-- partial: only blocks carrying a well-formed topics array (talk) pay for the
-- index; backfilled html blocks and out-of-band malformed payloads stay out.
-- In-contract query shape: (data -> 'topics') @> '["slug"]'::jsonb
create index if not exists sr_blocks_topics_gin
  on public.sr_blocks using gin ((data -> 'topics') jsonb_path_ops)
  where jsonb_typeof(data -> 'topics') = 'array';
create index if not exists sr_blocks_search_idx
  on public.sr_blocks using gin (search_vector);

-- ── RLS: mirrors the three live sr_sections policies, re-rooted at item_id ──
alter table public.sr_blocks enable row level security;

drop policy if exists sr_blocks_admin_all on public.sr_blocks;
create policy sr_blocks_admin_all on public.sr_blocks
  for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists sr_blocks_anon_select on public.sr_blocks;
create policy sr_blocks_anon_select on public.sr_blocks
  for select to anon using (exists (
    select 1 from public.sr_items i
    join public.sr_collections c on c.id = i.collection_id
    where i.id = sr_blocks.item_id
      and i.status = 'published' and c.status = 'published'
      and c.access in ('public', 'metered')));

drop policy if exists sr_blocks_auth_select on public.sr_blocks;
create policy sr_blocks_auth_select on public.sr_blocks
  for select to authenticated using (exists (
    select 1 from public.sr_items i
    join public.sr_collections c on c.id = i.collection_id
    where i.id = sr_blocks.item_id
      and i.status = 'published' and c.status = 'published'));

-- search projections are never exposed on public read surfaces — enforced via
-- column grants, not convention (even select=* cannot leak them)
revoke select on public.sr_blocks from anon, authenticated;
grant select (id, item_id, section_id, kind, slug, data, sort_order, created_at, updated_at)
  on public.sr_blocks to anon, authenticated;

-- ── Migration-audit table (used by the talk-promotion step; service-role only:
--    RLS enabled with no client policies) ──────────────────────────────────────
create table if not exists public.sr_blocks_migration_audit (
  section_id  uuid primary key references public.sr_sections(id) on delete cascade,
  old_content text not null,
  migrated_at timestamptz not null default now()
);
alter table public.sr_blocks_migration_audit enable row level security;
revoke all on public.sr_blocks_migration_audit from anon, authenticated;

-- ── Search RPC: snapshot the current behavior as _v0, then extend in place ──
-- _v0 is the verbatim 001 definition under a new name (rollback = one
-- create-or-replace from this body).
create or replace function sr_search_items_v0(
  p_collection_id uuid,
  p_query text,
  p_category_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  item_id uuid, item_title text, item_slug text, item_subtitle text,
  category_id uuid, category_name text, category_slug text, relevance real
) as $$
begin
  return query
  select distinct on (i.id)
    i.id as item_id, i.title as item_title, i.slug as item_slug, i.subtitle as item_subtitle,
    c.id as category_id, c.name as category_name, c.slug as category_slug,
    ts_rank(
      i.search_vector || coalesce(s.search_vector, ''::tsvector),
      plainto_tsquery('english', p_query)
    ) as relevance
  from public.sr_items i
  join public.sr_categories c on c.id = i.category_id
  left join public.sr_sections s on s.item_id = i.id
  where i.collection_id = p_collection_id
    and i.status = 'published'
    and (p_category_id is null or i.category_id = p_category_id)
    and (
      i.search_vector @@ plainto_tsquery('english', p_query)
      or exists (
        select 1 from public.sr_sections sec
        where sec.item_id = i.id
        and sec.search_vector @@ plainto_tsquery('english', p_query)
      )
    )
  order by i.id, relevance desc
  limit p_limit
  offset p_offset;
end;
$$ language plpgsql security invoker;

-- Extended sr_search_items — same name, signature and result shape. Sourcing
-- rule (normative): a section with >=1 block participates via its block
-- vectors ONLY; a section with no blocks via its legacy vector ONLY. Rank
-- construction (ts_rank, plainto_tsquery('english', ...)) frozen from _v0.
create or replace function sr_search_items(
  p_collection_id uuid,
  p_query text,
  p_category_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  item_id uuid, item_title text, item_slug text, item_subtitle text,
  category_id uuid, category_name text, category_slug text, relevance real
) as $$
begin
  return query
  /* resources:sr_search_items structured-blocks */
  select
    i.id as item_id, i.title as item_title, i.slug as item_slug, i.subtitle as item_subtitle,
    c.id as category_id, c.name as category_name, c.slug as category_slug,
    ts_rank(
      i.search_vector || coalesce(aux.vec, ''::tsvector),
      plainto_tsquery('english', p_query)
    ) as relevance
  from public.sr_items i
  join public.sr_categories c on c.id = i.category_id
  left join lateral (
    select av.vec
    from (
      -- sections with no blocks contribute their legacy vector…
      select s.search_vector as vec
      from public.sr_sections s
      where s.item_id = i.id
        and not exists (select 1 from public.sr_blocks b
                        where b.section_id = s.id and b.item_id = s.item_id)
      union all
      -- …sections with blocks contribute their block vectors instead
      select b.search_vector
      from public.sr_blocks b
      where b.item_id = i.id
    ) av
    where av.vec @@ plainto_tsquery('english', p_query)
    order by ts_rank(av.vec, plainto_tsquery('english', p_query)) desc
    limit 1
  ) aux on true
  where i.collection_id = p_collection_id
    and i.status = 'published'
    and (p_category_id is null or i.category_id = p_category_id)
    and (
      i.search_vector @@ plainto_tsquery('english', p_query)
      or aux.vec is not null
    )
  order by i.id, relevance desc
  limit p_limit
  offset p_offset;
end;
$$ language plpgsql security invoker;

-- ── Atomic write RPCs ────────────────────────────────────────────────────────
-- The manage API validates payloads and computes search_text/slugs in the
-- module write layer, then calls these for the actual mutation so
-- delete-then-insert + the item-version bump commit or roll back as one
-- transaction (supabase-js has no client-side transactions). Service-role
-- only: execute is revoked from client roles below.
--
-- p_expected_version: optional if_match token, compared at timestamptz
-- precision. Raises version_mismatch / not_found as errcodes the API maps.

create or replace function sr_replace_item_sections(
  p_item_id uuid,
  p_sections jsonb,               -- [{heading, content, template_id, sort_order, blocks:[{kind, slug, data, search_text, sort_order}]}]
  p_expected_version timestamptz default null
)
returns jsonb as $$
declare
  v_current timestamptz;
  v_section jsonb;
  v_block jsonb;
  v_section_id uuid;
  v_ids uuid[] := '{}';
begin
  select updated_at into v_current from public.sr_items where id = p_item_id for update;
  if not found then
    raise exception 'item not found' using errcode = 'P0404';
  end if;
  if p_expected_version is not null and v_current is distinct from p_expected_version then
    raise exception 'item version mismatch' using errcode = 'P0409';
  end if;

  delete from public.sr_sections where item_id = p_item_id;  -- cascades sr_blocks

  for v_section in select * from jsonb_array_elements(coalesce(p_sections, '[]'::jsonb)) loop
    insert into public.sr_sections (item_id, heading, content, template_id, sort_order)
    values (
      p_item_id,
      v_section->>'heading',
      v_section->>'content',
      nullif(v_section->>'template_id', '')::uuid,
      coalesce((v_section->>'sort_order')::integer, 0)
    )
    returning id into v_section_id;
    v_ids := v_ids || v_section_id;

    for v_block in select * from jsonb_array_elements(coalesce(v_section->'blocks', '[]'::jsonb)) loop
      insert into public.sr_blocks (item_id, section_id, kind, slug, data, search_text, sort_order)
      values (
        p_item_id, v_section_id,
        v_block->>'kind',
        nullif(v_block->>'slug', ''),
        coalesce(v_block->'data', '{}'::jsonb),
        v_block->>'search_text',
        coalesce((v_block->>'sort_order')::integer, 0)
      );
    end loop;
  end loop;

  update public.sr_items set updated_at = now() where id = p_item_id;
  select updated_at into v_current from public.sr_items where id = p_item_id;

  return jsonb_build_object('item_id', p_item_id, 'updated_at', v_current, 'section_ids', to_jsonb(v_ids));
end;
$$ language plpgsql security invoker;

create or replace function sr_replace_section_blocks(
  p_item_id uuid,
  p_section_id uuid,
  p_blocks jsonb,                 -- [{kind, slug, data, search_text, sort_order}]
  p_expected_version timestamptz default null
)
returns jsonb as $$
declare
  v_current timestamptz;
  v_block jsonb;
begin
  select updated_at into v_current from public.sr_items where id = p_item_id for update;
  if not found then
    raise exception 'item not found' using errcode = 'P0404';
  end if;
  if p_expected_version is not null and v_current is distinct from p_expected_version then
    raise exception 'item version mismatch' using errcode = 'P0409';
  end if;
  if not exists (select 1 from public.sr_sections s where s.id = p_section_id and s.item_id = p_item_id) then
    raise exception 'section not found in item' using errcode = 'P0404';
  end if;

  -- never mutates sr_sections.content (reversibility contract)
  delete from public.sr_blocks where section_id = p_section_id;

  for v_block in select * from jsonb_array_elements(coalesce(p_blocks, '[]'::jsonb)) loop
    insert into public.sr_blocks (item_id, section_id, kind, slug, data, search_text, sort_order)
    values (
      p_item_id, p_section_id,
      v_block->>'kind',
      nullif(v_block->>'slug', ''),
      coalesce(v_block->'data', '{}'::jsonb),
      v_block->>'search_text',
      coalesce((v_block->>'sort_order')::integer, 0)
    );
  end loop;

  update public.sr_items set updated_at = now() where id = p_item_id;
  select updated_at into v_current from public.sr_items where id = p_item_id;

  return jsonb_build_object('item_id', p_item_id, 'section_id', p_section_id, 'updated_at', v_current);
end;
$$ language plpgsql security invoker;

-- Callable by the service role (manage API) and by authenticated admins (the
-- admin UI's atomic write path) — never anon. SECURITY INVOKER means RLS
-- still gates every row these RPCs touch: a non-admin authenticated caller
-- deletes nothing and cannot insert (sr_blocks_admin_all with-check aborts
-- the transaction), so the grant adds atomicity, not privilege.
revoke execute on function sr_replace_item_sections(uuid, jsonb, timestamptz) from public, anon;
revoke execute on function sr_replace_section_blocks(uuid, uuid, jsonb, timestamptz) from public, anon;
grant execute on function sr_replace_item_sections(uuid, jsonb, timestamptz) to authenticated, service_role;
grant execute on function sr_replace_section_blocks(uuid, uuid, jsonb, timestamptz) to authenticated, service_role;

-- ── Backfill: every non-empty section with no blocks gets one mirroring html
--    block. content is untouched (render precedence keeps output identical).
--    Slug derivation here is the conservative SQL approximation of the module
--    rule — single top-level <div id="..."> wrapper — which covers all
--    generator-produced content; the Node hygiene script re-derives with the
--    real parser and reports drift. Re-runnable: the not-exists guard is the
--    idempotence predicate. ─────────────────────────────────────────────────
do $$
declare
  total_sections integer;
  n_backfilled integer;
  n_slugged integer;
begin
  select count(*) into total_sections from public.sr_sections;
  if total_sections > 10000 then
    raise exception 'structured-blocks backfill guard: % sections exceeds 10000 — run the batched out-of-migration backfill instead', total_sections;
  end if;

  with src as (
    select s.id, s.item_id, s.content, btrim(s.content) as t
    from public.sr_sections s
    where s.content is not null
      and btrim(s.content) <> ''
      and not exists (select 1 from public.sr_blocks b where b.section_id = s.id)
  ),
  candidates as (
    select
      src.*,
      case
        when src.t ~ '^<div id="[a-z0-9][a-z0-9-]{0,120}"' and src.t like '%</div>'
        then (regexp_match(src.t, '^<div id="([a-z0-9][a-z0-9-]{0,120})"'))[1]
        else null
      end as slug_candidate
    from src
  ),
  deduped as (
    select
      c.*,
      case
        when c.slug_candidate is null then null
        when row_number() over (partition by c.item_id, c.slug_candidate order by c.id) > 1 then null
        when exists (select 1 from public.sr_blocks b2
                     where b2.item_id = c.item_id and b2.slug = c.slug_candidate) then null
        else c.slug_candidate
      end as slug_final
    from candidates c
  ),
  ins as (
    insert into public.sr_blocks (item_id, section_id, kind, slug, data, search_text, sort_order)
    select
      d.item_id, d.id, 'html', d.slug_final,
      jsonb_build_object('html', d.content),
      nullif(btrim(regexp_replace(
        left(regexp_replace(d.content, '<[^>]*>', ' ', 'g'), 200000),
        '\s+', ' ', 'g')), ''),
      0
    from deduped d
    returning slug
  )
  select count(*), count(slug) into n_backfilled, n_slugged from ins;

  raise notice 'structured-blocks backfill report: % sections total, % backfilled to html blocks, % slugs derived, % left null',
    total_sections, n_backfilled, n_slugged, n_backfilled - n_slugged;
end $$;
