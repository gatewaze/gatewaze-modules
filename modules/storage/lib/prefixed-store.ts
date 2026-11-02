/**
 * A Supabase bucket kept inside another provider's bucket.
 *
 * When a brand moves off Supabase Storage (storage config
 * `supabase_alias`), every Supabase bucket is copied into the provider's one
 * bucket: the `media` bucket at the root, every other bucket under
 * `<bucket>/`. This store keeps the Supabase names (provider 'supabase', the
 * Supabase bucket) so rows and paths written before the move still mean the
 * same file, and puts the bytes in the provider under the prefix.
 */

import { isPrivateStorageKey, PRIVATE_BUCKETS, storageKey } from './public-url.js';
import type { ObjectStore } from './types.js';

/** Private Supabase buckets; see lib/public-url.ts. Kept as an export for callers of this file. */
export const PRIVATE_BUCKET_PREFIXES = PRIVATE_BUCKETS;

/**
 * Their files sit under these folders in the provider bucket, so a `media`
 * path starting with one of them would reach a private file through the
 * media store (and its public address). Refused.
 */
function assertNotPrivate(path: string): void {
  if (isPrivateStorageKey('media', path)) {
    throw new Error(`not a media path: ${path.replace(/^\/+/, '').split('/')[0]}/ is a private bucket`);
  }
}

export function prefixedStore(inner: ObjectStore, supabaseBucket: string): ObjectStore {
  const prefix = storageKey(supabaseBucket, '');
  const k = (path: string) => {
    if (!prefix) assertNotPrivate(path);
    return prefix + path;
  };
  const strip = (key: string) => (prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key);

  return {
    provider: 'supabase',
    bucket: supabaseBucket,
    get canResize() {
      return inner.canResize;
    },
    publicUrl: (path, opts) => inner.publicUrl(k(path), opts),
    sizedUrl: (path, size, opts) => inner.sizedUrl(k(path), size, opts),
    put: (path, body, opts) => inner.put(k(path), body, opts),
    signUpload: (path, opts) => inner.signUpload(k(path), opts),
    signRead: (path, expires, opts) => inner.signRead(k(path), expires, opts),
    head: (path) => inner.head(k(path)),
    async remove(paths) {
      const ok: string[] = [];
      const failed: string[] = [];
      for (const p of paths) {
        try { ok.push(k(p)); } catch { failed.push(p); }
      }
      const r = ok.length ? await inner.remove(ok) : { failed: [] };
      return { failed: [...failed, ...r.failed.map(strip)] };
    },
    async list(folder, max) {
      const out = await inner.list(k(folder), max);
      // Listing media from the root must not show the private folders.
      return out
        .map((e) => ({ ...e, path: strip(e.path) }))
        .filter((e) => prefix || !isPrivateStorageKey('media', e.path));
    },
    copy: (from, to, opts) => inner.copy(k(from), k(to), opts),
    readRange: (path, bytes) => inner.readRange(k(path), bytes),
  };
}
