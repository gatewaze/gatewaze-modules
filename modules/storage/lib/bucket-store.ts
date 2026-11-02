/**
 * One storage registry per process, for module code that used to call
 * supabase.storage.from(bucket) directly.
 *
 * aliasedBucketStore(supabase, bucket) returns the store a Supabase bucket
 * is now served from when the brand has moved off Supabase Storage (storage
 * module setting `supabase_alias`), and null when it has not. On null the
 * caller keeps its own supabase-js code, so a brand still on Supabase
 * behaves exactly as it did before this file existed.
 *
 * When the alias is set but its provider cannot be reached, the call
 * throws. Writing to Supabase instead would put the file where the brand no
 * longer reads from.
 *
 * Server code only, like the rest of this module.
 */

import { createStorageRegistry, type StorageClient, type StorageRegistry } from './registry.js';
import type { ObjectStore } from './types.js';

let shared: StorageRegistry | null = null;

/** The process's registry, created on first use with the caller's service-role client. */
export function sharedStorageRegistry(supabase: unknown): StorageRegistry {
  shared ??= createStorageRegistry({
    supabase: supabase as StorageClient,
    logger: { warn: (msg, meta) => console.warn(msg, meta ?? '') },
  });
  return shared;
}

/** For tests: replace (or clear, with null) the process's registry. */
export function setSharedStorageRegistry(registry: StorageRegistry | null): void {
  shared = registry;
}

/**
 * The aliased store for a Supabase bucket, or null when the brand still
 * serves that bucket from Supabase itself.
 */
export async function aliasedBucketStore(supabase: unknown, bucket: string): Promise<ObjectStore | null> {
  const registry = sharedStorageRegistry(supabase);
  const store = await registry.bucketStore(bucket);
  // Without an alias, bucketStore hands back the registry's own Supabase
  // store for the bucket, the same object supabase(bucket) returns.
  return store === registry.supabase(bucket) ? null : store;
}

/**
 * The whole object, read through a short signed address. Works for private
 * buckets too, which are never read through the public domain.
 */
export async function downloadObject(store: ObjectStore, path: string, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<Buffer> {
  const url = await store.signRead(path, 120, { forServer: true });
  const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
  if (!res.ok) throw new Error(`storage read failed: HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (opts.maxBytes && declared > opts.maxBytes) throw new Error('object is over the size limit');
  if (!opts.maxBytes || !res.body) return Buffer.from(await res.arrayBuffer());
  // Counted as it arrives, so a body without a length cannot fill memory.
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > opts.maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('object is over the size limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
