/**
 * The store a Supabase bucket is served from on a brand that has moved off
 * Supabase Storage (storage module `supabase_alias`), or null when it has
 * not, or when the storage module is not here. Loaded at runtime for the
 * same reason as storage-adapter.ts: a brand without the storage module
 * must keep working. Throws when the alias is set but its provider is
 * unavailable, so nothing is written to Supabase by mistake.
 */

/** The parts of modules/storage's ObjectStore host-media uses. */
export interface ObjectStore {
  provider: string;
  bucket: string;
  publicUrl(path: string): string;
  put(path: string, body: Buffer, opts: { contentType: string; upsert?: boolean }): Promise<{ bytes: number }>;
  signRead(path: string, expiresSeconds: number, opts?: { forServer?: boolean }): Promise<string>;
  remove(paths: string[]): Promise<{ failed: string[] }>;
}

type BucketStoreModule = { aliasedBucketStore(supabase: unknown, bucket: string): Promise<ObjectStore | null> };

export async function movedBucketStore(supabase: unknown, bucket: string): Promise<ObjectStore | null> {
  let mod: BucketStoreModule;
  try {
    mod = (await import('../../storage/lib/bucket-store.js')) as BucketStoreModule;
  } catch {
    return null;
  }
  return mod.aliasedBucketStore(supabase, bucket);
}
