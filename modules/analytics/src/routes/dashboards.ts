/**
 * Dashboard routes — thin wrappers over analyticsService methods.
 *
 * Per spec-analytics-module §11.2.
 *
 * Each handler:
 *   1. Pulls the property id from the path
 *   2. Validates date-range query params
 *   3. Delegates to the injected AnalyticsService
 *   4. Surfaces ServiceResult discriminator (forbidden / not_found /
 *      upstream_unavailable) as appropriate HTTP status
 */

import type { Request, Response, Router } from 'express';
import type { AnalyticsService, BreakdownType, Bucket, ServiceResult } from '../service/contract.js';

export interface DashboardsRoutesDeps {
  service: AnalyticsService;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  getUserId: (req: Request) => string | null;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;
const VALID_BUCKETS = new Set<Bucket>(['hour', 'day', 'week', 'month']);
const VALID_BREAKDOWNS = new Set<BreakdownType>([
  'path', 'referrer', 'browser', 'os', 'device', 'country', 'region', 'city',
  'language', 'title', 'event', 'hostname', 'query', 'tag',
]);

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function unwrapResult<T>(res: Response, result: ServiceResult<T>, body: (data: T, cacheHit: boolean) => Record<string, unknown>): void {
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

interface DateRangeQuery {
  from: string;
  to: string;
}

function parseDateRange(req: Request): DateRangeQuery | { error: string } {
  const from = typeof req.query['from'] === 'string' ? (req.query['from'] as string) : '';
  const to = typeof req.query['to'] === 'string' ? (req.query['to'] as string) : '';
  if (!from || !to) return { error: 'from and to query params required (ISO 8601)' };
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return { error: 'from and to must parse as ISO 8601' };
  }
  if (Date.parse(from) >= Date.parse(to)) return { error: 'from must be before to' };
  return { from, to };
}

export function createDashboardsRoutes(deps: DashboardsRoutesDeps) {
  // -------------------------------------------------------------------------
  // GET /properties/:id/summary?from&to
  // -------------------------------------------------------------------------
  async function summary(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);

    const result = await deps.service.getPropertySummary({ property_id: id }, range);
    unwrapResult(res, result, (data) => ({ summary: data }));
  }

  // -------------------------------------------------------------------------
  // GET /properties/:id/overview?from&to — Umami-style headline stats
  // -------------------------------------------------------------------------
  async function overview(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);

    const result = await deps.service.getOverview({ property_id: id }, range);
    unwrapResult(res, result, (data) => ({ overview: data }));
  }

  // -------------------------------------------------------------------------
  // GET /properties/:id/breakdown?from&to&type&limit — generic dimension table
  // -------------------------------------------------------------------------
  async function breakdown(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);
    const type = (req.query['type'] ?? '') as string;
    if (!VALID_BREAKDOWNS.has(type as BreakdownType)) {
      return sendError(res, 400, 'validation_failed', `type must be one of ${[...VALID_BREAKDOWNS].join(', ')}`);
    }
    const limit = Math.min(Math.max(parseInt((req.query['limit'] ?? '10') as string, 10) || 10, 1), 50);

    const result = await deps.service.getBreakdown({ property_id: id }, range, type as BreakdownType, limit);
    unwrapResult(res, result, (data) => ({ rows: data }));
  }

  // -------------------------------------------------------------------------
  // POST /properties/:id/reports/funnel?from&to — ad-hoc funnel
  // Body: { steps: [{type:'path'|'event', value}], window?: minutes }
  // -------------------------------------------------------------------------
  async function reportFunnel(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);

    const body = req.body as { steps?: unknown; window?: unknown } | undefined;
    const rawSteps = Array.isArray(body?.steps) ? body!.steps : [];
    const steps = rawSteps
      .filter((st): st is { type: string; value: string } =>
        !!st && typeof st === 'object'
        && ((st as { type?: unknown }).type === 'path' || (st as { type?: unknown }).type === 'event')
        && typeof (st as { value?: unknown }).value === 'string'
        && ((st as { value: string }).value.length > 0))
      .slice(0, 8)
      .map((st) => ({ type: st.type as 'path' | 'event', value: st.value.slice(0, 500) }));
    if (steps.length < 2) return sendError(res, 400, 'validation_failed', 'at least 2 valid steps required');
    const windowMinutes = Math.min(Math.max(Number(body?.window) || 60, 1), 24 * 60);

    const result = await deps.service.runFunnel({ property_id: id }, range, steps, windowMinutes);
    unwrapResult(res, result, (data) => ({ steps: data }));
  }

  // -------------------------------------------------------------------------
  // POST /properties/:id/reports/journey?from&to — common visitor paths
  // Body: { steps?: 2..7, startStep?, endStep? }
  // -------------------------------------------------------------------------
  async function reportJourney(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);

    const body = req.body as { steps?: unknown; startStep?: unknown; endStep?: unknown } | undefined;
    const steps = Math.min(Math.max(Number(body?.steps) || 3, 2), 7);
    const startStep = typeof body?.startStep === 'string' && body.startStep ? body.startStep.slice(0, 500) : undefined;
    const endStep = typeof body?.endStep === 'string' && body.endStep ? body.endStep.slice(0, 500) : undefined;

    const result = await deps.service.runJourney({ property_id: id }, range, steps, startStep, endStep);
    unwrapResult(res, result, (data) => ({ journeys: data }));
  }

  // -------------------------------------------------------------------------
  // GET /properties/:id/utm?from&to — UTM campaign breakdowns
  // -------------------------------------------------------------------------
  async function utm(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);

    const result = await deps.service.runUtm({ property_id: id }, range);
    unwrapResult(res, result, (data) => ({ utm: data }));
  }

  // -------------------------------------------------------------------------
  // GET /relay-status — is the platform's server-side Segment leg configured?
  // Non-secret boolean only; lets the settings UI show the effective config
  // (the write key itself lives in deployment env, never per-property).
  // -------------------------------------------------------------------------
  async function relayStatus(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    res.json({ segment_configured: Boolean(process.env['SEGMENT_WRITE_KEY']) });
  }

  // -------------------------------------------------------------------------
  // GET /properties/:id/pageviews?from&to&bucket
  // -------------------------------------------------------------------------
  async function pageviews(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);
    const bucketRaw = (req.query['bucket'] ?? 'day') as string;
    const bucket = bucketRaw as Bucket;
    if (!VALID_BUCKETS.has(bucket)) return sendError(res, 400, 'validation_failed', `bucket must be one of ${[...VALID_BUCKETS].join(', ')}`);

    const result = await deps.service.getPageviews({ property_id: id }, range, bucket);
    unwrapResult(res, result, (data) => ({ pageviews: data }));
  }

  // -------------------------------------------------------------------------
  // GET /properties/:id/top-pages?from&to&limit
  // -------------------------------------------------------------------------
  async function topPages(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);
    const limitRaw = req.query['limit'];
    const limit = typeof limitRaw === 'string' ? Math.min(Math.max(parseInt(limitRaw, 10) || 10, 1), 100) : 10;

    const result = await deps.service.getTopPages({ property_id: id }, range, limit);
    unwrapResult(res, result, (data) => ({ pages: data }));
  }

  // -------------------------------------------------------------------------
  // GET /properties/:id/referrers?from&to&limit
  // -------------------------------------------------------------------------
  async function topReferrers(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);
    const limit = typeof req.query['limit'] === 'string' ? Math.min(Math.max(parseInt(req.query['limit'] as string, 10) || 10, 1), 100) : 10;

    const result = await deps.service.getTopReferrers({ property_id: id }, range, limit);
    unwrapResult(res, result, (data) => ({ referrers: data }));
  }

  // -------------------------------------------------------------------------
  // GET /properties/:id/events?eventName&from&to
  // -------------------------------------------------------------------------
  async function events(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');
    const eventName = typeof req.query['eventName'] === 'string' ? (req.query['eventName'] as string).trim() : '';
    if (!eventName || eventName.length > 100) return sendError(res, 400, 'validation_failed', 'eventName required (1..100 chars)');
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);

    const result = await deps.service.getCustomEvents({ property_id: id }, eventName, range);
    unwrapResult(res, result, (data) => ({ event: data }));
  }

  // -------------------------------------------------------------------------
  // GET /properties/:id/realtime
  // -------------------------------------------------------------------------
  async function realtime(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');

    const result = await deps.service.getRealtime({ property_id: id });
    unwrapResult(res, result, (data) => ({ realtime: data }));
  }

  // -------------------------------------------------------------------------
  // GET /properties/:id/cohorts?from&to&bucket
  // -------------------------------------------------------------------------
  async function cohorts(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);
    const bucketRaw = (req.query['bucket'] ?? 'week') as string;
    const validBuckets = new Set(['day', 'week', 'month']);
    if (!validBuckets.has(bucketRaw)) return sendError(res, 400, 'validation_failed', 'bucket must be day|week|month');

    const result = await deps.service.getCohortRetention(
      { property_id: id },
      range,
      bucketRaw as 'day' | 'week' | 'month',
    );
    unwrapResult(res, result, (data) => ({ cohorts: data }));
  }

  // -------------------------------------------------------------------------
  // GET /properties/:id/retention-curve?from&to&horizonDays
  // -------------------------------------------------------------------------
  async function retentionCurve(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);
    const horizonRaw = req.query['horizonDays'];
    const horizon = typeof horizonRaw === 'string' ? Math.min(Math.max(parseInt(horizonRaw, 10) || 30, 1), 90) : 30;

    const result = await deps.service.getRetentionCurve({ property_id: id }, range, horizon);
    unwrapResult(res, result, (data) => ({ retention: data }));
  }

  // -------------------------------------------------------------------------
  // GET /properties/:id/sessions?from&to&page&pageSize
  // -------------------------------------------------------------------------
  async function listSessions(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');
    const range = parseDateRange(req);
    if ('error' in range) return sendError(res, 400, 'validation_failed', range.error);
    const pageRaw = req.query['page'];
    const pageSizeRaw = req.query['pageSize'];
    const page = typeof pageRaw === 'string' ? Math.max(parseInt(pageRaw, 10) || 1, 1) : 1;
    const pageSize = typeof pageSizeRaw === 'string'
      ? Math.min(Math.max(parseInt(pageSizeRaw, 10) || 20, 1), 100)
      : 20;

    const result = await deps.service.listSessions({ property_id: id }, range, page, pageSize);
    unwrapResult(res, result, (data) => ({ ...data }));
  }

  // -------------------------------------------------------------------------
  // GET /properties/:id/sessions/:sessionId/activity
  // -------------------------------------------------------------------------
  async function sessionActivity(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');
    const sessionId = req.params['sessionId'];
    if (!sessionId || !UUID_RE.test(sessionId)) return sendError(res, 400, 'validation_failed', 'sessionId must be a uuid');

    const result = await deps.service.getSessionActivity({ property_id: id }, sessionId);
    unwrapResult(res, result, (data) => ({ activity: data }));
  }

  // -------------------------------------------------------------------------
  // GET /properties/:id/sessions/:sessionId/replay-link
  // Returns the Umami v3 deep link the dashboard iframes for replay.
  // -------------------------------------------------------------------------
  async function sessionReplayLink(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');
    const sessionId = req.params['sessionId'];
    if (!sessionId || !UUID_RE.test(sessionId)) return sendError(res, 400, 'validation_failed', 'sessionId must be a uuid');

    const result = await deps.service.getReplayDeepLink({ property_id: id }, sessionId);
    unwrapResult(res, result, (data) => ({ ...data }));
  }

  return {
    summary,
    overview,
    breakdown,
    reportFunnel,
    reportJourney,
    utm,
    relayStatus,
    pageviews,
    topPages,
    topReferrers,
    events,
    realtime,
    cohorts,
    retentionCurve,
    listSessions,
    sessionActivity,
    sessionReplayLink,
  };
}

export function mountDashboardsRoutes(router: Router, routes: ReturnType<typeof createDashboardsRoutes>): void {
  router.get('/relay-status', routes.relayStatus);
  router.get('/properties/:id/summary', routes.summary);
  router.get('/properties/:id/overview', routes.overview);
  router.get('/properties/:id/breakdown', routes.breakdown);
  router.get('/properties/:id/utm', routes.utm);
  router.post('/properties/:id/reports/funnel', routes.reportFunnel);
  router.post('/properties/:id/reports/journey', routes.reportJourney);
  router.get('/properties/:id/pageviews', routes.pageviews);
  router.get('/properties/:id/top-pages', routes.topPages);
  router.get('/properties/:id/referrers', routes.topReferrers);
  router.get('/properties/:id/events', routes.events);
  router.get('/properties/:id/realtime', routes.realtime);
  router.get('/properties/:id/cohorts', routes.cohorts);
  router.get('/properties/:id/retention-curve', routes.retentionCurve);
  router.get('/properties/:id/sessions', routes.listSessions);
  router.get('/properties/:id/sessions/:sessionId/activity', routes.sessionActivity);
  router.get('/properties/:id/sessions/:sessionId/replay-link', routes.sessionReplayLink);
}
