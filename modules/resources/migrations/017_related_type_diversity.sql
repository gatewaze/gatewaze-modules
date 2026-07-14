-- 017: type-diverse neighbour retrieval for related content.
--
-- The global nearest-neighbour list is dominated by whichever content type
-- has the richest embed text (blog posts: full articles), so other types —
-- videos especially — rarely even reach the relevance gate to compete. This
-- adds an optional card-type filter to related_by_embedding so the resolver
-- can fetch the best neighbours PER TYPE and let the gate judge each on
-- merit. Selection caps live in the resolver, not here.

drop function if exists related_by_embedding(text, uuid, integer);
create function related_by_embedding(
  p_content_type text,
  p_content_id uuid,
  p_limit integer default 6,
  p_card_type text default null
)
returns table (
  content_type text, href text, title text, card_type text,
  description text, image_url text, meta text, similarity real
)
language sql stable security definer
set search_path = public, pg_temp
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
    and (p_card_type is null or e.card_type = p_card_type)
    and (src.item_id is null or e.item_id is distinct from src.item_id or e.item_id is null)
    and (e.item_id is null or src.item_id is null or e.item_id <> src.item_id)
  order by e.embedding <=> src.embedding
  limit greatest(1, least(p_limit, 20));
$$;

revoke all on function related_by_embedding(text, uuid, integer, text) from public;
grant execute on function related_by_embedding(text, uuid, integer, text) to anon, authenticated, service_role;
