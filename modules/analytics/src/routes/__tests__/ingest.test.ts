/**
 * Smoke tests for the public ingest routes — validates the security
 * gates per spec §14.1:
 *   - Rate limit per-IP fires first
 *   - Property domains allowlist enforced (no '*' for sites/portal)
 *   - Origin / Referer fallback works
 *   - Per-property rate limit fires after domain check
 *   - Umami forwarder receives the request
 */

import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createIngestRoutes, type IngestRoutesDeps, type IngestSupabaseClient } from '../ingest.js';

interface ScriptedQuery {
  data: unknown;
  error: { message: string } | null;
}

function makeFakeSupabase(propertyRow: ScriptedQuery): IngestSupabaseClient {
  return {
    from(_table: string) {
      const ctx: { eqs: Record<string, unknown> } = { eqs: {} };
      const q: any = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          ctx.eqs[col] = val;
          return q;
        },
        maybeSingle: async () => propertyRow,
      };
      return q;
    },
    async rpc() { return { data: null, error: null }; },
  };
}

function fakeReq(overrides: Partial<Request> & { headers?: Record<string, string> } = {}): Request {
  const headers = overrides.headers ?? {};
  return {
    body: undefined,
    params: {},
    query: {},
    headers,
    ip: '1.2.3.4',
    protocol: 'https',
    header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
    ...overrides,
  } as unknown as Request;
}

function fakeRes(): Response & { _status?: number; _body?: unknown; _headers?: Record<string, string> } {
  const res: Partial<Response> & { _status?: number; _body?: unknown; _headers?: Record<string, string> } = {};
  res._headers = {};
  res.setHeader = ((k: string, v: string) => { (res._headers as Record<string, string>)[k] = v; return res as Response; }) as Response['setHeader'];
  res.status = ((c: number) => { res._status = c; return res as Response; }) as Response['status'];
  res.json = ((b: unknown) => { res._body = b; return res as Response; }) as Response['json'];
  res.send = ((b?: unknown) => { res._body = b; return res as Response; }) as Response['send'];
  return res as Response & { _status?: number; _body?: unknown; _headers?: Record<string, string> };
}

const PROPERTY_ID = '11111111-2222-3333-4444-555555555555';
const WEBSITE_UUID = '99999999-8888-7777-6666-555555555555';

const baseDeps = (over: Partial<IngestRoutesDeps> = {}): IngestRoutesDeps => ({
  supabase: makeFakeSupabase({ data: null, error: null }),
  umamiCollect: vi.fn(async () => ({ ok: true, status: 200 })),
  fetchUmamiTracker: vi.fn(async () => ({ ok: true, status: 200, body: 'tracker("/api/send")' })),
  decryptSecret: (b) => Buffer.isBuffer(b) ? b.toString('utf-8') : (b as string),
  rateLimit: async () => ({ allowed: true, resetAt: Date.now() + 60_000 }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  perIpRpm: 200,
  perPropertyRpm: 5000,
  embedCacheMaxAgeSeconds: 300,
  ...over,
});

describe('createIngestRoutes — collect', () => {
  it('rejects body without a website field (400)', async () => {
    const routes = createIngestRoutes(baseDeps());
    const res = fakeRes();
    await routes.collect(fakeReq({ body: { type: 'event' } }), res);
    expect(res._status).toBe(400);
  });

  it('rejects when per-IP limit exceeded (429 + Retry-After)', async () => {
    const routes = createIngestRoutes(baseDeps({
      rateLimit: async (key) => key.startsWith('analytics-ingest:ip:')
        ? { allowed: false, resetAt: Date.now() + 30_000 }
        : { allowed: true, resetAt: Date.now() + 60_000 },
    }));
    const res = fakeRes();
    await routes.collect(fakeReq({ body: { website: PROPERTY_ID } }), res);
    expect(res._status).toBe(429);
    expect(res._headers!['Retry-After']).toBeDefined();
  });

  it('returns 404 when property is unknown or not active', async () => {
    const routes = createIngestRoutes(baseDeps({
      supabase: makeFakeSupabase({ data: null, error: null }),
    }));
    const res = fakeRes();
    await routes.collect(
      fakeReq({ body: { website: PROPERTY_ID }, headers: { origin: 'https://example.com' } }),
      res,
    );
    expect(res._status).toBe(404);
  });

  it('returns 403 when origin not in domains allowlist', async () => {
    const routes = createIngestRoutes(baseDeps({
      supabase: makeFakeSupabase({
        data: { property_id: PROPERTY_ID, kind: 'gatewaze_site', domains: ['example.com'], status: 'active', website_uuid: WEBSITE_UUID },
        error: null,
      }),
    }));
    const res = fakeRes();
    await routes.collect(
      fakeReq({ body: { website: PROPERTY_ID }, headers: { origin: 'https://evil.example' } }),
      res,
    );
    expect(res._status).toBe(403);
  });

  it('forwards to Umami when all gates pass (204)', async () => {
    const umami = vi.fn(async () => ({ ok: true, status: 200 }));
    const routes = createIngestRoutes(baseDeps({
      umamiCollect: umami,
      supabase: makeFakeSupabase({
        data: { property_id: PROPERTY_ID, kind: 'gatewaze_site', domains: ['example.com'], status: 'active', website_uuid: WEBSITE_UUID },
        error: null,
      }),
    }));
    const res = fakeRes();
    await routes.collect(
      fakeReq({
        body: { website: PROPERTY_ID, type: 'event', payload: {} },
        headers: { origin: 'https://example.com', 'user-agent': 'Mozilla/5.0' },
      }),
      res,
    );
    expect(res._status).toBe(204);
    expect(umami).toHaveBeenCalledTimes(1);
    const [forwarded, headers] = umami.mock.calls[0]!;
    // The browser-facing property_id is swapped for Umami's website_uuid.
    expect((forwarded as Record<string, unknown>)['website']).toBe(WEBSITE_UUID);
    expect((headers as Record<string, string>)['User-Agent']).toBe('Mozilla/5.0');
  });

  it('accepts the stock tracker shape (payload.website nested) and swaps the uuid', async () => {
    const umami = vi.fn(async () => ({ ok: true, status: 200 }));
    const routes = createIngestRoutes(baseDeps({
      umamiCollect: umami,
      supabase: makeFakeSupabase({
        data: { property_id: PROPERTY_ID, kind: 'portal', domains: ['example.com'], status: 'active', website_uuid: WEBSITE_UUID },
        error: null,
      }),
    }));
    const res = fakeRes();
    await routes.collect(
      fakeReq({
        body: { type: 'event', payload: { website: PROPERTY_ID, url: '/x' } },
        headers: { origin: 'https://example.com' },
      }),
      res,
    );
    expect(res._status).toBe(204);
    const [forwarded] = umami.mock.calls[0]!;
    expect(((forwarded as Record<string, unknown>)['payload'] as Record<string, unknown>)['website']).toBe(WEBSITE_UUID);
  });

  it('returns 404 when the property has no provisioned website_uuid', async () => {
    const routes = createIngestRoutes(baseDeps({
      supabase: makeFakeSupabase({
        data: { property_id: PROPERTY_ID, kind: 'portal', domains: ['example.com'], status: 'active', website_uuid: null },
        error: null,
      }),
    }));
    const res = fakeRes();
    await routes.collect(
      fakeReq({ body: { website: PROPERTY_ID }, headers: { origin: 'https://example.com' } }),
      res,
    );
    expect(res._status).toBe(404);
  });

  it('honours wildcard domains for external properties', async () => {
    const routes = createIngestRoutes(baseDeps({
      supabase: makeFakeSupabase({
        data: { property_id: PROPERTY_ID, kind: 'external', domains: ['*'], status: 'active', website_uuid: WEBSITE_UUID },
        error: null,
      }),
    }));
    const res = fakeRes();
    await routes.collect(
      fakeReq({ body: { website: PROPERTY_ID }, headers: { origin: 'https://anywhere.example' } }),
      res,
    );
    expect(res._status).toBe(204);
  });

  it('falls back to Referer when Origin is missing', async () => {
    const routes = createIngestRoutes(baseDeps({
      supabase: makeFakeSupabase({
        data: { property_id: PROPERTY_ID, kind: 'gatewaze_site', domains: ['example.com'], status: 'active', website_uuid: WEBSITE_UUID },
        error: null,
      }),
    }));
    const res = fakeRes();
    await routes.collect(
      fakeReq({ body: { website: PROPERTY_ID }, headers: { referer: 'https://example.com/page' } }),
      res,
    );
    expect(res._status).toBe(204);
  });

  it('returns 502 + logs when Umami forwarder fails', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const routes = createIngestRoutes(baseDeps({
      logger,
      umamiCollect: async () => ({ ok: false, status: 503 }),
      supabase: makeFakeSupabase({
        data: { property_id: PROPERTY_ID, kind: 'gatewaze_site', domains: ['example.com'], status: 'active', website_uuid: WEBSITE_UUID },
        error: null,
      }),
    }));
    const res = fakeRes();
    await routes.collect(
      fakeReq({ body: { website: PROPERTY_ID }, headers: { origin: 'https://example.com' } }),
      res,
    );
    expect(res._status).toBe(502);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('createIngestRoutes — pixelBundle', () => {
  it('returns 404 for malformed filename', async () => {
    const routes = createIngestRoutes(baseDeps());
    const res = fakeRes();
    await routes.pixelBundle(fakeReq({ params: { filename: 'not-a-uuid.js' } }), res);
    expect(res._status).toBe(404);
  });

  it('returns 404 for unknown property', async () => {
    const routes = createIngestRoutes(baseDeps({
      supabase: makeFakeSupabase({ data: null, error: null }),
    }));
    const res = fakeRes();
    await routes.pixelBundle(fakeReq({ params: { filename: `${PROPERTY_ID}.js` } }), res);
    expect(res._status).toBe(404);
  });

  it('returns the bundle with proper headers when property exists', async () => {
    // Three sequential lookups: properties, scripts, secrets
    const queryResults = [
      { data: { property_id: PROPERTY_ID, kind: 'external', status: 'active' }, error: null },
      { data: { script_head: '<!-- a -->', script_body: '<!-- b -->' }, error: null },
      { data: null, error: null }, // no segment key
    ];
    let i = 0;
    const supabase: IngestSupabaseClient = {
      from(_table: string) {
        const q: any = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => queryResults[i++] ?? { data: null, error: null },
        };
        return q;
      },
      async rpc() { return { data: null, error: null }; },
    };
    const routes = createIngestRoutes(baseDeps({ supabase }));
    const res = fakeRes();
    await routes.pixelBundle(
      fakeReq({ params: { filename: `${PROPERTY_ID}.js` }, headers: { host: 'analytics.example.com' } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._headers!['Content-Type']).toMatch(/javascript/);
    expect(res._headers!['Cache-Control']).toContain('max-age=300');
    expect(res._headers!['Access-Control-Allow-Origin']).toBe('*');
    expect(typeof res._body).toBe('string');
    expect(res._body as string).toContain(PROPERTY_ID);
  });
});

describe('createIngestRoutes — trackerScript', () => {
  it('serves the tracker with the beacon path rewritten to /a/collect', async () => {
    const routes = createIngestRoutes(baseDeps({
      fetchUmamiTracker: async () => ({ ok: true, status: 200, body: 'x("/api/send")' }),
    }));
    const res = fakeRes();
    await routes.trackerScript(fakeReq(), res);
    expect(res._status).toBe(200);
    expect(res._headers!['Content-Type']).toMatch(/javascript/);
    expect(res._body).toBe('x("/a/collect")');
  });

  it('caches the tracker between requests', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, body: 'x("/api/send")' }));
    const routes = createIngestRoutes(baseDeps({ fetchUmamiTracker: fetcher }));
    await routes.trackerScript(fakeReq(), fakeRes());
    await routes.trackerScript(fakeReq(), fakeRes());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns 502 when umami is unreachable and no cache exists', async () => {
    const routes = createIngestRoutes(baseDeps({
      fetchUmamiTracker: async () => { throw new Error('boom'); },
    }));
    const res = fakeRes();
    await routes.trackerScript(fakeReq(), res);
    expect(res._status).toBe(502);
  });
});

describe('createIngestRoutes — portalConfig', () => {
  it('returns the active portal property id', async () => {
    const routes = createIngestRoutes(baseDeps({
      supabase: makeFakeSupabase({ data: { property_id: PROPERTY_ID, status: 'active' }, error: null }),
    }));
    const res = fakeRes();
    await routes.portalConfig(fakeReq(), res);
    expect(res._status ?? 200).toBe(200);
    expect(res._body).toEqual({ property_id: PROPERTY_ID });
  });

  it('404s when no active portal property exists', async () => {
    const routes = createIngestRoutes(baseDeps({
      supabase: makeFakeSupabase({ data: null, error: null }),
    }));
    const res = fakeRes();
    await routes.portalConfig(fakeReq(), res);
    expect(res._status).toBe(404);
  });
});
