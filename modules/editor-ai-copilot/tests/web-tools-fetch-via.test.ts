import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fetchViaGatewazeFetch } from '../lib/web-tools/fetch-via-gatewaze-fetch.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup as dnsLookup } from 'node:dns/promises';

const mockedLookup = dnsLookup as unknown as ReturnType<typeof vi.fn>;

const BASE_OPTS = {
  backend: 'gatewaze-fetch' as const,
  baseUrl: 'https://fetch.internal/v1',
  apiKey: 'test-key',
  tenantId: 'default',
  maxBytes: 1_048_576,
  timeoutMs: 5_000,
};

describe('fetchViaGatewazeFetch — URL validation (never throws)', () => {
  beforeEach(() => {
    mockedLookup.mockReset();
  });

  it('rejects malformed URL', async () => {
    const r = await fetchViaGatewazeFetch('not-a-url', BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('fetch_url_blocked');
  });

  it('rejects http (non-https) scheme', async () => {
    const r = await fetchViaGatewazeFetch('http://example.com/', BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorCode).toBe('fetch_url_blocked');
      expect(r.errorMessage).toContain('https');
    }
  });

  it('rejects private-IP host', async () => {
    mockedLookup.mockResolvedValue([{ address: '10.0.0.5' }]);
    const r = await fetchViaGatewazeFetch('https://internal.example/', BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('fetch_url_blocked');
  });
});

describe('fetchViaGatewazeFetch — upstream calls', () => {
  beforeEach(() => {
    mockedLookup.mockReset();
    mockedLookup.mockResolvedValue([{ address: '8.8.8.8' }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            text: 'page body',
            final_url: 'https://example.com/landing',
            bytes: 9,
            mode: 'static',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns ok=true with normalised body on 200', async () => {
    const r = await fetchViaGatewazeFetch('https://example.com/x', BASE_OPTS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe('page body');
      expect(r.final_url).toBe('https://example.com/landing');
      expect(r.bytes).toBe(9);
      expect(r.mode).toBe('static');
    }
  });

  it('passes Bearer auth + X-Gatewaze-Tenant', async () => {
    await fetchViaGatewazeFetch('https://example.com/x', BASE_OPTS);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as { headers: Record<string, string> }).headers['Authorization']).toBe('Bearer test-key');
    expect((init as { headers: Record<string, string> }).headers['X-Gatewaze-Tenant']).toBe('default');
  });

  it('returns fetch_upstream_failed on 5xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 502 })),
    );
    const r = await fetchViaGatewazeFetch('https://example.com/x', BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorCode).toBe('fetch_upstream_failed');
      expect(r.errorMessage).toContain('502');
    }
  });

  it('returns fetch_url_too_large on 413', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('too big', { status: 413 })),
    );
    const r = await fetchViaGatewazeFetch('https://example.com/x', BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('fetch_url_too_large');
  });

  it('returns fetch_upstream_failed when body is malformed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ missing: 'fields' }), { status: 200 })),
    );
    const r = await fetchViaGatewazeFetch('https://example.com/x', BASE_OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorCode).toBe('fetch_upstream_failed');
      expect(r.errorMessage).toContain('malformed');
    }
  });
});
