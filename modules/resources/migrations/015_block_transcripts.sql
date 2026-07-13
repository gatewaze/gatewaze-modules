-- 015: full transcripts for talk/video blocks.
-- Stored 1:1 in their own table (not on sr_blocks) so rendering and search
-- queries never drag ~20KB of transcript per card; only the related-content
-- embedding backfill reads it, to embed talks on what was actually said
-- rather than the short card summary.

create table if not exists sr_block_transcripts (
  block_id uuid primary key references sr_blocks(id) on delete cascade,
  video_id text,                 -- source YouTube id the transcript came from
  transcript text not null,
  source text not null default 'youtube-auto', -- youtube-auto | youtube-manual | human
  fetched_at timestamptz not null default now()
);

comment on table sr_block_transcripts is
  'Full talk transcripts, keyed by block. Feeds related-content embeddings; not used for rendering.';

-- service-role only: transcripts are derived data for background jobs, not a
-- public read surface (the public sees the rendered cards + videos).
alter table sr_block_transcripts enable row level security;
