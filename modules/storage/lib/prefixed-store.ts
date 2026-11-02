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

import { storageKey } from './public-url.js';
import type { ObjectStore } from './types.js';

export function prefixedStore(inner: ObjectStore, supabaseBucket: string): ObjectStore {
  const prefix = storageKey(supabaseBucket, '');
  const k = (path: string) => prefix + path;
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
      const r = await inner.remove(paths.map(k));
      return { failed: r.failed.map(strip) };
    },
    async list(folder, max) {
      const out = await inner.list(k(folder), max);
      return out.map((e) => ({ ...e, path: strip(e.path) }));
    },
    copy: (from, to, opts) => inner.copy(k(from), k(to), opts),
    readRange: (path, bytes) => inner.readRange(k(path), bytes),
  };
}
