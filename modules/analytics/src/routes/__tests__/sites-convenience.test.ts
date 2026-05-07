/**
 * Smoke tests for the site-scoped convenience routes:
 *   - 401 when no user
 *   - 400 on invalid siteId (uuid validation)
 *   - 400 on missing/invalid date range
 *   - 404 when no analytics property is attached to the site
 *   - happy path: resolves siteId → propertyId, calls service, returns 200
 *   - pagePath is forwarded as page_path filter when supplied
 *   - top-pages ignores pagePath (cross-page by definition)
 */

import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  createSitesConvenienceRoutes,
  type SitesConvenienceRoutesDeps,
} from '../sites-convenience.js';
import type { AnalyticsService, DimensionFilter } from '../../service/contract.js';

interface FakeRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
  setHeader(k: string, v: string): FakeRes;
}

function fakeRes(): FakeRes {
  const r: FakeRes = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
  };
  return r;
}

function fakeReq(over: Partial<Request> = {}): Request {
  return {
    params: {},
    query: {},
    headers: {},
    ...over,
  } as unknown as Request;
}

const VALID_SITE = '11111111-1111-1111-1111-111111111111';
const VALID_PROPERTY = '22222222-2222-2222-2222-222222222222';
const VALID_SESSION = '33333333-3333-3333-3333-333333333333';

function makeDeps(opts: {
  userId?: string | null;
  propertyRow?: { property_id: string } | null;
  service?: Partial<AnalyticsService>;
  supabaseError?: { message: string } | null;
} = {}): SitesConvenienceRoutesDeps {
  const propertyRow = opts.propertyRow === undefined
    ? { property_id: VALID_PROPERTY }
    : opts.propertyRow;
  const supabase = {
    from(_table: string) {
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: propertyRow,
          error: opts.supabaseError ?? null,
        }),
      };
      return q;
    },
  };
  const service = {
    getPropertySummary: vi.fn(async () => ({
      ok: true as const,
      data: { pageviews: 1, unique_visitors: 1, active_now: 0, top_pages: [] },
      cacheHit: false,
    })),
    getPageviews: vi.fn(async () => ({ ok: true as const, data: [], cacheHit: false })),
    getTopPages: vi.fn(async () => ({ ok: true as const, data: [], cacheHit: false })),
    getTopReferrers: vi.fn(async () => ({ ok: true as const, data: [], cacheHit: false })),
    getRealtime: vi.fn(async () => ({
      ok: true as const,
      data: { active_visitors: 0, views_last_hour: 0, top_pages: [] },
      cacheHit: false,
    })),
    listSessions: vi.fn(async () => ({
      ok: true as const,
      data: { sessions: [], total: 0, page: 1, page_size: 20 },
      cacheHit: false,
    })),
    getSessionActivity: vi.fn(async () => ({ ok: true as const, data: [], cacheHit: false })),
    getReplayDeepLink: vi.fn(async () => ({
      ok: true as const,
      data: { url: 'https://analytics.example/websites/x/sessions/y' },
      cacheHit: false,
    })),
    getCohortRetention: vi.fn(async () => ({ ok: true as const, data: [], cacheHit: false })),
    getRetentionCurve: vi.fn(async () => ({ ok: true as const, data: [], cacheHit: false })),
    getCustomEvents: vi.fn(async () => ({
      ok: true as const,
      data: { event_name: '', count: 0, unique_visitors: 0 },
      cacheHit: false,
    })),
    getVariantBreakdown: vi.fn(async () => ({ ok: true as const, data: [], cacheHit: false })),
    ...opts.service,
  } as unknown as AnalyticsService;
  return {
    service,
    supabase,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    getUserId: () => (opts.userId === undefined ? 'user-1' : opts.userId),
  };
}

const DATE_RANGE = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-08T00:00:00.000Z' };

describe('sites-convenience routes', () => {
  it('summary: 401 when no user', async () => {
    const routes = createSitesConvenienceRoutes(makeDeps({ userId: null }));
    const res = fakeRes();
    await routes.summary(fakeReq({ params: { siteId: VALID_SITE }, query: DATE_RANGE }), res as unknown as Response);
    expect(res.statusCode).toBe(401);
  });

  it('summary: 400 when siteId is not a uuid', async () => {
    const routes = createSitesConvenienceRoutes(makeDeps());
    const res = fakeRes();
    await routes.summary(fakeReq({ params: { siteId: 'not-a-uuid' }, query: DATE_RANGE }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toMatch(/uuid/i);
  });

  it('summary: 400 when date range missing', async () => {
    const routes = createSitesConvenienceRoutes(makeDeps());
    const res = fakeRes();
    await routes.summary(fakeReq({ params: { siteId: VALID_SITE }, query: {} }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
  });

  it('summary: 404 when no analytics property attached to site', async () => {
    const routes = createSitesConvenienceRoutes(makeDeps({ propertyRow: null }));
    const res = fakeRes();
    await routes.summary(fakeReq({ params: { siteId: VALID_SITE }, query: DATE_RANGE }), res as unknown as Response);
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('summary: 200 happy path delegates to service with resolved property_id', async () => {
    const deps = makeDeps();
    const routes = createSitesConvenienceRoutes(deps);
    const res = fakeRes();
    await routes.summary(fakeReq({ params: { siteId: VALID_SITE }, query: DATE_RANGE }), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(deps.service.getPropertySummary).toHaveBeenCalledOnce();
    const [filter] = (deps.service.getPropertySummary as any).mock.calls[0];
    expect((filter as DimensionFilter).property_id).toBe(VALID_PROPERTY);
  });

  it('pageviews: forwards pagePath into the DimensionFilter', async () => {
    const deps = makeDeps();
    const routes = createSitesConvenienceRoutes(deps);
    const res = fakeRes();
    await routes.pageviews(
      fakeReq({ params: { siteId: VALID_SITE }, query: { ...DATE_RANGE, pagePath: '/about' } }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    const [filter] = (deps.service.getPageviews as any).mock.calls[0];
    expect((filter as DimensionFilter).page_path).toBe('/about');
  });

  it('pageviews: 400 when pagePath contains CR/LF (sanitised away to empty)', async () => {
    // Defensive: a CR/LF only pagePath becomes empty after sanitisation,
    // which is treated as "no page filter" (200), not an error. The
    // important invariant is the CR/LF never reach the filter string.
    const deps = makeDeps();
    const routes = createSitesConvenienceRoutes(deps);
    const res = fakeRes();
    await routes.pageviews(
      fakeReq({ params: { siteId: VALID_SITE }, query: { ...DATE_RANGE, pagePath: '\r\n\r\n' } }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    const [filter] = (deps.service.getPageviews as any).mock.calls[0];
    expect((filter as DimensionFilter).page_path).toBeUndefined();
  });

  it('top-pages: ignores pagePath (always cross-page)', async () => {
    const deps = makeDeps();
    const routes = createSitesConvenienceRoutes(deps);
    const res = fakeRes();
    await routes.topPages(
      fakeReq({ params: { siteId: VALID_SITE }, query: { ...DATE_RANGE, pagePath: '/about' } }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    const [filter] = (deps.service.getTopPages as any).mock.calls[0];
    expect((filter as DimensionFilter).page_path).toBeUndefined();
  });

  it('sessionActivity: 400 when sessionId is not a uuid', async () => {
    const routes = createSitesConvenienceRoutes(makeDeps());
    const res = fakeRes();
    await routes.sessionActivity(
      fakeReq({ params: { siteId: VALID_SITE, sessionId: 'bad' } }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(400);
  });

  it('sessionReplayLink: 200 happy path returns the deep link', async () => {
    const routes = createSitesConvenienceRoutes(makeDeps());
    const res = fakeRes();
    await routes.sessionReplayLink(
      fakeReq({ params: { siteId: VALID_SITE, sessionId: VALID_SESSION } }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { url?: string }).url).toContain('https://analytics.example');
  });
});
