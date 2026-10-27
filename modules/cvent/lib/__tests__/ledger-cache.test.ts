import { describe, expect, it, vi } from 'vitest';
import { createLedgerCache, type LedgerPayload } from '../ledger-cache';

function payload(over: Partial<LedgerPayload> = {}): LedgerPayload {
  return {
    configured: true,
    sync_enabled: true,
    credentials_configured: true,
    status: { active: 2, synced: 1, pending: 1, failed: 0 },
    rows: [{ registration_id: 'r1', status: 'synced', synced_at: '2026-10-27T10:00:00Z', last_error: null, attempts: 1 }],
    ...over,
  };
}

describe('createLedgerCache', () => {
  it('shares one request between concurrent loads and indexes rows by registration', async () => {
    const fetcher = vi.fn(async () => payload());
    const cache = createLedgerCache(fetcher);
    const [a, b] = await Promise.all([cache.load('e1'), cache.load('e1')]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a.rows.get('r1')?.status).toBe('synced');
    expect(a.rows.has('r2')).toBe(false);
    expect(a.configured).toBe(true);
    expect(a.syncEnabled).toBe(true);
  });

  it('returns the cached copy inside the ttl and refetches after it or when forced', async () => {
    let t = 1_000;
    const fetcher = vi.fn(async () => payload());
    const cache = createLedgerCache(fetcher, { ttlMs: 10_000, now: () => t });
    await cache.load('e1');
    t += 5_000;
    await cache.load('e1');
    expect(fetcher).toHaveBeenCalledTimes(1);
    t += 6_000;
    await cache.load('e1');
    expect(fetcher).toHaveBeenCalledTimes(2);
    await cache.load('e1', true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('a forced load while a request is in flight joins it rather than starting another', async () => {
    let resolve!: (p: LedgerPayload) => void;
    const fetcher = vi.fn(() => new Promise<LedgerPayload>((r) => { resolve = r; }));
    const cache = createLedgerCache(fetcher);
    const a = cache.load('e1');
    const b = cache.load('e1', true);
    resolve(payload());
    expect(await a).toBe(await b);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('one throwing listener does not stop the others', async () => {
    const fetcher = vi.fn(async () => payload());
    const cache = createLedgerCache(fetcher);
    const seen: boolean[] = [];
    cache.subscribe('e1', () => { throw new Error('boom'); });
    cache.subscribe('e1', (l) => seen.push(l.configured));
    await cache.load('e1');
    expect(seen).toEqual([true]);
  });

  it('carries the truncated flag', async () => {
    const cache = createLedgerCache(async () => payload({ truncated: true }));
    expect((await cache.load('e1')).truncated).toBe(true);
  });

  it('invalidate forces the next load to fetch', async () => {
    const fetcher = vi.fn(async () => payload());
    const cache = createLedgerCache(fetcher);
    await cache.load('e1');
    cache.invalidate('e1');
    expect(cache.get('e1')).toBeUndefined();
    await cache.load('e1');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good rows when a fetch fails and reports the error', async () => {
    const fetcher = vi
      .fn<(id: string) => Promise<LedgerPayload>>()
      .mockResolvedValueOnce(payload())
      .mockRejectedValueOnce(new Error('HTTP 502'));
    const cache = createLedgerCache(fetcher, { ttlMs: 0 });
    await cache.load('e1');
    const failed = await cache.load('e1');
    expect(failed.error).toBe('HTTP 502');
    expect(failed.rows.get('r1')?.status).toBe('synced');
    expect(failed.configured).toBe(true);
    // A failed copy is not served from cache: the next load tries again.
    fetcher.mockResolvedValueOnce(payload({ rows: [] }));
    const recovered = await cache.load('e1');
    expect(recovered.error).toBeNull();
    expect(recovered.rows.size).toBe(0);
  });

  it('notifies subscribers after each load until they unsubscribe', async () => {
    const fetcher = vi.fn(async () => payload());
    const cache = createLedgerCache(fetcher, { ttlMs: 0 });
    const seen: number[] = [];
    const off = cache.subscribe('e1', (l) => seen.push(l.rows.size));
    await cache.load('e1');
    off();
    await cache.load('e1');
    expect(seen).toEqual([1]);
  });

  it('keeps event ledgers apart', async () => {
    const fetcher = vi.fn(async (id: string) => payload({ rows: id === 'e1' ? payload().rows : [] }));
    const cache = createLedgerCache(fetcher);
    const [a, b] = await Promise.all([cache.load('e1'), cache.load('e2')]);
    expect(a.rows.size).toBe(1);
    expect(b.rows.size).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
