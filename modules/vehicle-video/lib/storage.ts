/**
 * Storage helpers for the single canonical `media` bucket (spec-relative-storage
 * -paths). All Vehicle Video objects live under `vehicle-video/<runId>/…`.
 * Paths stored on rows are keys RELATIVE to the bucket.
 */

import { VehicleVideoError } from './errors.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supabase = any;

const BUCKET = process.env.HOST_MEDIA_BUCKET ?? 'media';

export function runPrefix(runId: string): string {
  return `vehicle-video/${runId}`;
}

export function publicUrl(storagePath: string): string {
  const base = (process.env.SUPABASE_PUBLIC_URL ?? process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  return `${base}/storage/v1/object/public/${BUCKET}/${storagePath}`;
}

/** Upload a buffer to the media bucket; returns the storage path (bucket-relative). */
export async function uploadBuffer(
  supabase: Supabase,
  storagePath: string,
  buffer: Buffer | Uint8Array,
  contentType: string,
): Promise<string> {
  const { error } = await supabase.storage.from(BUCKET).upload(storagePath, buffer, {
    contentType,
    upsert: true,
  });
  if (error) {
    throw new VehicleVideoError('STORAGE_FAILED', 'finalize', `upload ${storagePath}: ${error.message}`);
  }
  return storagePath;
}

/** Download a stored object as a Buffer. */
export async function downloadBuffer(supabase: Supabase, storagePath: string): Promise<Buffer> {
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
  if (error || !data) {
    throw new VehicleVideoError('STORAGE_FAILED', 'finalize', `download ${storagePath}: ${error?.message ?? 'no data'}`);
  }
  const arrayBuffer = await (data as Blob).arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** Remove every object under a run's prefix (best-effort; used on delete). */
export async function removeRun(supabase: Supabase, runId: string): Promise<void> {
  const prefix = runPrefix(runId);
  const dirs = ['photos', 'clips', 'audio', ''];
  for (const d of dirs) {
    const path = d ? `${prefix}/${d}` : prefix;
    const { data } = await supabase.storage.from(BUCKET).list(path);
    if (Array.isArray(data) && data.length) {
      const keys = data
        .filter((f: { name: string }) => f.name)
        .map((f: { name: string }) => `${path}/${f.name}`);
      if (keys.length) await supabase.storage.from(BUCKET).remove(keys);
    }
  }
}
