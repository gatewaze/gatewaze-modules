// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * Where the studio keeps its working pictures, and how it gets the master.
 *
 * Working pictures (sampled cut-outs, slide panels, the filmstrip, the
 * approved thumbnail) go to Supabase's public `media` bucket under
 * `video-studio/<video>/<studio>/`, the same bucket every thumbnail lives
 * in: the admin needs to show them without a signed URL per image, and
 * none of them is the recording. The master is read from wherever its asset
 * row says it is, streamed to a temp file for ffmpeg, and deleted after.
 */

import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeFor, externalise, assertSafeKey } from './storage.js';
import { aliasedBucketStore, downloadObject } from '../../storage/lib/bucket-store.js';
import { storagePublicConfig, storagePublicUrl } from '../../storage/lib/public-url.js';

export const MEDIA_BUCKET = 'media';
export const STUDIO_PREFIX = 'video-studio';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The folder one studio pass writes into. Both ids are checked to be uuids before they reach a key. */
export function studioFolder(videoId: string, studioId: string): string {
  if (!UUID_RE.test(videoId) || !UUID_RE.test(studioId)) throw new Error('bad studio ids');
  return `${STUDIO_PREFIX}/${videoId}/${studioId}`;
}

export async function putMedia(supabase, path: string, bytes: Buffer, contentType: string): Promise<string> {
  const key = assertSafeKey(path);
  const moved = await aliasedBucketStore(supabase, MEDIA_BUCKET);
  if (moved) {
    await moved.put(key, bytes, { contentType, upsert: true });
    return key;
  }
  const up = await supabase.storage.from(MEDIA_BUCKET).upload(key, bytes, { contentType, upsert: true });
  if (up.error) throw new Error(`media upload failed: ${up.error.message}`);
  return key;
}

export async function getMedia(supabase, path: string): Promise<Buffer> {
  const moved = await aliasedBucketStore(supabase, MEDIA_BUCKET);
  if (moved) return downloadObject(moved, assertSafeKey(path));
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).download(assertSafeKey(path));
  if (error || !data) throw new Error(`media download failed: ${error?.message ?? 'no data'}`);
  return Buffer.from(await data.arrayBuffer());
}

/** The browser-reachable URL of a media object. */
export function mediaUrl(supabase, path: string): string {
  // A brand that has moved off Supabase Storage serves media from its own origin.
  const moved = storagePublicUrl(storagePublicConfig(process.env), MEDIA_BUCKET, assertSafeKey(path));
  if (moved) return moved;
  const { data } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(assertSafeKey(path));
  return externalise(String(data?.publicUrl ?? ''));
}

/** Remove everything a studio pass wrote, best effort. */
export async function removeStudioFolder(supabase, videoId: string, studioId: string): Promise<void> {
  try {
    const folder = studioFolder(videoId, studioId);
    const moved = await aliasedBucketStore(supabase, MEDIA_BUCKET);
    if (moved) {
      // One level, as the Supabase listing below.
      const names = (await moved.list(`${folder}/`, 1000)).map((e) => e.path).filter((p) => p.lastIndexOf('/') === folder.length);
      if (names.length) await moved.remove(names);
      return;
    }
    const { data } = await supabase.storage.from(MEDIA_BUCKET).list(folder, { limit: 1000 });
    const names = (data ?? []).map((e) => `${folder}/${e.name}`);
    if (names.length) await supabase.storage.from(MEDIA_BUCKET).remove(names);
  } catch {
    /* best effort */
  }
}

export interface LocalMaster { path: string; bytes: number; dispose: () => Promise<void> }

/**
 * Stream a master to a temp file. Capped, because the worker's disk is not
 * the bucket's: a master over the cap is refused with a clear message
 * rather than filling the pod.
 */
export async function downloadMaster(supabase, asset: { storage_provider?: string | null; storage_bucket: string; storage_path: string; bytes?: number | null }, maxBytes: number): Promise<LocalMaster> {
  if (asset.bytes && asset.bytes > maxBytes) {
    throw new Error(`master is ${(asset.bytes / 1073741824).toFixed(1)} GB, over the ${(maxBytes / 1073741824).toFixed(0)} GB studio limit`);
  }
  const store = storeFor(supabase, asset);
  const url = await store.signRead(asset.storage_path, 6 * 3600);
  const dir = await mkdtemp(join(tmpdir(), 'studio-master-'));
  const path = join(dir, 'master' + (asset.storage_path.match(/\.[a-z0-9]{2,5}$/i)?.[0] ?? '.mp4'));
  const res = await fetch(url, { signal: AbortSignal.timeout(4 * 3600 * 1000) });
  if (!res.ok || !res.body) { await rm(dir, { recursive: true, force: true }); throw new Error(`master download ${res.status}`); }
  let total = 0;
  const counted = Readable.fromWeb(res.body);
  counted.on('data', (c: Buffer) => {
    total += c.length;
    if (total > maxBytes) counted.destroy(new Error('master exceeded the studio size limit while downloading'));
  });
  try {
    await pipeline(counted, createWriteStream(path));
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  const s = await stat(path);
  return { path, bytes: s.size, dispose: () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
}
