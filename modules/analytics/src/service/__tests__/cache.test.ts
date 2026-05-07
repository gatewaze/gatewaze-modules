import { describe, expect, it, vi } from 'vitest';
import { buildCacheKey, cachedCall, type CacheSupabaseClient } from '../cache.js';

function makeFakeCache(initial: Map<string, { result: unknown; expiresAt: string }> = new Map()): {
  client: CacheSupabaseClient;
  store: Map<string, { result: unknown; expiresAt: string }>;
  upserts: Array<Record<string, unknown>>;
} {
  const store = initial;
  const upserts: Array<Record<string, unknown>> = [];

  const client: CacheSupabaseClient = {
    from(_table: string) {
      const ctx: { key: string | null; expiresGte: string | null } = { key: null, expiresGte: null };
      const q: any = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          if (col === 'cache_key') ctx.key = String(val);
          return q;
        },
        gte: (col: string, val: unknown) => {
          if (col === 'expires_at') ctx.expiresGte = String(val);
          return q;
        },
        maybeSingle: async () => {
          if (!ctx.key) return { data: null, error: null };
          const hit = store.get(ctx.key);
          if (!hit) return { data: null, error: null };
          if (ctx.expiresGte && hit.expiresAt < ctx.expiresGte) return { data: null, error: null };
          return { data: { result: hit.result, expires_at: hit.expiresAt }, error: null };
        },
        upsert: (values: Record<string, unknown>) => {
          upserts.push(values);
          store.set(values['cache_key'] as string, {
            result: values['result'],
            expiresAt: values['expires_at'] as string,
          });
          return Promise.resolve({ data: null, error: null });
        },
      };
      return q;
    },
  };
  return { client, store, upserts };
}

describe('buildCacheKey', () => {
  it('produces stable hashes regardless of arg key order', () => {
    const a = buildCacheKey('m', { x: 1, y: 2 }, 'authenticated');
    const b = buildCacheKey('m', { y: 2, x: 1 }, 'authenticated');
    expect(a).toBe(b);
  });

  it('changes when caller_role differs (cross-user isolation)', () => {
    const a = buildCacheKey('m', { x: 1 }, 'authenticated');
    const b = buildCacheKey('m', { x: 1 }, 'service_role');
    expect(a).not.toBe(b);
  });

  it('changes when method differs (no cross-method collisions)', () => {
    const a = buildCacheKey('getPageviews', { x: 1 }, 'authenticated');
    const b = buildCacheKey('getTopPages', { x: 1 }, 'authenticated');
    expect(a).not.toBe(b);
  });
});

describe('cachedCall', () => {
  it('calls fn on cache miss + writes result', async () => {
    const { client, upserts } = makeFakeCache();
    const fn = vi.fn(async () => ({ value: 42 }));
    const result = await cachedCall(client, 'm', { id: 'x' }, 'authenticated', fn);
    expect(result.cacheHit).toBe(false);
    expect(result.data).toEqual({ value: 42 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(upserts).toHaveLength(1);
  });

  it('returns cached value + skips fn on hit', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const key = buildCacheKey('m', { id: 'x' }, 'authenticated');
    const { client } = makeFakeCache(new Map([[key, { result: { value: 99 }, expiresAt: future }]]));
    const fn = vi.fn(async () => ({ value: 0 }));
    const result = await cachedCall(client, 'm', { id: 'x' }, 'authenticated', fn);
    expect(result.cacheHit).toBe(true);
    expect(result.data).toEqual({ value: 99 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('treats expired entries as misses', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const key = buildCacheKey('m', {}, 'authenticated');
    const { client } = makeFakeCache(new Map([[key, { result: { value: 'stale' }, expiresAt: past }]]));
    const fn = vi.fn(async () => ({ value: 'fresh' }));
    const result = await cachedCall(client, 'm', {}, 'authenticated', fn);
    expect(result.cacheHit).toBe(false);
    expect(result.data).toEqual({ value: 'fresh' });
  });

  it('skipCache=true bypasses both read + write', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const key = buildCacheKey('m', {}, 'authenticated');
    const { client, upserts } = makeFakeCache(new Map([[key, { result: 'cached', expiresAt: future }]]));
    const fn = vi.fn(async () => 'fresh');
    const result = await cachedCall(client, 'm', {}, 'authenticated', fn, { skipCache: true });
    expect(result.cacheHit).toBe(false);
    expect(result.data).toBe('fresh');
    // Even with skipCache, we still write the result so the next call has it
    expect(upserts).toHaveLength(1);
  });

  it('different roles get different cache slots even for the same args', async () => {
    const { client } = makeFakeCache();
    const fn1 = vi.fn(async () => 'auth-data');
    const fn2 = vi.fn(async () => 'service-data');
    await cachedCall(client, 'm', { id: 'x' }, 'authenticated', fn1);
    await cachedCall(client, 'm', { id: 'x' }, 'service_role', fn2);
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });
});
