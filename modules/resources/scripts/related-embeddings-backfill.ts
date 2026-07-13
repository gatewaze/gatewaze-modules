// Populate related_embeddings for the semantic-similarity leg of
// /api/related-content. Embeds ONLY published/public content:
//   sr_block  — talk blocks (search_text) in published items
//   sr_item   — published items (title + subtitle)
//   event     — listed upcoming events (title + description)
//   blog_post — published blog posts (title + excerpt/description)
//
// Idempotent: re-embeds only when the source text changed or the model
// version differs. OpenAI text-embedding-3-small (1536 dims).
//
// Run: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENAI_API_KEY=... \
//        npx tsx related-embeddings-backfill.ts

import { createClient } from '@supabase/supabase-js';

const MODEL = 'text-embedding-3-small';
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
if (!url || !key || !openaiKey) {
  console.error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and OPENAI_API_KEY are required');
  process.exit(2);
}
const supabase = createClient(url, key);

interface Unit {
  content_type: string;
  content_id: string;
  item_id: string | null;
  href: string;
  title: string;
  card_type: string;
  description: string | null;
  image_url: string | null;
  meta: string | null;
  embed_text: string;
}

async function embed(texts: string[]): Promise<number[][]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embeddings API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const payload = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return payload.data.map((d) => d.embedding);
}

/** sr_block_transcripts is 1:1 but PostgREST returns it as object-or-array. */
function extractTranscript(rel: unknown): string {
  const row = Array.isArray(rel) ? rel[0] : rel;
  return (row as { transcript?: string } | null)?.transcript ?? '';
}

function clip(s: string, max = 6000): string {
  return s.length > max ? s.slice(0, max) : s;
}

async function collectUnits(): Promise<Unit[]> {
  const units: Unit[] = [];

  // published resource items + their talk blocks
  const { data: items, error: itemsErr } = await supabase
    .from('sr_items')
    .select('id, title, subtitle, slug, featured_image_url, status, collection:sr_collections(slug, name, status, access), blocks:sr_blocks(id, kind, slug, search_text, data, transcript:sr_block_transcripts(transcript))')
    .eq('status', 'published');
  if (itemsErr) throw new Error(itemsErr.message);
  for (const item of items ?? []) {
    const collection = Array.isArray(item.collection) ? item.collection[0] : item.collection;
    if (!collection || collection.status !== 'published') continue;
    const href = `/resources/${collection.slug}/${item.slug}`;
    units.push({
      content_type: 'sr_item',
      content_id: item.id,
      item_id: item.id,
      href,
      title: item.title,
      card_type: 'resource',
      description: item.subtitle ?? null,
      image_url: item.featured_image_url ?? null,
      meta: collection.name,
      embed_text: clip([item.title, item.subtitle].filter(Boolean).join(' — ')),
    });
    for (const block of (item.blocks ?? []) as any[]) {
      // talk + video blocks both carry a talk-shaped render snapshot
      if ((block.kind !== 'talk' && block.kind !== 'video') || !block.slug || !block.search_text) continue;
      units.push({
        content_type: 'sr_block',
        content_id: block.id,
        item_id: item.id,
        href: `${href}/${block.slug}`,
        title: block.data?.title ?? item.title,
        card_type: 'resource',
        description: block.data?.worth_noting ?? null,
        image_url: block.data?.youtube_id ? `https://i.ytimg.com/vi/${block.data.youtube_id}/hqdefault.jpg` : null,
        meta: item.title,
        // prefer what was actually said: card summary + transcript, clipped
        // like blog bodies. Falls back to the card text when no transcript.
        embed_text: clip(
          [block.search_text, extractTranscript(block.transcript)].filter(Boolean).join('\n'),
        ),
      });
    }
  }

  // listed upcoming events
  const { data: events } = await supabase
    .from('events')
    .select('id, event_id, event_title, event_description, event_start, event_city, event_country_code, event_featured_image, event_slug')
    .eq('is_listed', true)
    .gt('event_start', new Date().toISOString());
  for (const e of events ?? []) {
    const ref = e.event_slug ?? e.event_id;
    if (!ref || !e.event_title) continue;
    const when = e.event_start
      ? new Date(e.event_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      : '';
    const where = [e.event_city, e.event_country_code].filter(Boolean).join(', ');
    units.push({
      content_type: 'event',
      content_id: e.id,
      item_id: null,
      href: `/events/${ref}`,
      title: e.event_title,
      card_type: 'event',
      description: null,
      image_url: e.event_featured_image ?? null,
      meta: [when, where].filter(Boolean).join(' · '),
      embed_text: clip([e.event_title, e.event_description].filter(Boolean).join(' — ')),
    });
  }

  // published blog posts — external posts (scraped, canonical elsewhere)
  // link out to the real article; the full content text feeds the embedding
  const { data: posts, error: postsErr } = await supabase
    .from('blog_posts')
    .select('id, title, slug, excerpt, content, featured_image, canonical_url, is_external, status')
    .eq('status', 'published')
    .limit(500);
  if (postsErr) console.warn(`blog_posts skipped: ${postsErr.message}`);
  for (const p of posts ?? []) {
    if (!p.slug || !p.title) continue;
    const bodyText = typeof p.content === 'string'
      ? p.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
    units.push({
      content_type: 'blog_post',
      content_id: p.id,
      item_id: null,
      href: p.is_external && p.canonical_url ? p.canonical_url : `/blog/${p.slug}`,
      title: p.title,
      card_type: 'blog',
      description: p.excerpt ?? null,
      image_url: p.featured_image ?? null,
      meta: 'Blog',
      embed_text: clip([p.title, p.excerpt, bodyText].filter(Boolean).join(' — ')),
    });
  }

  // published videos (YouTube-hosted; canonical `videos` table). Guarded — the
  // videos module may not be installed on every brand.
  const { data: vids, error: vidsErr } = await supabase
    .from('videos')
    .select('id, title, description, url, thumbnail_url, channel_title, speakers, status, visibility')
    .eq('status', 'published')
    .eq('visibility', 'public')
    .limit(1000);
  if (vidsErr) {
    console.warn(`videos skipped: ${vidsErr.message}`);
  } else {
    for (const v of vids ?? []) {
      if (!v.id || !v.title) continue;
      const speakerNames = Array.isArray(v.speakers)
        ? (v.speakers as any[]).map((s) => s?.name).filter(Boolean).join(', ')
        : '';
      units.push({
        content_type: 'video',
        content_id: v.id,
        item_id: null,
        // in-portal video page (not the external YouTube url) so a related
        // click keeps the visitor on-site; the page embeds the recording
        href: `/videos/${v.id}`,
        title: v.title,
        card_type: 'video',
        description: v.description ? String(v.description).slice(0, 300) : null,
        image_url: v.thumbnail_url ?? null,
        meta: v.channel_title ?? 'Video',
        embed_text: clip([v.title, v.description, speakerNames].filter(Boolean).join(' — ')),
      });
    }
  }

  return units.filter((u) => u.embed_text.trim().length > 0);
}

async function main() {
  const units = await collectUnits();
  console.log(`collected ${units.length} embeddable units`);

  // skip rows whose text + model already match
  const { data: existing } = await supabase
    .from('related_embeddings')
    .select('content_type, content_id, embed_text, model_version');
  const fresh = new Set(
    (existing ?? [])
      .filter((r) => r.model_version === MODEL)
      .map((r) => `${r.content_type}:${r.content_id}:${r.embed_text}`),
  );
  const todo = units.filter((u) => !fresh.has(`${u.content_type}:${u.content_id}:${u.embed_text}`));
  console.log(`${todo.length} need embedding (${units.length - todo.length} up to date)`);

  for (let i = 0; i < todo.length; i += 64) {
    const batch = todo.slice(i, i + 64);
    const vectors = await embed(batch.map((u) => u.embed_text));
    const rows = batch.map((u, j) => ({
      ...u,
      embedding: JSON.stringify(vectors[j]),
      model_version: MODEL,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase
      .from('related_embeddings')
      .upsert(rows, { onConflict: 'content_type,content_id' });
    if (error) throw new Error(error.message);
    console.log(`embedded ${Math.min(i + 64, todo.length)}/${todo.length}`);
  }

  // drop rows whose source vanished (unpublished/deleted)
  const liveKeys = new Set(units.map((u) => `${u.content_type}:${u.content_id}`));
  const stale = (existing ?? []).filter((r) => !liveKeys.has(`${r.content_type}:${r.content_id}`));
  for (const r of stale) {
    await supabase.from('related_embeddings').delete()
      .eq('content_type', r.content_type).eq('content_id', r.content_id);
  }
  if (stale.length) console.log(`removed ${stale.length} stale rows`);
  console.log('done');
}

main().catch((err) => { console.error(err); process.exit(1); });
