/**
 * Where event media lives, for every route in this module.
 *
 * Each host_media row records its provider and bucket (host-media
 * migration 016). This file turns a row into the store that holds it, and
 * says where new files go, through the storage module (modules/storage).
 * Without the storage module it falls back to a built-in Supabase store
 * that builds exactly the addresses this module built before, Bunny zone
 * included, and refuses any row kept elsewhere.
 *
 * Two kinds of address:
 *   browser   through the CDN (the Bunny zone in front of Supabase, or the
 *             provider's own domain), for galleries and the projector.
 *   direct    never through Bunny: what image models fetch, and what a
 *             guest saves (Bunny's Optimizer recompresses what it serves).
 */

import { browserObjectUrl, browserSizedUrl, type CdnConfig } from './cdn.js';

export interface Loc {
  storage_provider?: string | null;
  storage_bucket?: string | null;
}

/** The parts of the storage module's ObjectStore this module uses. */
export interface MediaStore {
  provider: string;
  bucket: string;
  /** True when sizedUrl returns a resized picture rather than the original. */
  canResize: boolean;
  publicUrl(path: string, opts?: { version?: string | number | null }): string;
  sizedUrl(path: string, size: { width: number; height?: number; fit?: 'contain' | 'cover'; quality?: number }, opts?: { version?: string | number | null }): string;
  put(path: string, body: Uint8Array, opts: { contentType: string; upsert?: boolean }): Promise<{ bytes: number }>;
  signUpload(path: string, opts: { contentType: string; bytes?: number; expiresSeconds?: number }): Promise<{ url: string; method: 'PUT'; headers: Record<string, string> }>;
  head(path: string): Promise<{ ok: boolean; bytes: number; contentType: string }>;
  remove(paths: string[]): Promise<{ failed: string[] }>;
}

interface Registry {
  storeForNew(opts: { purpose: string; supabaseBucket: string; cdn?: boolean }): Promise<MediaStore>;
  storeFor(row: Loc, fallbackBucket: string, opts?: { cdn?: boolean }): Promise<MediaStore>;
}

export interface MediaStorage {
  /** Where a new file goes. */
  forNew(): Promise<{ browser: MediaStore; direct: MediaStore }>;
  /** The stores holding a row's files. Throws when that provider is unavailable. */
  forRow(row: Loc): Promise<{ browser: MediaStore; direct: MediaStore }>;
  /** The columns to write on a new row for files put in this store. */
  columnsFor(store: MediaStore): { storage_provider?: string; storage_bucket?: string };
  /** One lookup per distinct location, for a page of rows. */
  forRows(rows: Loc[]): Promise<(row: Loc) => { browser: MediaStore; direct: MediaStore } | null>;
}

const keyOf = (row: Loc) => `${row.storage_provider || 'supabase'}|${row.storage_bucket || ''}`;

export function createMediaStorage(opts: {
  registry: Registry | null;
  fallback: { browser: MediaStore; direct: MediaStore };
  bucket: string;
  logger: { warn(msg: string, meta?: Record<string, unknown>): void };
}): MediaStorage {
  const { registry, fallback, bucket, logger } = opts;

  async function forRow(row: Loc) {
    if (!registry) {
      const provider = row.storage_provider || 'supabase';
      const b = row.storage_bucket || bucket;
      if (provider !== 'supabase' || b !== bucket) throw new Error(`media is in ${provider}/${b}, which needs the storage module`);
      return fallback;
    }
    const [browser, direct] = await Promise.all([
      registry.storeFor(row, bucket, { cdn: true }),
      registry.storeFor(row, bucket, { cdn: false }),
    ]);
    return { browser, direct };
  }

  return {
    async forNew() {
      if (!registry) return fallback;
      const [browser, direct] = await Promise.all([
        registry.storeForNew({ purpose: 'media', supabaseBucket: bucket, cdn: true }),
        registry.storeForNew({ purpose: 'media', supabaseBucket: bucket, cdn: false }),
      ]);
      return { browser, direct };
    },

    forRow,

    columnsFor(store) {
      // Files in the configured Supabase bucket leave both columns at their
      // defaults, so those rows look exactly as they always have.
      if (store.provider === 'supabase' && store.bucket === bucket) return {};
      return { storage_provider: store.provider, storage_bucket: store.bucket };
    },

    async forRows(rows) {
      const found = new Map<string, { browser: MediaStore; direct: MediaStore } | null>();
      for (const row of rows) {
        const k = keyOf(row);
        if (found.has(k)) continue;
        try {
          found.set(k, await forRow(row));
        } catch (err) {
          logger.warn('media store unavailable', { provider: row.storage_provider, bucket: row.storage_bucket, error: err instanceof Error ? err.message : String(err) });
          found.set(k, null);
        }
      }
      return (row: Loc) => found.get(keyOf(row)) ?? null;
    },
  };
}

/** The parts of the storage module's aliased store the fallback uses. */
type StorageStore = Pick<MediaStore, 'put' | 'signUpload' | 'head' | 'remove'>;

/** Minimal supabase-js storage surface. */
interface SupabaseLike {
  storage: {
    from(bucket: string): {
      upload(path: string, body: unknown, opts: Record<string, unknown>): Promise<{ error: { message: string } | null }>;
      remove(paths: string[]): Promise<{ error: { message: string } | null }>;
      createSignedUrl(path: string, expires: number): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
      createSignedUploadUrl(path: string): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
    };
  };
}

/**
 * The built-in Supabase stores: the addresses this module has always
 * built (lib/cdn.ts), and supabase-js for the rest.
 */
export function builtInSupabaseStores(opts: {
  supabase: SupabaseLike;
  bucket: string;
  publicSupabaseUrl: string;
  internalSupabaseUrl: string;
  cdn: CdnConfig;
}): { browser: MediaStore; direct: MediaStore } {
  const { supabase, bucket, publicSupabaseUrl, internalSupabaseUrl } = opts;
  const from = () => supabase.storage.from(bucket);
  const externalise = (url: string) =>
    internalSupabaseUrl && url.startsWith(internalSupabaseUrl) ? publicSupabaseUrl + url.slice(internalSupabaseUrl.length) : url;
  const v = (version: unknown, joiner: '?' | '&') =>
    version === undefined || version === null || version === '' ? '' : `${joiner}v=${encodeURIComponent(String(version))}`;

  // A brand that serves its Supabase buckets from another provider
  // (storage module `supabase_alias`) keeps its files there, so every
  // operation goes to that store. It is loaded at runtime because this
  // fallback is what runs when the storage module could not be loaded; then
  // there is no alias and supabase-js is used as before. An alias whose
  // provider is unavailable throws rather than writing to Supabase again.
  const moved = async (): Promise<StorageStore | null> => {
    let mod: { aliasedBucketStore(s: unknown, b: string): Promise<StorageStore | null> };
    try {
      mod = await import('../../storage/lib/bucket-store.js');
    } catch {
      return null;
    }
    return mod.aliasedBucketStore(supabase, bucket);
  };

  const make = (cdn: CdnConfig): MediaStore => ({
    provider: 'supabase',
    bucket,
    canResize: true,
    publicUrl: (path, o) => browserObjectUrl(cdn, publicSupabaseUrl, bucket, path) + v(o?.version, '?'),
    sizedUrl: (path, size, o) => browserSizedUrl(cdn, publicSupabaseUrl, bucket, path, size.width, size.quality ?? 80) + v(o?.version, '&'),
    async put(path, body, o) {
      const m = await moved();
      if (m) return m.put(path, body, { contentType: o.contentType, upsert: o.upsert === true });
      const { error } = await from().upload(path, body, { contentType: o.contentType, upsert: o.upsert === true });
      if (error) throw new Error(`storage upload failed: ${error.message}`);
      return { bytes: body.byteLength };
    },
    async signUpload(path, o) {
      const m = await moved();
      if (m) return m.signUpload(path, o);
      const { data, error } = await from().createSignedUploadUrl(path);
      if (error || !data?.signedUrl) throw new Error(`could not sign an upload: ${error?.message ?? 'no url'}`);
      return { url: externalise(data.signedUrl), method: 'PUT', headers: { 'content-type': o.contentType } };
    },
    async head(path) {
      try {
        const m = await moved();
        if (m) return await m.head(path);
        const { data } = await from().createSignedUrl(path, 60);
        if (!data?.signedUrl) return { ok: false, bytes: 0, contentType: '' };
        const r = await fetch(data.signedUrl, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
        if (!r.ok) return { ok: false, bytes: 0, contentType: '' };
        return { ok: true, bytes: Number(r.headers.get('content-length') ?? 0), contentType: String(r.headers.get('content-type') ?? '').split(';')[0]!.trim() };
      } catch {
        return { ok: false, bytes: 0, contentType: '' };
      }
    },
    async remove(paths) {
      if (!paths.length) return { failed: [] };
      try {
        const m = await moved();
        if (m) return await m.remove(paths);
        const { error } = await from().remove(paths);
        return { failed: error ? paths : [] };
      } catch {
        return { failed: paths };
      }
    },
  });
  // `direct` skips Bunny, never the brand's own storage origin.
  return { browser: make(opts.cdn), direct: make({ zone: null, storage: opts.cdn.storage }) };
}
