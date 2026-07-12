-- 010: related_embeddings — semantic similarity for the related-content
-- resolver (Layer 2 of dynamic association: pins > topics > similarity).
--
-- One row per embeddable content unit (resource blocks, resource items,
-- events, blog posts), carrying everything the resolver needs to render a
-- card WITHOUT joining back into module tables at query time. Only
-- published/public content is ever embedded (the backfill enforces it), so
-- the read RPC is safe to expose to the portal's anon-key server client.
--
-- Populated by scripts/related-embeddings-backfill.ts (OpenAI
-- text-embedding-3-small, 1536 dims — same shape blog_embeddings reserved).

create extension if not exists vector;

create table if not exists public.related_embeddings (
  id            uuid primary key default gen_random_uuid(),
  content_type  text not null,          -- sr_block | sr_item | event | blog_post
  content_id    uuid not null,
  item_id       uuid,                   -- parent sr_item for blocks (self-exclusion)
  href          text not null,
  title         text not null,
  card_type     text not null default 'resource',
  description   text,
  image_url     text,
  meta          text,
  embed_text    text not null,
  embedding     vector(1536) not null,
  model_version text not null,
  updated_at    timestamptz not null default now(),

  constraint related_embeddings_type_format
    check (content_type ~ '^[a-z][a-z0-9_]{0,40}$'),
  constraint related_embeddings_unique unique (content_type, content_id)
);

create index if not exists related_embeddings_hnsw
  on public.related_embeddings using hnsw (embedding vector_cosine_ops);

-- service-role writes only; reads go through the RPC below
alter table public.related_embeddings enable row level security;
revoke all on public.related_embeddings from anon, authenticated;

-- Nearest neighbours for a source unit, excluding itself and anything from
-- the same parent item. SECURITY DEFINER so the anon-key portal client can
-- call it while the table itself stays unreadable; the function exposes only
-- card-rendering fields of content that was published when embedded.
create or replace function related_by_embedding(
  p_content_type text,
  p_content_id uuid,
  p_limit integer default 6
)
returns table (
  content_type text, href text, title text, card_type text,
  description text, image_url text, meta text, similarity real
)
language sql stable security definer
set search_path = public, extensions, pg_temp
as $$
  with src as (
    select e.embedding, e.item_id, e.content_id
    from public.related_embeddings e
    where e.content_type = p_content_type and e.content_id = p_content_id
  )
  select
    e.content_type, e.href, e.title, e.card_type, e.description, e.image_url, e.meta,
    (1 - (e.embedding <=> src.embedding))::real as similarity
  from public.related_embeddings e, src
  where e.content_id <> src.content_id
    and (src.item_id is null or e.item_id is distinct from src.item_id or e.item_id is null)
    and (e.item_id is null or src.item_id is null or e.item_id <> src.item_id)
  order by e.embedding <=> src.embedding
  limit greatest(1, least(p_limit, 20));
$$;

revoke all on function related_by_embedding(text, uuid, integer) from public;
grant execute on function related_by_embedding(text, uuid, integer) to anon, authenticated, service_role;
