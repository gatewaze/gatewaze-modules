/**
 * Promo kit files in the `media` bucket: Supabase Storage, or the provider
 * the brand serves its Supabase buckets from (storage module
 * `supabase_alias`). Without the alias these are the supabase-js calls the
 * worker always made.
 */

import { aliasedBucketStore, downloadObject } from '../../../storage/lib/bucket-store.js';

export const MEDIA_BUCKET = 'media';

/** Writes (overwriting) one file. Throws with the storage error message. */
export async function putMedia(supabase, path: string, body: Buffer, opts: { contentType: string; noCache?: boolean }): Promise<void> {
  const moved = await aliasedBucketStore(supabase, MEDIA_BUCKET);
  if (moved) {
    await moved.put(path, body, { contentType: opts.contentType, upsert: true, ...(opts.noCache ? { cacheControl: 'max-age=0' } : {}) });
    return;
  }
  const { error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(path, body, { contentType: opts.contentType, ...(opts.noCache ? { cacheControl: '0' } : {}), upsert: true });
  if (error) throw new Error(error.message);
}

/** One file's bytes, or null when it is not there. */
export async function downloadMedia(supabase, path: string, maxBytes?: number): Promise<Buffer | null> {
  const moved = await aliasedBucketStore(supabase, MEDIA_BUCKET);
  if (moved) {
    try {
      return await downloadObject(moved, path, { maxBytes });
    } catch {
      return null;
    }
  }
  const { data } = await supabase.storage.from(MEDIA_BUCKET).download(path);
  if (!data) return null;
  return Buffer.from(await data.arrayBuffer());
}
