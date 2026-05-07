/**
 * Short-lived cache for hot dashboard queries. Backed by
 * `analytics_query_cache` (per-tenant, per-method) so refresh-spamming
 * an open dashboard doesn't N×-load Umami.
 *
 * Per spec-analytics-module §5.2 + §6.
 *
 * The cache key includes:
 *   - method name (so different endpoints on the same property/range
 *     don't collide)
 *   - JSON-stringified args (canonicalised key order)
 *   - caller_role (per spec §14.1: cross-user cache reads must be
 *     impossible — even though admin-tier callers all see the same
 *     data, mixing cache scopes lets a future per-user permission
 *     change land safely)
 *
 * TTL: 60s default; per-method override via the second arg of `get`.
 */

import { createHash } from 'node:crypto';

export interface CacheSupabaseClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export interface CachedCallOptions {
  /** Override the TTL for this call (ms). Default 60_000. */
  ttlMs?: number;
  /** Skip the cache entirely (read-through). Useful for invalidate paths. */
  skipCache?: boolean;
}

const DEFAULT_TTL_MS = 60_000;

/**
 * Stable JSON serialisation — sort object keys recursively so cache
 * keys don't differ on hash collision via key-order shuffling.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}

export function buildCacheKey(method: string, args: unknown, callerRole: string): string {
  const payload = `${method}|${callerRole}|${stableStringify(args)}`;
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Wrap an async function with the analytics_query_cache. Cache miss →
 * call fn, write the result, return it. Cache hit → return the cached
 * result. Both paths report cacheHit so callers can attach metrics.
 */
export async function cachedCall<T>(
  supabase: CacheSupabaseClient,
  method: string,
  args: unknown,
  callerRole: string,
  fn: () => Promise<T>,
  opts: CachedCallOptions = {},
): Promise<{ data: T; cacheHit: boolean }> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cacheKey = buildCacheKey(method, args, callerRole);

  if (!opts.skipCache) {
    const { data: hit } = await supabase
      .from('analytics_query_cache')
      .select('result, expires_at')
      .eq('cache_key', cacheKey)
      .gte('expires_at', new Date().toISOString())
      .maybeSingle();
    if (hit?.result !== undefined) {
      return { data: hit.result as T, cacheHit: true };
    }
  }

  const data = await fn();
  const now = Date.now();
  // Upsert — re-running the same query inside the TTL is fine; a later
  // call should overwrite an expired row rather than insert a duplicate.
  await supabase
    .from('analytics_query_cache')
    .upsert(
      {
        cache_key: cacheKey,
        result: data as unknown as Record<string, unknown>,
        cached_at: new Date(now).toISOString(),
        expires_at: new Date(now + ttlMs).toISOString(),
      },
      { onConflict: 'cache_key' },
    );

  return { data, cacheHit: false };
}
