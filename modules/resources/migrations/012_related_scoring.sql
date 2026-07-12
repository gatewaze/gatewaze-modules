-- 012: unified relevance scoring for related content.
--
-- Topic/event/blog candidate selection is set-membership (binary), which
-- reads as "too broad": sharing one tag counted as fully relevant. This
-- lookup scores ANY candidate hrefs against a source unit's embedding so
-- the resolver can rank every inferred card on one cosine scale and apply
-- a relative relevance threshold (keep cards >= N% as similar as the best
-- match). Pins stay exempt — editorial placement is a guarantee, not a
-- score.

create or replace function related_score_hrefs(
  p_content_type text,
  p_content_id uuid,
  p_hrefs text[]
)
returns table (href text, similarity real)
language sql stable security definer
set search_path = public, pg_temp
as $$
  with src as (
    select embedding from public.related_embeddings
    where content_type = p_content_type and content_id = p_content_id
  )
  select e.href, (1 - (e.embedding <=> src.embedding))::real as similarity
  from public.related_embeddings e, src
  where e.href = any(p_hrefs);
$$;

revoke all on function related_score_hrefs(text, uuid, text[]) from public;
grant execute on function related_score_hrefs(text, uuid, text[]) to anon, authenticated, service_role;
