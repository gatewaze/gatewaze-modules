-- 021: preserve sr_block_transcripts across block replaces.
--
-- Both replace RPCs are delete-then-insert, and sr_block_transcripts hangs
-- off sr_blocks(id) ON DELETE CASCADE — so every admin-editor save (which
-- replaces a section's blocks even when unchanged) silently wiped that
-- section's transcripts. Observed twice: the Bengaluru re-blockification
-- (2026-07-14) and a Mumbai item save (2026-07-18) each cascaded away a
-- full set of fetched transcripts.
--
-- Fix: stash the outgoing blocks' transcripts before the delete and
-- re-attach them to the incoming blocks matched on the video id (the
-- transcript row's own video_id, falling back to the old block's
-- data->>'youtube_id'). Blocks without a video id (html blocks) never carry
-- transcripts, and a genuinely removed talk drops its transcript with it —
-- both unchanged. Bodies otherwise identical to 007.

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

  -- stash transcripts of the outgoing blocks, keyed by video id
  create temp table if not exists _sr_transcript_stash (
    video_id text, transcript text, source text, fetched_at timestamptz
  ) on commit drop;
  delete from _sr_transcript_stash;
  insert into _sr_transcript_stash
    select coalesce(t.video_id, b.data->>'youtube_id'), t.transcript, t.source, t.fetched_at
    from public.sr_block_transcripts t
    join public.sr_blocks b on b.id = t.block_id
    where b.item_id = p_item_id
      and coalesce(t.video_id, b.data->>'youtube_id') is not null;

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

  -- re-attach stashed transcripts to the incoming blocks
  insert into public.sr_block_transcripts (block_id, video_id, transcript, source, fetched_at)
  select distinct on (b.id) b.id, s.video_id, s.transcript, s.source, s.fetched_at
  from public.sr_blocks b
  join _sr_transcript_stash s on s.video_id = b.data->>'youtube_id'
  where b.item_id = p_item_id
  on conflict (block_id) do nothing;

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

  -- stash this section's transcripts, keyed by video id
  create temp table if not exists _sr_transcript_stash (
    video_id text, transcript text, source text, fetched_at timestamptz
  ) on commit drop;
  delete from _sr_transcript_stash;
  insert into _sr_transcript_stash
    select coalesce(t.video_id, b.data->>'youtube_id'), t.transcript, t.source, t.fetched_at
    from public.sr_block_transcripts t
    join public.sr_blocks b on b.id = t.block_id
    where b.section_id = p_section_id
      and coalesce(t.video_id, b.data->>'youtube_id') is not null;

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

  -- re-attach stashed transcripts to the incoming blocks
  insert into public.sr_block_transcripts (block_id, video_id, transcript, source, fetched_at)
  select distinct on (b.id) b.id, s.video_id, s.transcript, s.source, s.fetched_at
  from public.sr_blocks b
  join _sr_transcript_stash s on s.video_id = b.data->>'youtube_id'
  where b.section_id = p_section_id
  on conflict (block_id) do nothing;

  update public.sr_items set updated_at = now() where id = p_item_id;
  select updated_at into v_current from public.sr_items where id = p_item_id;

  return jsonb_build_object('item_id', p_item_id, 'section_id', p_section_id, 'updated_at', v_current);
end;
$$ language plpgsql security invoker;

-- CREATE OR REPLACE preserves ACLs, but re-grant for self-sufficiency
grant execute on function sr_replace_item_sections(uuid, jsonb, timestamptz) to authenticated, service_role;
grant execute on function sr_replace_section_blocks(uuid, uuid, jsonb, timestamptz) to authenticated, service_role;
