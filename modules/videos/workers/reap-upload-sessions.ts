// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * videos:reap-upload-sessions — close out abandoned uploads (spec §17.1).
 *
 * An editor who closes the tab mid-upload leaves a session `open` and an asset
 * `uploading` forever. Without this, the editor's own screen shows a file that
 * looks like it is still going, and `video_assets_one_master` keeps a slot
 * reserved by something that will never arrive.
 *
 * The existing `host-media:chunked-cleanup` cron is the cautionary example:
 * it marks rows `expired` but its index is partial on the live statuses, so
 * expired rows accumulate with no second reaper. This one deletes the stray
 * storage object too, because an abandoned 2GB upload is a real bill.
 *
 * It checks whether the object actually landed before giving up. A session can
 * expire between the last byte and the `complete` call, and in that case the
 * file is there and the right outcome is to finish the job, not bin it.
 */

import { MAX_BYTES, type UploadKind } from '../lib/upload-rules.js';

const BATCH = 50;

export interface ReapResult {
  completed: number;
  failed: number;
  bytes_removed: number;
}

export async function reapUploadSessions(
  supabase,
  log: (m: string) => void = () => {},
  now: Date = new Date(),
): Promise<ReapResult> {
  const nowIso = now.toISOString();

  const { data: stale, error } = await supabase
    .from('video_upload_sessions')
    .select('id, asset_id, storage_bucket, storage_path, expected_bytes, expected_mime')
    .eq('state', 'open')
    .lt('expires_at', nowIso)
    .limit(BATCH);
  if (error) {
    log(`stale session query failed: ${error.message}`);
    return { completed: 0, failed: 0, bytes_removed: 0 };
  }
  if (!stale?.length) return { completed: 0, failed: 0, bytes_removed: 0 };

  let completed = 0;
  let failed = 0;
  let bytesRemoved = 0;

  for (const s of stale) {
    const head = await headObject(supabase, s.storage_bucket, s.storage_path);

    // The bytes made it but `complete` never ran. Finish the job rather than
    // throwing away a successful upload over a timing race.
    //
    // The size cap is re-checked here, not just in `complete`. A security
    // review found the bypass: request a mint, PUT an oversized file to the
    // signed URL, never call `complete`, and this adoption path would mark it
    // ready at whatever size actually landed, bounded only by the bucket's
    // 5 GiB limit. A `short` is meant to cap at 500MB.
    const cap = await capForAsset(supabase, s.asset_id, s.expected_bytes);
    const withinCap = cap === null || head.bytes <= cap * 1.1;

    if (head.ok && head.bytes > 0 && withinCap && mimeMatches(head.contentType, s.expected_mime)) {
      await supabase
        .from('video_assets')
        .update({ state: 'ready', bytes: head.bytes, mime_type: head.contentType, error: null })
        .eq('id', s.asset_id)
        .eq('state', 'uploading');
      await supabase
        .from('video_upload_sessions')
        .update({ state: 'completed', completed_at: nowIso })
        .eq('id', s.id)
        .eq('state', 'open');
      completed += 1;
      log(`adopted a finished-but-unconfirmed upload for asset ${s.asset_id}`);
      continue;
    }

    // Nothing usable arrived. Remove whatever partial object exists so an
    // abandoned upload does not sit in the bucket being paid for.
    if (head.ok) {
      try {
        await supabase.storage.from(s.storage_bucket).remove([s.storage_path]);
        bytesRemoved += head.bytes;
      } catch {
        /* best effort */
      }
    }
    await supabase
      .from('video_assets')
      .update({
        state: 'failed',
        error: head.ok && head.bytes > 0 && !withinCap
          ? `uploaded file is ${(head.bytes / 1048576).toFixed(0)}MB, over the limit for its kind`
          : 'upload session expired before the file arrived',
      })
      .eq('id', s.asset_id)
      .eq('state', 'uploading');
    await supabase
      .from('video_upload_sessions')
      .update({ state: 'expired' })
      .eq('id', s.id)
      .eq('state', 'open');
    failed += 1;
  }

  log(
    `reap-upload-sessions: ${completed} adopted, ${failed} expired` +
    `${bytesRemoved ? `, ${(bytesRemoved / 1048576).toFixed(1)}MB removed` : ''}`,
  );
  return { completed, failed, bytes_removed: bytesRemoved };
}

/**
 * The byte ceiling for an asset, from its kind.
 *
 * Falls back to the session's own `expected_bytes` when the asset row has
 * gone, and returns null only when neither is knowable, in which case the
 * bucket's 5 GiB limit is the backstop.
 */
async function capForAsset(
  supabase,
  assetId: string,
  expectedBytes: number | null | undefined,
): Promise<number | null> {
  const { data } = await supabase.from('video_assets').select('kind').eq('id', assetId).maybeSingle();
  const kind = String(data?.kind ?? '') as UploadKind;
  if (kind && MAX_BYTES[kind]) return MAX_BYTES[kind];
  const expected = Number(expectedBytes);
  return Number.isFinite(expected) && expected > 0 ? expected : null;
}

/** Tolerant comparison: storage may normalise or omit parameters. */
function mimeMatches(stored: string, expected: string | null | undefined): boolean {
  if (!stored) return false;
  if (!expected) return true;
  return stored.toLowerCase().split(';')[0].trim() === String(expected).toLowerCase().split(';')[0].trim();
}

async function headObject(
  supabase,
  bucket: string,
  path: string,
): Promise<{ ok: boolean; bytes: number; contentType: string }> {
  try {
    const signed = await supabase.storage.from(bucket).createSignedUrl(path, 60);
    if (signed.error || !signed.data?.signedUrl) return { ok: false, bytes: 0, contentType: '' };
    const r = await fetch(signed.data.signedUrl, { method: 'HEAD' });
    if (!r.ok) return { ok: false, bytes: 0, contentType: '' };
    return {
      ok: true,
      bytes: Number(r.headers.get('content-length') ?? 0),
      contentType: String(r.headers.get('content-type') ?? '').split(';')[0].trim(),
    };
  } catch {
    return { ok: false, bytes: 0, contentType: '' };
  }
}

export default async function reapUploadSessionsHandler(_job, ctx): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const log = (m: string) => (ctx?.logger?.info ?? console.log)(`[videos] ${m}`);
  await reapUploadSessions(supabase, log);
}
