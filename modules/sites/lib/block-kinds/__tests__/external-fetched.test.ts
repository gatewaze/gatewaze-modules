import { describe, expect, it, vi } from 'vitest';
import { ExternalFetcher, extractPath } from '../external-fetched.js';

function makeStubFetch(opts: { ok: boolean; status?: number; body?: unknown; throwError?: Error; delayMs?: number } = { ok: true }) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.throwError) throw opts.throwError;
    return {
      ok: opts.ok,
      status: opts.status ?? (opts.ok ? 200 : 500),
      json: async () => opts.body ?? {},
    } as unknown as Response;
  });
}

describe('ExternalFetcher.fetchOne', () => {
  it('returns successful body as content', async () => {
    const fetchFn = makeStubFetch({ ok: true, body: { temp: 22, condition: 'sunny' } });
    const fetcher = new ExternalFetcher({
      resolveSecret: async () => null,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const result = await fetcher.fetchOne({
      siteId: 'site-1',
      blockDefId: 'def-1',
      blockDefName: 'Weather',
      config: { endpoint: 'https://api.example.com/weather' },
    });
    expect(result.usedFallback).toBe(false);
    expect(result.content).toEqual({ temp: 22, condition: 'sunny' });
  });

  it('returns fallback_content on non-2xx', async () => {
    const fetchFn = makeStubFetch({ ok: false, status: 503 });
    const fetcher = new ExternalFetcher({
      resolveSecret: async () => null,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const result = await fetcher.fetchOne({
      siteId: 'site-1', blockDefId: 'def-1', blockDefName: 'Weather',
      config: { endpoint: 'https://api.example.com/weather', fallback_content: { temp: null } },
    });
    expect(result.usedFallback).toBe(true);
    expect(result.error).toBe('http_503');
    expect(result.content).toEqual({ temp: null });
  });

  it('returns fallback when auth_secret_key is missing from secrets', async () => {
    const fetchFn = makeStubFetch();
    const fetcher = new ExternalFetcher({
      resolveSecret: async () => null,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const result = await fetcher.fetchOne({
      siteId: 'site-1', blockDefId: 'def-1', blockDefName: 'Weather',
      authSecretKey: 'OPENWEATHERMAP_KEY',
      config: { endpoint: 'https://api.example.com/weather', auth_location: 'query', fallback_content: {} },
    });
    expect(result.usedFallback).toBe(true);
    expect(result.error).toContain('auth_secret_missing');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('attaches auth as query param when auth_location=query', async () => {
    const fetchFn = makeStubFetch({ ok: true, body: {} });
    const fetcher = new ExternalFetcher({
      resolveSecret: async () => 'secret-key-123',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await fetcher.fetchOne({
      siteId: 'site-1', blockDefId: 'def-1', blockDefName: 'Weather',
      authSecretKey: 'OWM_KEY',
      config: {
        endpoint: 'https://api.example.com/weather',
        auth_location: 'query',
        auth_query_param: 'appid',
      },
    });
    const url = String(fetchFn.mock.calls[0]?.[0]);
    expect(url).toContain('appid=secret-key-123');
  });

  it('attaches auth as Bearer header when auth_location=header', async () => {
    const fetchFn = makeStubFetch({ ok: true, body: {} });
    const fetcher = new ExternalFetcher({
      resolveSecret: async () => 'token-abc',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await fetcher.fetchOne({
      siteId: 'site-1', blockDefId: 'def-1', blockDefName: 'GitHubStats',
      authSecretKey: 'GH_TOKEN',
      config: { endpoint: 'https://api.github.com/users/octocat', auth_location: 'header' },
    });
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-abc');
  });

  it('extracts response_path from JSON body', async () => {
    const fetchFn = makeStubFetch({ ok: true, body: { data: { items: [{ name: 'first' }, { name: 'second' }] } } });
    const fetcher = new ExternalFetcher({
      resolveSecret: async () => null,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const result = await fetcher.fetchOne({
      siteId: 'site-1', blockDefId: 'def-1', blockDefName: 'Items',
      config: { endpoint: 'https://api.example.com/items', response_path: 'data.items' },
    });
    expect(result.content).toEqual([{ name: 'first' }, { name: 'second' }]);
  });

  it('aborts on timeout + returns fallback', async () => {
    const fetchFn = vi.fn(async () => {
      // Simulate a request that never resolves but checks AbortSignal
      throw new Error('AbortError');
    });
    const fetcher = new ExternalFetcher({
      resolveSecret: async () => null,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const result = await fetcher.fetchOne({
      siteId: 'site-1', blockDefId: 'def-1', blockDefName: 'Slow',
      config: { endpoint: 'https://api.example.com/slow', timeout_ms: 50, fallback_content: { ok: false } },
    });
    expect(result.usedFallback).toBe(true);
    expect(result.content).toEqual({ ok: false });
  });

  it('returns publish_budget_exhausted when budget already drained', async () => {
    const fetchFn = makeStubFetch({ ok: true, body: {} });
    const fetcher = new ExternalFetcher({
      resolveSecret: async () => null,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      publishBudgetMs: 0, // pre-exhausted
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const result = await fetcher.fetchOne({
      siteId: 'site-1', blockDefId: 'def-1', blockDefName: 'B',
      config: { endpoint: 'https://api.example.com/b', fallback_content: { ok: false } },
    });
    expect(result.usedFallback).toBe(true);
    expect(result.error).toBe('publish_budget_exhausted');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('extractPath', () => {
  it('returns whole object when path is empty', () => {
    expect(extractPath({ a: 1 }, '')).toEqual({ a: 1 });
  });

  it('extracts dot-notation path', () => {
    expect(extractPath({ data: { items: { name: 'x' } } }, 'data.items.name')).toBe('x');
  });

  it('extracts array index via [N]', () => {
    expect(extractPath({ data: { items: [{ name: 'first' }, { name: 'second' }] } }, 'data.items[1].name')).toBe('second');
  });

  it('returns undefined for missing path', () => {
    expect(extractPath({ a: 1 }, 'a.b.c')).toBeUndefined();
  });
});
