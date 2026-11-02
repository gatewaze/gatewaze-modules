/**
 * Which store a file goes to, and which store an existing file is in.
 *
 * Providers:
 *   supabase   built in, always available.
 *   <id>       from the storage-<id> module (e.g. storage-r2), which must be
 *              installed and enabled, and fully configured.
 *
 * The provider for NEW files is, first match wins:
 *   1. env STORAGE_PROVIDER_<PURPOSE> (e.g. STORAGE_PROVIDER_MEDIA=r2)
 *   2. env STORAGE_PROVIDER
 *   3. the storage module's config `default_provider`
 *   4. supabase
 * When the chosen provider is not enabled or not configured, new files go to
 * Supabase and a warning is logged once. Supabase always works, and the row
 * records where each file went, so nothing is lost by falling back.
 *
 * An EXISTING file's store comes from its row (`storage_provider`,
 * `storage_bucket`) and nothing else. If that provider is unavailable the
 * call fails: reading another bucket would return the wrong file, or none.
 *
 * A brand that has moved off Supabase Storage sets the storage module's
 * config `supabase_alias` (or env STORAGE_SUPABASE_ALIAS) to a provider id.
 * Every Supabase bucket is then served from that provider's bucket, `media`
 * at the root and every other bucket under `<bucket>/` (lib/prefixed-store),
 * so code and rows that still say "Supabase bucket b, path p" reach the same
 * file with no change. bucketStore(b) is the call for code that used to say
 * supabase.storage.from(b).
 *
 * Provider settings come from env first, then the provider module's row in
 * installed_modules (secrets sealed with GATEWAZE_SECRETS_KEY). Config rows
 * are cached for a minute, so a change in the admin takes effect within one.
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidBucket } from './keys.js';
import { prefixedStore } from './prefixed-store.js';
import { supabaseSettingsFromEnv, supabaseStore, type SupabaseStorageClient } from './supabase-store.js';
import type { ObjectStore, StorageProviderId, StorageProviderModule } from './types.js';

export const SUPABASE: StorageProviderId = 'supabase';
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;
const PURPOSE = /^[a-z0-9_]{1,40}$/;
const CONFIG_TTL_MS = 60_000;

/** Minimal installed_modules reader, so this file needs no supabase-js types. */
export interface ConfigReader {
  from(table: string): {
    select(cols: string): {
      in(col: string, values: string[]): PromiseLike<{ data: Array<{ id: string; status?: string | null; config?: Record<string, unknown> | null }> | null; error: { message: string } | null }>;
    };
  };
}

export type StorageClient = SupabaseStorageClient & ConfigReader;

export interface Logger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

export interface StorageRegistryDeps {
  /** A service-role client: it writes to storage and reads installed_modules. */
  supabase: StorageClient;
  env?: Record<string, string | undefined>;
  logger?: Logger;
  /** For tests. Defaults to loading storage-<id>/lib/provider from disk. */
  loadProvider?: (id: StorageProviderId) => Promise<StorageProviderModule>;
  now?: () => number;
}

export interface StoredRow {
  storage_provider?: string | null;
  storage_bucket?: string | null;
}

/**
 * `cdn: true` puts the Bunny pull zone (when configured) in front of
 * Supabase addresses. Off by default: addresses that end up in sent email
 * or stored page data should not depend on a CDN account staying paid.
 * Other providers ignore it; their public address is already their CDN.
 */
export interface DeliveryOptions {
  cdn?: boolean;
}

export interface ReadOptions extends DeliveryOptions {
  /**
   * Other Supabase buckets a row may name besides fallbackBucket. Anything
   * else is refused: the row decides which bucket the service role reads,
   * signs and deletes in, so it must not be able to name an arbitrary one.
   */
  supabaseBuckets?: string[];
}

export interface StorageRegistry {
  /** The store new files of this purpose go to. Never throws for config problems; falls back to Supabase. */
  storeForNew(opts?: { purpose?: string; supabaseBucket?: string } & DeliveryOptions): Promise<ObjectStore>;
  /** The store an existing row's file is in. Throws StorageUnavailableError when that provider is unavailable. */
  storeFor(row: StoredRow, fallbackBucket?: string, opts?: ReadOptions): Promise<ObjectStore>;
  /** Supabase's store for a bucket, without any lookup. Ignores supabase_alias. */
  supabase(bucket: string, opts?: DeliveryOptions): ObjectStore;
  /**
   * The store for what was a Supabase bucket: Supabase itself, or the
   * provider named by supabase_alias with the bucket's prefix. Throws
   * StorageUnavailableError when the alias provider is unavailable, rather
   * than quietly writing to Supabase again.
   */
  bucketStore(bucket: string, opts?: DeliveryOptions): Promise<ObjectStore>;
}

/** A provider module's lib/provider file, looked for beside this module and in the clone cache. */
export function providerCandidates(id: StorageProviderId): string[] {
  const moduleId = `storage-${id}`;
  const out: string[] = [];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // .../modules/storage/lib → .../modules/<moduleId>/lib/provider
    for (const ext of ['ts', 'js']) {
      const sibling = resolve(here, '..', '..', moduleId, 'lib', `provider.${ext}`);
      if (existsSync(sibling)) out.push(sibling);
    }
    // .../<cache>/<slug>/modules/storage/lib → every <cache>/<slug>/modules/<moduleId>
    const cacheRoot = resolve(here, '..', '..', '..', '..');
    if (existsSync(cacheRoot)) {
      for (const ent of readdirSync(cacheRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        for (const ext of ['ts', 'js']) {
          const candidate = resolve(cacheRoot, ent.name, 'modules', moduleId, 'lib', `provider.${ext}`);
          if (existsSync(candidate) && !out.includes(candidate)) out.push(candidate);
        }
      }
    }
  } catch {
    // best effort; the fixed path below still gets tried
  }
  out.push(`/var/lib/gatewaze/modules/${moduleId}/lib/provider.js`);
  return out;
}

function isProviderModule(mod: unknown, id: string): mod is StorageProviderModule {
  const p = mod as Partial<StorageProviderModule> | null;
  return Boolean(p && p.id === id && typeof p.settings === 'function' && typeof p.createStore === 'function' && typeof p.defaultBucket === 'function');
}

export async function loadProviderFromDisk(id: StorageProviderId): Promise<StorageProviderModule> {
  if (!PROVIDER_ID.test(id)) throw new StorageUnavailableError(`not a storage provider id: ${id}`);
  let lastErr: unknown = null;
  for (const candidate of providerCandidates(id)) {
    try {
      const mod = (await import(candidate)) as { provider?: unknown };
      if (isProviderModule(mod.provider, id)) return mod.provider;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new StorageUnavailableError(`storage-${id} is not installed here${lastErr ? ` (${(lastErr as Error).message})` : ''}`);
}

export function createStorageRegistry(deps: StorageRegistryDeps): StorageRegistry {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const loadProvider = deps.loadProvider ?? loadProviderFromDisk;
  const supabaseSettings = supabaseSettingsFromEnv(env);
  const warned = new Set<string>();

  const configCache = new Map<string, { at: number; status: string; config: Record<string, unknown> }>();
  const providers = new Map<string, Promise<StorageProviderModule>>();
  const stores = new Map<string, ObjectStore>();
  // One prefixed store per provider store and Supabase bucket.
  const aliased = new WeakMap<ObjectStore, Map<string, ObjectStore>>();

  function warnOnce(key: string, msg: string, meta?: Record<string, unknown>) {
    if (warned.has(key)) return;
    warned.add(key);
    deps.logger?.warn(msg, meta);
  }

  /** A module's installed_modules row ('missing' when there is none), cached for a minute. */
  async function moduleRow(id: string): Promise<{ status: string; config: Record<string, unknown> }> {
    const hit = configCache.get(id);
    if (hit && now() - hit.at < CONFIG_TTL_MS) return hit;
    const { data, error } = await deps.supabase.from('installed_modules').select('id, status, config').in('id', [id]);
    if (error) {
      // Keep using the last row read rather than guessing: a brand whose
      // files moved must not start writing to Supabase on one failed read.
      if (hit) return hit;
      throw new StorageUnavailableError(`could not read module config: ${error.message}`);
    }
    const r = (data ?? []).find((x) => x.id === id);
    const row = { at: now(), status: r ? String(r.status ?? '') : 'missing', config: (r?.config ?? {}) as Record<string, unknown> };
    configCache.set(id, row);
    return row;
  }

  function provider(id: string) {
    let p = providers.get(id);
    if (!p) {
      p = loadProvider(id);
      p.catch(() => providers.delete(id));
      providers.set(id, p);
    }
    return p;
  }

  function supabase(bucket: string, opts: DeliveryOptions = {}): ObjectStore {
    if (!isValidBucket(bucket)) throw new StorageUnavailableError(`not a bucket name: ${bucket}`);
    const cdn = opts.cdn === true;
    const key = `${SUPABASE}|${bucket}|${cdn}`;
    let s = stores.get(key);
    if (!s) {
      s = supabaseStore(deps.supabase, cdn ? supabaseSettings : { ...supabaseSettings, bunnyZone: null }, bucket);
      stores.set(key, s);
    }
    return s;
  }

  /** The provider's store for a bucket (its default bucket when null). Throws when unavailable or not allowed. */
  async function providerStore(id: string, bucket: string | null): Promise<ObjectStore> {
    if (!PROVIDER_ID.test(id)) throw new StorageUnavailableError(`not a storage provider id: ${id}`);
    const moduleId = `storage-${id}`;
    const row = await moduleRow(moduleId);
    if (row.status !== 'enabled') throw new StorageUnavailableError(`${moduleId} is not enabled`);
    const mod = await provider(id);
    const settings = mod.settings(env, row.config);
    if (!settings) throw new StorageUnavailableError(`${moduleId} is not fully configured`);
    const b = bucket ?? mod.defaultBucket(settings);
    if (!isValidBucket(b)) throw new StorageUnavailableError(`not a bucket name: ${b}`);
    const allowed = mod.allowedBuckets ? mod.allowedBuckets(settings) : [mod.defaultBucket(settings)];
    if (!allowed.includes(b)) throw new StorageUnavailableError(`${moduleId} does not serve bucket ${b}`);
    // Settings can change in the admin, so the cache key includes them.
    const key = `${id}|${b}|${JSON.stringify(settings)}`;
    let s = stores.get(key);
    if (!s) {
      s = mod.createStore(settings, b);
      stores.set(key, s);
    }
    return s;
  }

  /** The provider every Supabase bucket is served from, or null when the brand is still on Supabase. */
  async function supabaseAlias(): Promise<string | null> {
    const fromEnv = String(env.STORAGE_SUPABASE_ALIAS ?? '').trim();
    if (fromEnv) return fromEnv === SUPABASE ? null : fromEnv;
    try {
      const v = (await moduleRow('storage')).config['supabase_alias'];
      return typeof v === 'string' && v.trim() && v.trim() !== SUPABASE ? v.trim() : null;
    } catch (err) {
      // Never read yet. A brand that serves its files from a provider
      // (STORAGE_PUBLIC_URL set) refuses rather than writing to Supabase,
      // where it no longer reads from; any other brand stays on Supabase.
      if (String(env.STORAGE_PUBLIC_URL ?? '').trim()) {
        throw new StorageUnavailableError(`could not tell where this brand's files are: ${(err as Error).message}`);
      }
      warnOnce('storage-config', '[storage] could not read the storage module config; using supabase', { error: (err as Error).message });
      return null;
    }
  }

  async function bucketStore(bucket: string, opts: DeliveryOptions = {}): Promise<ObjectStore> {
    if (!isValidBucket(bucket)) throw new StorageUnavailableError(`not a bucket name: ${bucket}`);
    const alias = await supabaseAlias();
    if (!alias) return supabase(bucket, opts);
    const inner = await providerStore(alias, null);
    let byBucket = aliased.get(inner);
    if (!byBucket) {
      byBucket = new Map();
      aliased.set(inner, byBucket);
    }
    let s = byBucket.get(bucket);
    if (!s) {
      s = prefixedStore(inner, bucket);
      byBucket.set(bucket, s);
    }
    return s;
  }

  async function chosenProvider(purpose: string | undefined): Promise<string> {
    if (purpose && PURPOSE.test(purpose)) {
      const v = String(env[`STORAGE_PROVIDER_${purpose.toUpperCase()}`] ?? '').trim();
      if (v) return v;
    }
    const v = String(env.STORAGE_PROVIDER ?? '').trim();
    if (v) return v;
    try {
      const cfg = (await moduleRow('storage')).config;
      const byPurpose = purpose && PURPOSE.test(purpose) ? cfg[`provider_${purpose}`] : undefined;
      const chosen = typeof byPurpose === 'string' && byPurpose.trim() ? byPurpose : cfg['default_provider'];
      if (typeof chosen === 'string' && chosen.trim()) return chosen.trim();
    } catch (err) {
      warnOnce('storage-config', '[storage] could not read the storage module config; using supabase', { error: (err as Error).message });
    }
    return SUPABASE;
  }

  return {
    supabase,
    bucketStore,

    async storeForNew(opts = {}) {
      const bucket = opts.supabaseBucket ?? 'media';
      const id = await chosenProvider(opts.purpose);
      if (id === SUPABASE) return bucketStore(bucket, opts);
      try {
        return await providerStore(id, null);
      } catch (err) {
        warnOnce(`fallback:${id}`, `[storage] provider ${id} is unavailable for new files; using supabase`, { error: (err as Error).message });
        return bucketStore(bucket, opts);
      }
    },

    async storeFor(row, fallbackBucket = 'media', opts = {}) {
      const id = String(row.storage_provider ?? '').trim() || SUPABASE;
      const bucket = String(row.storage_bucket ?? '').trim() || null;
      if (id === SUPABASE) {
        const b = bucket ?? fallbackBucket;
        if (b !== fallbackBucket && !(opts.supabaseBuckets ?? []).includes(b)) {
          throw new StorageUnavailableError(`bucket ${b} is not one this caller reads`);
        }
        return bucketStore(b, opts);
      }
      return providerStore(id, bucket);
    },
  };
}
