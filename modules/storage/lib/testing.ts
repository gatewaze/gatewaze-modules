/**
 * Test doubles for modules that use bucket-store.ts. Not used at runtime.
 *
 * aliasedTestRegistry() is a registry whose every Supabase bucket is served
 * from one recording store under the prefix rule (media at the root, other
 * buckets under <bucket>/), with addresses on https://media.test.
 * supabaseTestRegistry() is one with no alias, so aliasedBucketStore()
 * returns null and callers keep their supabase-js code.
 */

import { prefixedStore } from './prefixed-store.js';
import { SUPABASE, type StorageRegistry } from './registry.js';
import type { ObjectStore } from './types.js';

export interface StoreCall {
  op: string;
  key: string;
  body?: unknown;
  opts?: unknown;
}

export function recordingObjectStore(opts: { origin?: string; objects?: Record<string, Buffer> } = {}) {
  const origin = opts.origin ?? 'https://media.test';
  const objects = new Map<string, Buffer>(Object.entries(opts.objects ?? {}));
  const calls: StoreCall[] = [];
  const store: ObjectStore = {
    provider: 'r2',
    bucket: 'brand-media',
    canResize: true,
    publicUrl: (p) => `${origin}/${p}`,
    sizedUrl: (p, s) => `${origin}/cdn-cgi/image/width=${s.width}/${p}`,
    async put(p, body, o) {
      calls.push({ op: 'put', key: p, body, opts: o });
      const buf = Buffer.isBuffer(body) ? body : body instanceof Uint8Array ? Buffer.from(body) : Buffer.from('');
      objects.set(p, buf);
      return { bytes: buf.byteLength };
    },
    async signUpload(p) {
      calls.push({ op: 'signUpload', key: p });
      return { url: `https://s3.test/${p}?sig`, method: 'PUT', headers: {} };
    },
    async signRead(p) {
      calls.push({ op: 'signRead', key: p });
      return `https://s3.test/${p}?sig`;
    },
    async head(p) {
      const b = objects.get(p);
      return b ? { ok: true, bytes: b.byteLength, contentType: 'application/octet-stream' } : { ok: false, bytes: 0, contentType: '' };
    },
    async remove(ps) {
      for (const p of ps) {
        calls.push({ op: 'remove', key: p });
        objects.delete(p);
      }
      return { failed: [] };
    },
    async list(prefix, max = 2000) {
      calls.push({ op: 'list', key: prefix });
      return [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .slice(0, max)
        .map(([k, v]) => ({ path: k, bytes: v.byteLength }));
    },
    async copy(a, b) {
      calls.push({ op: 'copy', key: `${a}->${b}` });
      const v = objects.get(a);
      if (v) objects.set(b, v);
    },
    async readRange(p, n) {
      calls.push({ op: 'readRange', key: p });
      return (objects.get(p) ?? Buffer.from('')).subarray(0, n);
    },
  };
  return { store, calls, objects };
}

/** Supabase's own store in an aliased registry: present, never what bucketStore returns. */
function notSupabase(bucket: string): ObjectStore {
  const fail = async (): Promise<never> => {
    throw new Error('test registry: wrote to Supabase while the alias is set');
  };
  return {
    provider: SUPABASE,
    bucket,
    canResize: false,
    publicUrl: (p) => `https://supabase.test/storage/v1/object/public/${bucket}/${p}`,
    sizedUrl: (p) => `https://supabase.test/storage/v1/object/public/${bucket}/${p}`,
    put: fail,
    signUpload: fail,
    signRead: fail,
    head: fail,
    remove: fail,
    list: fail,
    copy: fail,
    readRange: fail,
  };
}

/** Every Supabase bucket served from one recording store. */
export function aliasedTestRegistry(opts: { origin?: string; objects?: Record<string, Buffer> } = {}) {
  const inner = recordingObjectStore(opts);
  const byBucket = new Map<string, ObjectStore>();
  const registry: StorageRegistry = {
    async bucketStore(bucket) {
      let s = byBucket.get(bucket);
      if (!s) {
        s = prefixedStore(inner.store, bucket);
        byBucket.set(bucket, s);
      }
      return s;
    },
    supabase: notSupabase,
    async storeFor(_row, fallback = 'media') {
      return registry.bucketStore(fallback);
    },
    async storeForNew(o = {}) {
      return registry.bucketStore(o.supabaseBucket ?? 'media');
    },
  };
  return { registry, ...inner };
}

/** No alias: bucketStore(b) is the registry's own Supabase store, so callers get null. */
export function supabaseTestRegistry(): StorageRegistry {
  const stores = new Map<string, ObjectStore>();
  const supabase = (bucket: string): ObjectStore => {
    let s = stores.get(bucket);
    if (!s) {
      s = { ...recordingObjectStore().store, provider: SUPABASE, bucket };
      stores.set(bucket, s);
    }
    return s;
  };
  return {
    supabase,
    async bucketStore(bucket) {
      return supabase(bucket);
    },
    async storeFor(_row, fallback = 'media') {
      return supabase(fallback);
    },
    async storeForNew(o = {}) {
      return supabase(o.supabaseBucket ?? 'media');
    },
  };
}
