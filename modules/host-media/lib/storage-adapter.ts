/**
 * host-media's MediaAdapter on top of the storage module (modules/storage).
 *
 * New uploads go to whichever provider the storage module chooses for the
 * `media` purpose (Supabase unless a brand sets otherwise), and the route
 * records that provider and bucket on the row. Every later read, signed URL
 * and delete goes to the store the row names.
 *
 * The storage module is loaded at runtime, not imported, because the live
 * module tree only holds installed modules: a brand that has not installed
 * `storage` must keep working. loadStorageRegistry returns null in that
 * case and register-routes keeps its built-in Supabase adapter.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitiseFilename } from './storage-paths.js';
import type { MediaAdapter, StorageLocation } from '../api/routes.js';

/** The parts of modules/storage's ObjectStore this adapter uses. */
interface Store {
  provider: string;
  bucket: string;
  publicUrl(path: string): string;
  sizedUrl(path: string, size: { width: number; fit?: 'contain' | 'cover'; quality?: number }): string;
  put(path: string, body: Buffer, opts: { contentType: string; upsert?: boolean }): Promise<{ bytes: number }>;
  signRead(path: string, expiresSeconds: number, opts?: { forServer?: boolean }): Promise<string>;
  remove(paths: string[]): Promise<{ failed: string[] }>;
}

/** The parts of modules/storage's StorageRegistry this adapter uses. */
export interface Registry {
  storeForNew(opts: { purpose: string; supabaseBucket: string }): Promise<Store>;
  storeFor(row: StorageLocation, fallbackBucket: string): Promise<Store>;
}

/**
 * `supabaseBucket` is the Supabase bucket for new files and for rows from
 * before migration 016 (HOST_MEDIA_BUCKET, normally `media`).
 */
export function createStorageMediaAdapter(registry: Registry, supabaseBucket = 'media'): MediaAdapter {
  const storeFor = (loc?: StorageLocation) => registry.storeFor(loc ?? {}, supabaseBucket);
  return {
    async upload(args) {
      // Slugified at the upload boundary so the path, and every address
      // built from it, is URL-safe. Mail clients will not load an <img src>
      // with literal spaces the way browsers do.
      const path = `${args.hostKind}/${args.hostId}/${args.mediaId}/${sanitiseFilename(args.filename)}`;
      const store = await registry.storeForNew({ purpose: 'media', supabaseBucket });
      await store.put(path, args.buffer, { contentType: args.mimeType, upsert: false });
      // Files in host-media's own Supabase bucket leave both columns at
      // their defaults, so those rows look exactly as they always have.
      const isDefault = store.provider === 'supabase' && store.bucket === supabaseBucket;
      return {
        storagePath: path,
        cdnUrl: store.publicUrl(path),
        ...(isDefault ? {} : { storageProvider: store.provider, storageBucket: store.bucket }),
      };
    },
    async delete(storagePath, loc) {
      const { failed } = await (await storeFor(loc)).remove([storagePath]);
      if (failed.length) throw new Error(`storage delete failed: ${failed.join(', ')}`);
    },
    async getPublicUrl(storagePath, loc) {
      return (await storeFor(loc)).publicUrl(storagePath);
    },
    async getRenderUrl(storagePath, width, loc) {
      return (await storeFor(loc)).sizedUrl(storagePath, { width, fit: 'contain', quality: 80 });
    },
    async createSignedUrl(storagePath, ttlSeconds, loc, opts) {
      return (await storeFor(loc)).signRead(storagePath, ttlSeconds, opts);
    },
  };
}

/**
 * The adapter to use: the storage module's when it can be loaded, else the
 * built-in one. Resolved once, on first use, because route registration is
 * synchronous and the storage module is loaded with a dynamic import.
 */
export function lazyMediaAdapter(load: () => Promise<MediaAdapter | null>, fallback: MediaAdapter, fallbackBucket = 'media'): MediaAdapter {
  let chosen: Promise<MediaAdapter> | null = null;
  const safeFallback = supabaseOnly(fallback, fallbackBucket);
  const pick = () => (chosen ??= load().then((a) => a ?? safeFallback, () => safeFallback));
  return {
    upload: async (args) => (await pick()).upload(args),
    delete: async (path, loc) => (await pick()).delete(path, loc),
    getPublicUrl: async (path, loc) => (await pick()).getPublicUrl(path, loc),
    getRenderUrl: async (path, width, loc) => {
      const a = await pick();
      return a.getRenderUrl ? a.getRenderUrl(path, width, loc) : a.getPublicUrl(path, loc);
    },
    createSignedUrl: async (path, ttl, loc, opts) => (await pick()).createSignedUrl(path, ttl, loc, opts),
  };
}

/**
 * The built-in adapter only knows the one Supabase bucket. A row kept
 * anywhere else is refused, not read from Supabase under the same path,
 * which would be the wrong file or none.
 */
export function supabaseOnly(adapter: MediaAdapter, bucket: string): MediaAdapter {
  const check = (loc?: StorageLocation) => {
    const provider = loc?.storage_provider || 'supabase';
    const b = loc?.storage_bucket || bucket;
    if (provider !== 'supabase' || b !== bucket) {
      throw new Error(`media is in ${provider}/${b}, which needs the storage module`);
    }
  };
  return {
    upload: (args) => adapter.upload(args),
    delete: async (path, loc) => { check(loc); return adapter.delete(path, loc); },
    getPublicUrl: async (path, loc) => { check(loc); return adapter.getPublicUrl(path, loc); },
    getRenderUrl: async (path, width, loc) => {
      check(loc);
      return adapter.getRenderUrl ? adapter.getRenderUrl(path, width, loc) : adapter.getPublicUrl(path, loc);
    },
    createSignedUrl: async (path, ttl, loc, opts) => { check(loc); return adapter.createSignedUrl(path, ttl, loc, opts); },
  };
}

/** modules/storage/lib/registry, looked for beside this module and in the clone cache. */
export function registryCandidates(): string[] {
  const out: string[] = [];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const ext of ['ts', 'js']) {
      const sibling = resolve(here, '..', '..', 'storage', 'lib', `registry.${ext}`);
      if (existsSync(sibling)) out.push(sibling);
    }
    const cacheRoot = resolve(here, '..', '..', '..', '..');
    if (existsSync(cacheRoot)) {
      for (const ent of readdirSync(cacheRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        for (const ext of ['ts', 'js']) {
          const c = resolve(cacheRoot, ent.name, 'modules', 'storage', 'lib', `registry.${ext}`);
          if (existsSync(c) && !out.includes(c)) out.push(c);
        }
      }
    }
  } catch {
    // best effort
  }
  return out;
}

export async function loadStorageRegistry(deps: {
  supabase: unknown;
  logger: { warn(msg: string, meta?: Record<string, unknown>): void };
}): Promise<Registry | null> {
  for (const candidate of registryCandidates()) {
    try {
      const mod = (await import(candidate)) as { createStorageRegistry?: (d: unknown) => Registry };
      if (typeof mod.createStorageRegistry === 'function') {
        return mod.createStorageRegistry({ supabase: deps.supabase, logger: deps.logger });
      }
    } catch (err) {
      deps.logger.warn('[host-media] could not load the storage module', { candidate, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return null;
}
