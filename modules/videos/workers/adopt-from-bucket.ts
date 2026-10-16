// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * videos:adopt-from-bucket — register masters that are already in the S3
 * bucket as assets, and attach them to the talks they belong to.
 *
 * Why this exists: the practical way to get a channel's talks at 1080p is a
 * yt-dlp run on a laptop, with each finished file shipped straight to the
 * bucket so the laptop never holds the whole set. That leaves 58 objects
 * under a prefix that Gatewaze knows nothing about. This walks the prefix
 * and, for every object whose name carries a YouTube id in square brackets
 * (yt-dlp's `[%(id)s]` template):
 *
 *   1. finds or creates the `videos` row for that YouTube id,
 *   2. links it to the agenda entry the conference recap already matched
 *      that id to, when the row is not attached to anything yet,
 *   3. records a ready `master` asset pointing at the object, with
 *      `source = 'bucket_import'`.
 *
 * Nothing is downloaded or moved. There is no size cap because the bytes are
 * already paid for and already there; a seven-hour livestream is exactly the
 * kind of object this is for, since the clipping pipeline needs it whole.
 *
 * Operator-triggered. Idempotent: an object that already has an asset row is
 * skipped, so re-running after more files land picks up only the new ones.
 */

import { storeForNew } from '../lib/storage.js';
import { youtubeIdFromKey } from '../lib/takeout-match.js';
import { matchAgendaByTitle, metaFromInfoJson, type VideoMeta } from '../lib/agenda-match.js';

/**
 * The most an info.json may be. yt-dlp's run to 10MB for a talk with
 * auto-captions in twenty languages, because every caption track lists its
 * URLs; the fields kept are a few KB of that.
 */
const MAX_META_BYTES = 32 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
export const DEFAULT_PREFIX = 'local-import/';

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
};

export interface AdoptResult {
  prefix: string;
  objects: number;
  adopted: number;
  linked_to_agenda: number;
  skipped: number;
  failed: number;
  bytes: number;
}

/**
 * A prefix that stays inside the bucket's import area: under
 * `local-import/`, a folder path, no `..`. Anything else in the bucket
 * (editor uploads, Drive imports) is never adoptable this way, because an
 * adopted video is created public.
 */
export function safePrefix(value: unknown): string | null {
  const s = String(value ?? DEFAULT_PREFIX).trim();
  if (!s.startsWith(DEFAULT_PREFIX)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}\/$/.test(s) || s.includes('..') || s.includes('//')) return null;
  return s;
}

/**
 * The agenda entry a YouTube id was matched to by the recap, scoped to the
 * event when one is given. Canonical videos only (no duplicate_of).
 */
async function agendaEntryFor(supabase, youtubeId: string, eventId: string | null): Promise<string | null> {
  try {
    let q = supabase
      .from('conference_recap_videos')
      .select('agenda_entry_id, recap_id, conference_recaps!inner(event_id)')
      .eq('video_id', youtubeId)
      .is('duplicate_of', null)
      .not('agenda_entry_id', 'is', null)
      .limit(5);
    if (eventId) q = q.eq('conference_recaps.event_id', eventId);
    const { data } = await q;
    const hit = (data ?? [])[0];
    return hit?.agenda_entry_id ? String(hit.agenda_entry_id) : null;
  } catch {
    return null;
  }
}

/**
 * The yt-dlp metadata shipped beside a video, or nulls when there is none.
 * Read through a signed URL with a size cap; it is our own object but the
 * worker should still not buffer an unexpected gigabyte.
 */
async function readMeta(store, objects: Array<{ path: string; bytes: number }>, videoPath: string): Promise<VideoMeta> {
  const base = videoPath.replace(/\.[a-z0-9]+$/i, '');
  const meta = objects.find((o) => o.path === `${base}.info.json`);
  const empty: VideoMeta = { title: null, description: null, durationSeconds: null, publishedAt: null, chapters: [] };
  if (!meta || meta.bytes > MAX_META_BYTES) return empty;
  try {
    const res = await fetch(await store.signRead(meta.path, 300), { signal: AbortSignal.timeout(30_000) });
    if (!res.ok || !res.body) return empty;
    if (Number(res.headers.get('content-length') ?? 0) > MAX_META_BYTES) return empty;
    // Counted in bytes as it arrives, not measured after buffering, so an
    // object swapped since the listing still cannot fill the heap.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_META_BYTES) { await reader.cancel(); return empty; }
      chunks.push(value);
    }
    return metaFromInfoJson(JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')));
  } catch {
    return empty;
  }
}

/**
 * Record that this video is already public on YouTube, once.
 *
 * Not an upsert: the unique index on (platform, external_id) is partial
 * (WHERE external_id IS NOT NULL) and PostgREST cannot name a partial index
 * as a conflict target, so an upsert fails silently. Select, then insert,
 * and tolerate the race.
 */
async function recordYoutubePublication(supabase, videoId: string, youtubeId: string): Promise<void> {
  const { data: existing } = await supabase
    .from('video_publications').select('id').eq('platform', 'youtube').eq('external_id', youtubeId).limit(1);
  if ((existing ?? []).length) return;
  await supabase.from('video_publications').insert({
    video_id: videoId, platform: 'youtube', state: 'published', requested_visibility: 'public',
    external_id: youtubeId, external_url: `https://youtu.be/${youtubeId}`, external_visibility: 'public',
    published_at: new Date().toISOString(),
  });
}

/** The event's talks, for the title fallback. Empty without an event. */
async function agendaFor(supabase, eventId: string | null): Promise<Array<{ id: string; title: string }>> {
  if (!eventId) return [];
  const { data } = await supabase
    .from('events_agenda_entries').select('id, title').eq('event_uuid', eventId).eq('entry_type', 'session').limit(1000);
  return (data ?? []).map((e) => ({ id: String(e.id), title: String(e.title ?? '') }));
}

async function resolveVideoRow(supabase, youtubeId: string, titleFromName: string, meta: VideoMeta): Promise<string> {
  if (!YT_ID_RE.test(youtubeId)) throw new Error('not a YouTube id');
  const { data: existing } = await supabase
    .from('videos').select('id, description, duration_seconds, published_at').eq('provider', 'youtube').eq('provider_video_id', youtubeId).maybeSingle();
  if (existing) {
    // Fill gaps only. A title somebody has edited in the admin stays.
    const patch: Record<string, unknown> = {};
    if (!existing.description && meta.description) patch.description = meta.description;
    if (!existing.duration_seconds && meta.durationSeconds) patch.duration_seconds = meta.durationSeconds;
    if (!existing.published_at && meta.publishedAt) patch.published_at = meta.publishedAt;
    if (Object.keys(patch).length) await supabase.from('videos').update(patch).eq('id', existing.id);
    return String(existing.id);
  }
  const ins = await supabase
    .from('videos')
    .insert({
      provider: 'youtube',
      provider_video_id: youtubeId,
      url: `https://youtu.be/${youtubeId}`,
      title: (meta.title ?? titleFromName).slice(0, 300) || youtubeId,
      description: meta.description,
      duration_seconds: meta.durationSeconds,
      published_at: meta.publishedAt,
      // A multi-hour object is a livestream to be clipped, not a talk.
      kind: meta.durationSeconds && meta.durationSeconds > 3 * 3600 ? 'livestream' : 'full',
      status: 'published',
      publish_state: 'published',
      visibility: 'public',
      is_external: false,
      source: 'bucket-import',
    })
    .select('id')
    .single();
  if (ins.error) throw new Error(ins.error.message);
  return String(ins.data.id);
}

export async function adoptFromBucket(
  supabase,
  args: { prefix?: string | null; eventId?: string | null },
  log: (m: string) => void = () => {},
): Promise<AdoptResult> {
  const prefix = safePrefix(args.prefix) ?? DEFAULT_PREFIX;
  const result: AdoptResult = { prefix, objects: 0, adopted: 0, linked_to_agenda: 0, skipped: 0, failed: 0, bytes: 0 };
  const eventId = args.eventId && UUID_RE.test(args.eventId) ? args.eventId : null;

  const store = storeForNew(supabase, 'master');
  if (store.provider !== 's3') {
    log('adopt-from-bucket: VIDEO_S3_* is not configured, nothing to adopt from');
    return result;
  }
  const objects = await store.listPrefix(prefix);
  result.objects = objects.length;
  const agenda = await agendaFor(supabase, eventId);
  log(`bucket ${store.bucket}/${prefix}: ${objects.length} objects, ${agenda.length} agenda sessions in scope`);

  for (const o of objects) {
    const name = o.path.split('/').pop() ?? '';
    const ext = (name.match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase();
    const mime = MIME_BY_EXT[ext];
    const youtubeId = youtubeIdFromKey(o.path);
    if (!mime || !youtubeId) { result.skipped += 1; continue; }

    try {
      const { data: already } = await supabase
        .from('video_assets').select('id, state').eq('storage_provider', 's3').eq('storage_bucket', store.bucket).eq('storage_path', o.path).limit(1);
      if ((already ?? []).length) { result.skipped += 1; continue; }

      // A title from the object name is the last resort; a sanitised name
      // ("Pull-Requests-Are-Dead-5lq5zp6wYbQ-") is better than the bare id
      // but the metadata's title is what is used when it is there.
      const title = name
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/\s*\[[A-Za-z0-9_-]{11}\]$/, '')
        .replace(new RegExp(`[-_ ]*${youtubeId}[-_ ]*$`), '')
        .replace(/[-_]+/g, ' ')
        .trim();
      const meta = await readMeta(store, objects, o.path);
      const videoId = await resolveVideoRow(supabase, youtubeId, title, meta);

      // Attach to the agenda when the row is not attached to anything:
      // first the talk the recap already matched this id to, then a unique
      // title match against the event's sessions. A livestream matches
      // nothing by design; it is clipped later.
      const { data: subs } = await supabase.from('video_subjects').select('subject_type').eq('video_id', videoId).limit(1);
      const isLivestream = (meta.durationSeconds ?? 0) > 3 * 3600;
      if (!(subs ?? []).length && !isLivestream) {
        const entryId = await agendaEntryFor(supabase, youtubeId, eventId)
          ?? matchAgendaByTitle(meta.title ?? title, agenda)?.id
          ?? null;
        if (entryId) {
          const link = await supabase.from('video_subjects').upsert({
            video_id: videoId, subject_type: 'agenda_entry', subject_id: entryId, source: 'recap',
          }, { onConflict: 'video_id,subject_type,subject_id', ignoreDuplicates: true });
          if (!link.error) result.linked_to_agenda += 1;
        }
      }

      await recordYoutubePublication(supabase, videoId, youtubeId);

      // Keep the better master. A 360p YouTube import gives way to this
      // file; an editor's larger upload does not. The new row goes in as
      // `uploading` first and the old one is only superseded once the new
      // one exists, so a failed insert cannot leave the video with nothing.
      const { data: current } = await supabase
        .from('video_assets').select('id, bytes').eq('video_id', videoId).eq('kind', 'master').eq('state', 'ready').limit(1);
      const better = (current ?? [])[0];
      if (better && Number(better.bytes ?? 0) >= o.bytes) {
        result.skipped += 1;
        log(`${name}: video already has a master at least this large — skipped`);
        continue;
      }
      const ins = await supabase
        .from('video_assets')
        .insert({
          video_id: videoId,
          kind: 'master',
          storage_bucket: store.bucket,
          storage_provider: 's3',
          storage_path: o.path,
          filename: name.slice(0, 255),
          mime_type: mime,
          bytes: o.bytes || null,
          state: 'uploading',
          source: 'bucket_import',
        })
        .select('id')
        .single();
      if (ins.error) throw new Error(ins.error.message);
      if (better) {
        await supabase.from('video_assets').update({ state: 'superseded' }).eq('id', better.id).eq('state', 'ready');
      }
      const promote = await supabase.from('video_assets').update({ state: 'ready', error: null }).eq('id', ins.data.id);
      if (promote.error) throw new Error(promote.error.message);

      result.adopted += 1;
      result.bytes += o.bytes;
      log(`adopted ${name} (${(o.bytes / 1073741824).toFixed(2)}GB) → ${youtubeId}`);
    } catch (err) {
      result.failed += 1;
      log(`${name}: ${String((err as Error)?.message ?? err).slice(0, 300)}`);
    }
  }

  log(
    `adopt-from-bucket ${prefix}: ${result.adopted} adopted (${result.linked_to_agenda} linked to the agenda), `
    + `${result.skipped} skipped, ${result.failed} failed, ${(result.bytes / 1073741824).toFixed(2)}GB`,
  );
  return result;
}

export default async function adoptFromBucketHandler(job, ctx): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[videos] ${m}`);
  const eventId = String(job?.data?.event_id ?? job?.data?.eventId ?? '');
  await adoptFromBucket(supabase, { prefix: job?.data?.prefix, eventId: UUID_RE.test(eventId) ? eventId : null }, log);
}
