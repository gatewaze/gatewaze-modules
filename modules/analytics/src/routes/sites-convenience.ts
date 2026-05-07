/**
 * Site-scoped convenience routes — same dashboard surface as
 * `dashboards.ts`, but addressed by `siteId` instead of `propertyId`.
 *
 * Per spec-analytics-module §11.3 follow-up. The sites editor doesn't
 * know its analytics property uuid; it knows the site it's editing.
 * Each handler:
 *   1. Looks up the property attached to that site via
 *      analytics_properties WHERE host_kind='site' AND host_id=:siteId.
 *   2. Optionally narrows by `?pagePath=` (drives the per-page tab).
 *   3. Delegates to the shared AnalyticsService.
 *
 * The actual analytics auth check (read access to the property) is
 * still enforced by analyticsService — these routes just resolve
 * siteId → propertyId and proxy.
 */

import type { Request, Response, Router } from 'express';
import type {
  AnalyticsService,
  Bucket,
  DateRange,
  DimensionFilter,
  ServiceResult,
} from '../service/contract.js';

export interface SitesConvenienceRoutesDeps {
  service: AnalyticsService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- module workspace can't see Database types under tsc --noEmit
  supabase: any;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  getUserId: (req: Request) => string | null;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;
const VALID_BUCKETS = new Set<Bucket>(['hour', 'day', 'week', 'month']);
// page_path is at most a URL path — strip CR/LF defensively, cap length,
// keep it printable. Stricter than the analytics property surface because
// it goes straight into a PostgREST `.eq` filter on Umami's metric API.
const MAX_PAGE_PATH = 1000;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function unwrapResult<T>(
  res: Response,
  result: ServiceResult<T>,
  body: (data: T, cacheHit: boolean) => Record<string, unknown>,
): void {
  if (result.ok) {
    if (result.cacheHit) res.setHeader('X-Analytics-Cache', 'hit');
    res.status(200).json(body(result.data, result.cacheHit));
    return;
  }
  switch (result.reason) {
    case 'forbidden':
      sendError(res, 403, 'forbidden', result.message);
      return;
    case 'property_not_found':
      sendError(res, 404, 'not_found', result.message);
      return;
    case 'invalid_input':
      sendError(res, 400, 'validation_failed', result.message);
      return;
    case 'upstream_unavailable':
      sendError(res, 502, 'upstream_unavailable', result.message);
      return;
  }
}

function parseDateRange(req: Request): DateRange | { error: string } {
  const from = typeof req.query['from'] === 'string' ? (req.query['from'] as string) : '';
  const to = typeof req.query['to'] === 'string' ? (req.query['to'] as string) : '';
  if (!from || !to) return { error: 'from and to query params required (ISO 8601)' };
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return { error: 'from and to must parse as ISO 8601' };
  }
  if (Date.parse(from) >= Date.parse(to)) return { error: 'from must be before to' };
  return { from, to };
}

function parsePagePath(req: Request): string | null | { error: string } {
  const raw = req.query['pagePath'];
  if (raw === undefined) return null;
  if (typeof raw !== 'string') return { error: 'pagePath must be a string' };
  // Defensive sanitisation — strip CR/LF (PostgREST filter injection
  // surface), cap length so a misbehaving caller can't DOS by sending a
  // 100MB query param.
  const cleaned = raw.replace(/[\r\n]/g, '').trim();
  if (!cleaned) return null;
  if (cleaned.length > MAX_PAGE_PATH) return { error: `pagePath must be <= ${MAX_PAGE_PATH} chars` };
  return cleaned;
}

export function createSitesConvenienceRoutes(deps: SitesConvenienceRoutesDeps) {
  /**
   * Resolves the site_id to its analytics property_id. Sends an HTTP
   * error response and returns null on failure (caller short-circuits).
   */
  async function resolvePropertyForSite(
    req: Request,
    res: Response,
  ): Promise<{ propertyId: string; pagePath: string | null } | null> {
    const userId = deps.getUserId(req);
    if (!userId) {
      sendError(res, 401, 'unauthenticated', 'session required');
      return null;
    }
    const siteId = req.params['siteId'];
    if (!siteId || !UUID_RE.test(siteId)) {
      sendError(res, 400, 'validation_failed', 'siteId must be a uuid');
      return null;
    }
    const pagePath = parsePagePath(req);
    if (pagePath !== null && typeof pagePath === 'object') {
      sendError(res, 400, 'validation_failed', pagePath.error);
      return null;
    }

    // host_kind=site is the analytics-module-side discriminator. The
    // property table is owned by the analytics module; sites have at
    // most one property each (enforced by a partial unique index).
    const { data, error } = await deps.supabase
      .from('analytics_properties')
      .select('property_id')
      .eq('host_kind', 'site')
      .eq('host_id', siteId)
      .maybeSingle();
    if (error) {
      deps.logger.error('site_property_lookup_failed', { siteId, error: error.message });
      sendError(res, 500, 'internal_error', 'failed to resolve site property');
      return null;
    }
    if (!data?.property_id) {
      sendError(res, 404, 'not_found', `no analytics property for site ${siteId}`);
      return null;
    }
    return { propertyId: data.property_id, pagePath };
  }

  function buildFilter(propertyId: string, pagePath: string | null): DimensionFilter {
    return pagePath ? { property_id: propertyId, page_path: pagePath } : { property_id: propertyId };
  }

  // ---------------------------------------------------------------------------
  // GET /sites/:siteId/analytics/summary?from&to&pagePath?
  // ---------------------------------------------------------------------------
  async function summary(req: Request, res: Response): Promise<void> {
    const ctx = await resolvePropertyForSite(req, res);
    if (!ctx) return;
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);
    const result = await deps.service.getPropertySummary(buildFilter(ctx.propertyId, ctx.pagePath), range);
    unwrapResult(res, result, (data) => ({ summary: data }));
  }

  // ---------------------------------------------------------------------------
  // GET /sites/:siteId/analytics/pageviews?from&to&bucket&pagePath?
  // ---------------------------------------------------------------------------
  async function pageviews(req: Request, res: Response): Promise<void> {
    const ctx = await resolvePropertyForSite(req, res);
    if (!ctx) return;
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);
    const bucket = ((req.query['bucket'] ?? 'day') as string) as Bucket;
    if (!VALID_BUCKETS.has(bucket)) {
      return sendError(res, 400, 'validation_failed', `bucket must be one of ${[...VALID_BUCKETS].join(', ')}`);
    }
    const result = await deps.service.getPageviews(buildFilter(ctx.propertyId, ctx.pagePath), range, bucket);
    unwrapResult(res, result, (data) => ({ pageviews: data }));
  }

  // ---------------------------------------------------------------------------
  // GET /sites/:siteId/analytics/top-pages?from&to&limit
  // (pagePath ignored — top-pages is inherently cross-page)
  // ---------------------------------------------------------------------------
  async function topPages(req: Request, res: Response): Promise<void> {
    const ctx = await resolvePropertyForSite(req, res);
    if (!ctx) return;
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);
    const limit = parseLimit(req);
    const result = await deps.service.getTopPages({ property_id: ctx.propertyId }, range, limit);
    unwrapResult(res, result, (data) => ({ pages: data }));
  }

  // ---------------------------------------------------------------------------
  // GET /sites/:siteId/analytics/referrers?from&to&limit&pagePath?
  // ---------------------------------------------------------------------------
  async function topReferrers(req: Request, res: Response): Promise<void> {
    const ctx = await resolvePropertyForSite(req, res);
    if (!ctx) return;
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);
    const limit = parseLimit(req);
    const result = await deps.service.getTopReferrers(buildFilter(ctx.propertyId, ctx.pagePath), range, limit);
    unwrapResult(res, result, (data) => ({ referrers: data }));
  }

  // ---------------------------------------------------------------------------
  // GET /sites/:siteId/analytics/realtime
  // ---------------------------------------------------------------------------
  async function realtime(req: Request, res: Response): Promise<void> {
    const ctx = await resolvePropertyForSite(req, res);
    if (!ctx) return;
    const result = await deps.service.getRealtime({ property_id: ctx.propertyId });
    unwrapResult(res, result, (data) => ({ realtime: data }));
  }

  // ---------------------------------------------------------------------------
  // GET /sites/:siteId/analytics/cohorts?from&to&bucket
  // ---------------------------------------------------------------------------
  async function cohorts(req: Request, res: Response): Promise<void> {
    const ctx = await resolvePropertyForSite(req, res);
    if (!ctx) return;
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);
    const bucketRaw = (req.query['bucket'] ?? 'week') as string;
    const valid = new Set(['day', 'week', 'month']);
    if (!valid.has(bucketRaw)) return sendError(res, 400, 'validation_failed', 'bucket must be day|week|month');
    const result = await deps.service.getCohortRetention(
      { property_id: ctx.propertyId },
      range,
      bucketRaw as 'day' | 'week' | 'month',
    );
    unwrapResult(res, result, (data) => ({ cohorts: data }));
  }

  // ---------------------------------------------------------------------------
  // GET /sites/:siteId/analytics/retention-curve?from&to&horizonDays
  // ---------------------------------------------------------------------------
  async function retentionCurve(req: Request, res: Response): Promise<void> {
    const ctx = await resolvePropertyForSite(req, res);
    if (!ctx) return;
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);
    const horizonRaw = req.query['horizonDays'];
    const horizon = typeof horizonRaw === 'string' ? Math.min(Math.max(parseInt(horizonRaw, 10) || 30, 1), 90) : 30;
    const result = await deps.service.getRetentionCurve({ property_id: ctx.propertyId }, range, horizon);
    unwrapResult(res, result, (data) => ({ retention: data }));
  }

  // ---------------------------------------------------------------------------
  // GET /sites/:siteId/analytics/sessions?from&to&page&pageSize
  // ---------------------------------------------------------------------------
  async function listSessions(req: Request, res: Response): Promise<void> {
    const ctx = await resolvePropertyForSite(req, res);
    if (!ctx) return;
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);
    const pageRaw = req.query['page'];
    const sizeRaw = req.query['pageSize'];
    const page = typeof pageRaw === 'string' ? Math.max(parseInt(pageRaw, 10) || 1, 1) : 1;
    const pageSize = typeof sizeRaw === 'string' ? Math.min(Math.max(parseInt(sizeRaw, 10) || 20, 1), 100) : 20;
    const result = await deps.service.listSessions({ property_id: ctx.propertyId }, range, page, pageSize);
    unwrapResult(res, result, (data) => ({ ...data }));
  }

  // ---------------------------------------------------------------------------
  // GET /sites/:siteId/analytics/sessions/:sessionId/activity
  // ---------------------------------------------------------------------------
  async function sessionActivity(req: Request, res: Response): Promise<void> {
    const ctx = await resolvePropertyForSite(req, res);
    if (!ctx) return;
    const sessionId = req.params['sessionId'];
    if (!sessionId || !UUID_RE.test(sessionId)) return sendError(res, 400, 'validation_failed', 'sessionId must be a uuid');
    const result = await deps.service.getSessionActivity({ property_id: ctx.propertyId }, sessionId);
    unwrapResult(res, result, (data) => ({ activity: data }));
  }

  // ---------------------------------------------------------------------------
  // GET /sites/:siteId/analytics/sessions/:sessionId/replay-link
  // ---------------------------------------------------------------------------
  async function sessionReplayLink(req: Request, res: Response): Promise<void> {
    const ctx = await resolvePropertyForSite(req, res);
    if (!ctx) return;
    const sessionId = req.params['sessionId'];
    if (!sessionId || !UUID_RE.test(sessionId)) return sendError(res, 400, 'validation_failed', 'sessionId must be a uuid');
    const result = await deps.service.getReplayDeepLink({ property_id: ctx.propertyId }, sessionId);
    unwrapResult(res, result, (data) => ({ ...data }));
  }

  return {
    summary,
    pageviews,
    topPages,
    topReferrers,
    realtime,
    cohorts,
    retentionCurve,
    listSessions,
    sessionActivity,
    sessionReplayLink,
  };
}

function parseLimit(req: Request): number {
  const raw = req.query['limit'];
  return typeof raw === 'string' ? Math.min(Math.max(parseInt(raw, 10) || 10, 1), 100) : 10;
}

export function mountSitesConvenienceRoutes(
  router: Router,
  routes: ReturnType<typeof createSitesConvenienceRoutes>,
): void {
  router.get('/sites/:siteId/analytics/summary', routes.summary);
  router.get('/sites/:siteId/analytics/pageviews', routes.pageviews);
  router.get('/sites/:siteId/analytics/top-pages', routes.topPages);
  router.get('/sites/:siteId/analytics/referrers', routes.topReferrers);
  router.get('/sites/:siteId/analytics/realtime', routes.realtime);
  router.get('/sites/:siteId/analytics/cohorts', routes.cohorts);
  router.get('/sites/:siteId/analytics/retention-curve', routes.retentionCurve);
  router.get('/sites/:siteId/analytics/sessions', routes.listSessions);
  router.get('/sites/:siteId/analytics/sessions/:sessionId/activity', routes.sessionActivity);
  router.get('/sites/:siteId/analytics/sessions/:sessionId/replay-link', routes.sessionReplayLink);
}
