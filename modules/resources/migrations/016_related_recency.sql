-- 014: recency + thin-source awareness for related content.
--
-- Two production findings drive this (Voice Agents Forum case):
--   * a source whose embed_text is a title-length stub produces unreliable
--     similarities — the resolver needs the source's text length to demand a
--     higher absolute bar from stub sources;
--   * dated content (blog posts, videos) should prefer FRESH kin — the
--     resolver needs each candidate's published_at to apply a mild decay.

alter table public.related_embeddings
  add column if not exists published_at timestamptz;

-- return types change: drop + recreate (callers deploy together)
drop function if exists related_source_meta(text, uuid);
create function related_source_meta(
  p_content_type text,
  p_content_id uuid
)
returns table (href text, item_id uuid, embed_len integer, published_at timestamptz)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select e.href, e.item_id, length(e.embed_text), e.published_at
  from public.related_embeddings e
  where e.content_type = p_content_type and e.content_id = p_content_id;
$$;
revoke all on function related_source_meta(text, uuid) from public;
grant execute on function related_source_meta(text, uuid) to anon, authenticated, service_role;

drop function if exists related_score_hrefs(text, uuid, text[]);
create function related_score_hrefs(
  p_content_type text,
  p_content_id uuid,
  p_hrefs text[]
)
returns table (href text, similarity real, published_at timestamptz)
language sql stable security definer
set search_path = public, pg_temp
as $$
  with src as (
    select embedding from public.related_embeddings
    where content_type = p_content_type and content_id = p_content_id
  )
  select e.href, (1 - (e.embedding <=> src.embedding))::real, e.published_at
  from public.related_embeddings e, src
  where e.href = any(p_hrefs);
$$;
revoke all on function related_score_hrefs(text, uuid, text[]) from public;
grant execute on function related_score_hrefs(text, uuid, text[]) to anon, authenticated, service_role;
