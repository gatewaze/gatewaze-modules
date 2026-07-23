// Fetch YouTube auto-captions for talk blocks into sr_block_transcripts.
//
// For every kind='talk' sr_block with a data.youtube_id and no transcript row,
// pull the video's English auto-captions via yt-dlp (json3), flatten to plain
// text and upsert into sr_block_transcripts (source 'youtube-auto'). The
// related-embeddings backfill then embeds talks on what was actually said
// instead of the short card summary.
//
// Why yt-dlp and not youtubei.js / raw timedtext: as of 2026-07 YouTube's
// get_transcript endpoint 400s for Innertube clients and caption base_urls
// return EMPTY bodies without a proof-of-origin token; yt-dlp handles the PoT
// dance. Datacenter IPs are bot-gated entirely (getInfo returns nothing), so
// RUN THIS FROM A RESIDENTIAL/WORKSTATION IP, not the cluster.
//
// Idempotent: existing rows are skipped (re-run after new talk blocks land).
// Videos without captions are reported and skipped — the backfill falls back
// to search_text for those.
//
// Run (yt-dlp on PATH):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx fetch-block-transcripts.ts

import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(2);
}
const supabase = createClient(url, key);

function fetchTranscript(videoId: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'yt-subs-'));
  try {
    execFileSync(
      'yt-dlp',
      [
        '--skip-download',
        '--write-auto-subs',
        '--write-subs',
        '--sub-langs', 'en.*',
        '--sub-format', 'json3',
        '-o', join(dir, 'subs.%(ext)s'),
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 120_000 },
    );
    const file = readdirSync(dir).find((f) => f.endsWith('.json3'));
    if (!file) return null;
    const data = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      events?: Array<{ segs?: Array<{ utf8?: string }> }>;
    };
    const text = (data.events ?? [])
      .flatMap((ev) => (ev.segs ?? []).map((s) => s.utf8 ?? ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 0 ? text : null;
  } catch {
    return null; // no captions / gated / unavailable
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const { data: blocks, error } = await supabase
    .from('sr_blocks')
    .select('id, data')
    .eq('kind', 'talk');
  if (error) throw new Error(error.message);

  const { data: existing } = await supabase
    .from('sr_block_transcripts')
    .select('block_id');
  const have = new Set((existing ?? []).map((r) => r.block_id));

  const todo = (blocks ?? []).filter(
    (b) => !have.has(b.id) && typeof (b.data as any)?.youtube_id === 'string',
  );
  console.log(`${blocks?.length ?? 0} talk blocks; ${todo.length} need transcripts`);

  let ok = 0;
  let none = 0;
  for (const b of todo) {
    const videoId = (b.data as any).youtube_id as string;
    const transcript = fetchTranscript(videoId);
    if (!transcript) {
      none++;
      console.log(`  no captions: block ${b.id} (video ${videoId})`);
      continue;
    }
    const { error: upErr } = await supabase.from('sr_block_transcripts').upsert(
      {
        block_id: b.id,
        video_id: videoId,
        transcript,
        source: 'youtube-auto',
        fetched_at: new Date().toISOString(),
      },
      { onConflict: 'block_id' },
    );
    if (upErr) throw new Error(`block ${b.id}: ${upErr.message}`);
    ok++;
    console.log(`  fetched: block ${b.id} (video ${videoId}, ${transcript.length} chars)`);
  }
  console.log(`done: ${ok} fetched, ${none} without captions, ${have.size} already present`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
