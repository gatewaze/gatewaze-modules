// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * videos:sync-batches — adopt what has landed under each open batch's prefix.
 *
 * Runs every five minutes, and on demand from the batch page. For each open
 * batch: expire it if its key is dead; list the prefix; for every object not
 * yet adopted, make a video row titled from the file name, attach it to the
 * batch's event agenda when a session title matches, copy the object server
 * side to a path the batch key cannot reach, record that copy as a ready
 * master carrying the batch id, the source path and the source ETag, and
 * queue the studio pass. The copy matters: Backblaze treats an S3 delete as
 * a hide and `writeFiles` allows it, so the uploader could otherwise hide
 * the very object a master points at. An object whose ETag changed since
 * adoption is flagged, not re-adopted: a new version under the same name
 * must not silently replace a master an editor may already have approved.
 *
 * Only finished uploads are listed (a multipart upload in progress is not
 * an object yet), so a file is never adopted half way through.
 */

import { storeForNew } from '../lib/storage.js';
import { matchAgendaByTitle } from '../lib/agenda-match.js';
import { MIME_BY_EXT, titleFromFilename, looksLikeVideo, logName, MIN_BATCH_FILE_BYTES, MAX_BATCH_FILE_BYTES, DEFAULT_BATCH_MAX_FILES } from '../lib/batches.js';
import { sanitiseFilename } from '../lib/upload-rules.js';
import { deleteKey } from '../lib/b2-keys.js';
import { falConfigured } from '../lib/fal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FLAGS = 50;

export interface SyncResult { batches: number; adopted: number; flagged: number; expired: number; revoked: number }

async function maxFiles(supabase): Promise<number> {
  try {
    const { data } = await supabase.from('installed_modules').select('config').eq('id', 'videos').maybeSingle();
    const n = Number((data?.config ?? {}).batch_max_files);
    return Number.isFinite(n) && n > 0 ? Math.min(2000, n) : DEFAULT_BATCH_MAX_FILES;
  } catch {
    return DEFAULT_BATCH_MAX_FILES;
  }
}

/** Revoke the key of a batch that is no longer open, and record it. */
async function revoke(supabase, batch, log: (m: string) => void): Promise<boolean> {
  if (!batch.key_id) return true;
  const ok = await deleteKey(String(batch.key_id));
  if (ok) await supabase.from('video_upload_batches').update({ key_revoked_at: new Date().toISOString() }).eq('id', batch.id);
  else log(`batch ${batch.id}: key ${batch.key_id} could not be deleted at Backblaze; will retry`);
  return ok;
}

async function agendaFor(supabase, eventId: string | null): Promise<Array<{ id: string; title: string }>> {
  if (!eventId) return [];
  const { data } = await supabase
    .from('events_agenda_entries').select('id, title').eq('event_uuid', eventId).eq('entry_type', 'session').limit(1000);
  return (data ?? []).map((e) => ({ id: String(e.id), title: String(e.title ?? '') }));
}

export async function syncBatch(supabase, batch, log: (m: string) => void, enqueueJob?): Promise<{ adopted: number; flagged: number }> {
  const store = storeForNew(supabase, 'master');
  if (store.provider !== 's3') { log('sync-batches: VIDEO_S3_* is not configured'); return { adopted: 0, flagged: 0 }; }
  const cap = await maxFiles(supabase);
  const objects = await store.listPrefix(String(batch.prefix), cap + 50);
  const agenda = await agendaFor(supabase, batch.event_id && UUID_RE.test(batch.event_id) ? batch.event_id : null);
  const { data: known } = await supabase
    .from('video_assets').select('id, video_id, storage_path, import_path, etag').eq('batch_id', batch.id).limit(5000);
  const byPath = new Map((known ?? []).map((a) => [String(a.import_path ?? a.storage_path), a]));
  const flags: Array<{ path: string; note: string; at: string }> = Array.isArray(batch.flags) ? [...batch.flags] : [];
  const flaggedPaths = new Set(flags.map((f) => f.path));
  let adopted = 0; let flagged = 0;
  const now = new Date().toISOString();
  const addFlag = (path: string, note: string) => {
    if (flaggedPaths.has(path)) return;
    flags.push({ path, note, at: now }); flaggedPaths.add(path); flagged += 1;
  };

  let adoptedSoFar = Number(batch.adopted ?? 0);
  for (const o of objects) {
    const name = o.path.split('/').pop() ?? '';
    const ext = (name.match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase();
    const mime = MIME_BY_EXT[ext];
    const have = byPath.get(o.path);
    if (have) {
      if (o.etag && have.etag && o.etag !== have.etag) addFlag(o.path, 'a new version was uploaded after this file was adopted; the adopted master is unchanged');
      continue;
    }
    if (flaggedPaths.has(o.path)) continue;
    if (!mime) { addFlag(o.path, `not a video file (${ext || 'no extension'}); ignored`); continue; }
    if (!o.bytes || o.bytes < MIN_BATCH_FILE_BYTES) { addFlag(o.path, 'too small to be a recording; ignored'); continue; }
    if (o.bytes > MAX_BATCH_FILE_BYTES) { addFlag(o.path, 'over 8 GB; too large for the studio, ignored'); continue; }
    if (adoptedSoFar >= cap) { addFlag(o.path, `the batch has adopted ${cap} files, its limit; close it and open another`); break; }

    // Every adopted file costs a copy and a studio pass, so the bytes have
    // to look like what the name says before any of that happens.
    try {
      if (!looksLikeVideo(await store.readHead(o.path, 16), mime)) { addFlag(o.path, 'does not start like a video file; ignored'); continue; }
    } catch (err) {
      log(`batch ${batch.id}: ${logName(name)}: could not read the file head: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
      continue;
    }

    let videoId: string | null = null;
    try {
      const title = titleFromFilename(name) || name;
      const ins = await supabase.from('videos').insert({
        provider: 'gatewaze', provider_video_id: `batch-${globalThis.crypto.randomUUID()}`, url: '',
        title, kind: 'full', status: 'draft', publish_state: 'draft', visibility: 'private', is_external: false, source: 'batch-import',
      }).select('id').single();
      if (ins.error) throw new Error(ins.error.message);
      videoId = String(ins.data.id);
      const entry = agenda.length ? matchAgendaByTitle(title, agenda) : null;
      if (entry) {
        await supabase.from('video_subjects').insert({ video_id: videoId, subject_type: 'agenda_entry', subject_id: entry.id, source: 'auto', confidence: 0.8 });
      } else if (batch.event_id && UUID_RE.test(batch.event_id)) {
        await supabase.from('video_subjects').insert({ video_id: videoId, subject_type: 'event', subject_id: batch.event_id, source: 'auto' });
      }
      // The row first, as `uploading`, so the copy has a key with the asset
      // id in it; then the copy, conditional on the ETag the listing saw;
      // then ready. The unique index on (batch, import_path) means a second
      // sync racing this one fails here rather than adopting twice.
      const asset = await supabase.from('video_assets').insert({
        video_id: videoId, kind: 'master', storage_bucket: store.bucket, storage_provider: 's3', storage_path: 'pending',
        import_path: o.path, filename: name.slice(0, 255), mime_type: mime, bytes: o.bytes, etag: o.etag ?? null,
        state: 'uploading', source: 'batch_import', batch_id: batch.id, uploaded_by: batch.issued_to_user_id ?? null,
      }).select('id').single();
      if (asset.error) throw new Error(asset.error.message);
      const assetId = String(asset.data.id);
      const dest = `batch-import/${batch.id}/${assetId}/${sanitiseFilename(name)}`;
      try {
        await store.copy(o.path, dest, mime, o.etag);
      } catch (err) {
        // The asset row goes, so the file is tried again next tick (a
        // replaced file has a new ETag by then); the flag says what happened.
        await supabase.from('video_assets').delete().eq('id', assetId);
        throw new Error(`copy failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      }
      const promote = await supabase.from('video_assets').update({ state: 'ready', storage_path: dest, error: null }).eq('id', assetId);
      if (promote.error) throw new Error(promote.error.message);
      adopted += 1; adoptedSoFar += 1;
      byPath.set(o.path, { id: assetId, video_id: videoId, storage_path: dest, import_path: o.path, etag: o.etag });
      log(`batch ${batch.id}: adopted ${logName(name)} (${(o.bytes / 1048576).toFixed(0)} MB)${entry ? ` → ${logName(entry.title).slice(0, 60)}` : ''}`);

      // Straight into the studio, so the batch page fills in as files land.
      // Its own try: the file IS adopted by now, and a queue hiccup must not
      // read as a failed adoption. A studio row left queued can be started
      // from its page. BullMQ refuses a ':' in a custom job id.
      if (falConfigured() && enqueueJob) {
        try {
          const st = await supabase.from('video_studio').insert({
            video_id: videoId, master_asset_id: assetId, state: 'queued', progress: 'Queued', requested_by: batch.created_by ?? null,
          }).select('id').single();
          if (!st.error) await enqueueJob('jobs', 'videos:studio-analyse', { studio_id: st.data.id }, { jobId: `videos-studio-${st.data.id}` });
        } catch (err) {
          log(`batch ${batch.id}: ${logName(name)}: adopted, but the studio pass could not be queued: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
        }
      }
    } catch (err) {
      // No half-adopted video: the draft row and its subject go with the failure.
      if (videoId) await supabase.from('videos').delete().eq('id', videoId).catch(() => {});
      const msg = String((err as Error)?.message ?? err).slice(0, 160);
      // A transient failure (the copy, the queue) is logged and retried next
      // tick; a flag is only for something a person has to look at.
      if (/copy failed|PreconditionFailed|412/.test(msg)) log(`batch ${batch.id}: ${logName(name)}: ${msg}; will retry`);
      else addFlag(o.path, `could not adopt: ${msg}`);
      log(`batch ${batch.id}: ${logName(name)}: ${msg}`);
    }
  }

  await supabase.from('video_upload_batches').update({
    objects_seen: objects.length, adopted: Number(batch.adopted ?? 0) + adopted, flags: flags.slice(-MAX_FLAGS), last_synced_at: now,
  }).eq('id', batch.id);
  return { adopted, flagged };
}

export async function syncBatches(supabase, log: (m: string) => void, enqueueJob?, only?: string | null, opts: { final?: boolean } = {}): Promise<SyncResult> {
  const result: SyncResult = { batches: 0, adopted: 0, flagged: 0, expired: 0, revoked: 0 };
  // A final sweep names a batch that has just been closed; the cron takes
  // every open one.
  let q = supabase.from('video_upload_batches').select('*').limit(200);
  q = only && UUID_RE.test(only) ? q.eq('id', only) : q.eq('state', 'open');
  const { data: batches, error } = await q;
  if (error) throw new Error(error.message);
  for (const b of batches ?? []) {
    if (b.state !== 'open' && !opts.final) continue;
    result.batches += 1;
    if (b.state === 'open' && b.key_expires_at && Date.parse(b.key_expires_at) < Date.now()) {
      // One last sweep, then the batch is done.
      try {
        const r = await syncBatch(supabase, b, log, enqueueJob);
        result.adopted += r.adopted; result.flagged += r.flagged;
      } catch (err) {
        log(`batch ${b.id}: final sweep failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      }
      await supabase.from('video_upload_batches').update({ state: 'expired', closed_at: new Date().toISOString() }).eq('id', b.id).eq('state', 'open');
      if (await revoke(supabase, b, log)) result.revoked += 1;
      result.expired += 1;
      continue;
    }
    try {
      const r = await syncBatch(supabase, b, log, enqueueJob);
      result.adopted += r.adopted; result.flagged += r.flagged;
    } catch (err) {
      log(`batch ${b.id}: sync failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    }
  }

  // Keys that should be dead and are not: a close whose delete failed, an
  // expiry whose delete failed. Retried every tick until Backblaze agrees.
  if (!only) {
    const { data: stale } = await supabase
      .from('video_upload_batches').select('id, key_id').neq('state', 'open').not('key_id', 'is', null).is('key_revoked_at', null).limit(50);
    for (const b of stale ?? []) if (await revoke(supabase, b, log)) result.revoked += 1;
  }
  return result;
}

export default async function syncBatchesHandler(job, ctx): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[videos] ${m}`);
  const only = typeof job?.data?.batch_id === 'string' ? job.data.batch_id : null;
  const r = await syncBatches(supabase, log, ctx?.enqueueJob, only, { final: job?.data?.final === true });
  if (r.adopted || r.flagged || r.expired || r.revoked) log(`sync-batches: ${r.batches} swept, ${r.adopted} adopted, ${r.flagged} flagged, ${r.expired} expired, ${r.revoked} keys revoked`);
}
