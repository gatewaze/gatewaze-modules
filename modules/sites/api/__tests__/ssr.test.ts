/**
 * SSR handler smoke tests — wire-level checks that the resolver→renderer→
 * response pipeline behaves correctly for the cardinal cases.
 *
 *   - Published page → 200 + text/html + Cache-Control
 *   - Archived → 410
 *   - Missing → 404
 *   - Rate-limited → 429
 *   - Bad path → 400
 */

import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createSsrRoutes, type SsrRoutesDeps, type SsrSupabaseClient } from '../ssr.js';

const baseResolved = {
  page: { id: 'p1', title: 'Hello', full_path: '/', seo: {}, host_kind: 'site', host_id: 's1' },
  site: { id: 's1', slug: 'aaif', name: 'AAIF', config: {} },
  wrapper: { id: 'w1', html_template: '<body>{{>page_body}}</body>' },
  blocks: [],
  page_status: 'published' as const,
  cache_max_age: null,
};

function fakeRpc(result: { data: unknown; error: { message: string } | null }): SsrSupabaseClient {
  return {
    async rpc() {
      return result;
    },
  };
}

function fakeReq(query: Record<string, string>): Request {
  return { query, headers: {}, header: () => undefined } as unknown as Request;
}

function fakeRes(): Response & { _status?: number; _body?: unknown; _headers?: Record<string, string> } {
  const res: Partial<Response> & { _status?: number; _body?: unknown; _headers?: Record<string, string> } = {
    _headers: {},
  };
  res.setHeader = ((k: string, v: string) => {
    (res._headers as Record<string, string>)[k] = v;
    return res as Response;
  }) as Response['setHeader'];
  res.status = ((code: number) => {
    (res as { _status?: number })._status = code;
    return res as Response;
  }) as Response['status'];
  res.send = ((body: unknown) => {
    (res as { _body?: unknown })._body = body;
    return res as Response;
  }) as unknown as Response['send'];
  res.json = ((body: unknown) => {
    (res as { _body?: unknown })._body = body;
    return res as Response;
  }) as Response['json'];
  return res as Response & { _status?: number; _body?: unknown; _headers?: Record<string, string> };
}

const baseDeps = (overrides: Partial<SsrRoutesDeps> = {}): SsrRoutesDeps => ({
  supabase: fakeRpc({ data: null, error: null }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  checkRateLimit: async () => true,
  ...overrides,
});

describe('SSR getRender()', () => {
  it('returns 400 when host or path is missing', async () => {
    const routes = createSsrRoutes(baseDeps());
    const res = fakeRes();
    await routes.getRender(fakeReq({ host: 'aaif.test' }), res);
    expect(res._status).toBe(400);
  });

  it('returns 400 on malformed path', async () => {
    const routes = createSsrRoutes(baseDeps());
    const res = fakeRes();
    await routes.getRender(fakeReq({ host: 'aaif.test', path: 'no-slash' }), res);
    expect(res._status).toBe(400);
  });

  it('returns 429 when rate-limited', async () => {
    const routes = createSsrRoutes(baseDeps({ checkRateLimit: async () => false }));
    const res = fakeRes();
    await routes.getRender(fakeReq({ host: 'aaif.test', path: '/' }), res);
    expect(res._status).toBe(429);
    expect(res._headers?.['Retry-After']).toBe('60');
  });

  it('returns 404 when resolver returns null', async () => {
    const routes = createSsrRoutes(baseDeps({ supabase: fakeRpc({ data: null, error: null }) }));
    const res = fakeRes();
    await routes.getRender(fakeReq({ host: 'aaif.test', path: '/' }), res);
    expect(res._status).toBe(404);
  });

  it('returns 410 when page is archived', async () => {
    const routes = createSsrRoutes(baseDeps({
      supabase: fakeRpc({ data: { ...baseResolved, page_status: 'archived' }, error: null }),
    }));
    const res = fakeRes();
    await routes.getRender(fakeReq({ host: 'aaif.test', path: '/' }), res);
    expect(res._status).toBe(410);
  });

  it('returns 404 when page is draft (non-published)', async () => {
    const routes = createSsrRoutes(baseDeps({
      supabase: fakeRpc({ data: { ...baseResolved, page_status: 'draft' }, error: null }),
    }));
    const res = fakeRes();
    await routes.getRender(fakeReq({ host: 'aaif.test', path: '/' }), res);
    expect(res._status).toBe(404);
  });

  it('returns 200 with text/html and Cache-Control on a published hit', async () => {
    const routes = createSsrRoutes(baseDeps({
      supabase: fakeRpc({ data: baseResolved, error: null }),
    }));
    const res = fakeRes();
    await routes.getRender(fakeReq({ host: 'aaif.test', path: '/' }), res);
    expect(res._status).toBe(200);
    expect(res._headers?.['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res._headers?.['Cache-Control']).toContain('public, max-age=');
    expect(res._body).toContain('<body>');
  });

  it('honors per-page cache_max_age override', async () => {
    const routes = createSsrRoutes(baseDeps({
      supabase: fakeRpc({ data: { ...baseResolved, cache_max_age: 30 }, error: null }),
      defaultCacheMaxAge: 9999,
    }));
    const res = fakeRes();
    await routes.getRender(fakeReq({ host: 'aaif.test', path: '/' }), res);
    expect(res._headers?.['Cache-Control']).toBe('public, max-age=30');
  });
});
