/**
 * Public ingest routes — mounted on the portal so they're same-origin
 * with sites + portal pages.
 *
 * Per spec-analytics-module §11.3 + §14.1.
 *
 * Endpoints:
 *   POST /a/collect       — receives a single event payload, validates
 *                           Origin against the property's domains list,
 *                           rate-limits, forwards to Umami /api/send.
 *   GET  /a/script.js     — serves the Umami tracker itself, proxied from
 *                           the Umami service with its beacon path
 *                           rewritten from /api/send to /a/collect so all
 *                           browser traffic flows through our validated
 *                           ingest (the embed tags point here).
 *   GET  /a/portal-config — public discovery of the brand's portal property.
 *   GET  /a/<id>.js       — serves the pre-rendered pixel bundle for
 *                           an `external` property.
 *
 * Auth posture (per spec):
 *   - No JWT — these are public endpoints called from the browser
 *   - Origin-list check serves as the cross-origin auth boundary
 *   - Per-IP + per-property rate limits at the route level
 *   - Umami's own ingest is reached via service-role connection, never
 *     surfacing Umami credentials to the browser
 */

import type { Request, Response, Router } from 'express';
import { buildPixelBundle } from '../embed/pixel.js';

export interface IngestSupabaseClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface IngestRoutesDeps {
  supabase: IngestSupabaseClient;
  /** Forward to Umami /api/send (returns the response body). */
  umamiCollect: (payload: Record<string, unknown>, headers: Record<string, string>) => Promise<{ ok: boolean; status: number }>;
  /** Fetch the Umami tracker script (GET <umami>/script.js). */
  fetchUmamiTracker: () => Promise<{ ok: boolean; status: number; body: string }>;
  /** Decrypt a stored secret blob. */
  decryptSecret: (encrypted: Buffer | string) => string;
  /** Sliding-window rate limit. Same shape as @/lib/rate-limit. */
  rateLimit: (key: string, max: number, windowMs: number) => Promise<{ allowed: boolean; resetAt: number }>;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Per-IP req/min ingest cap. From ANALYTICS_INGEST_PER_IP_RPM. */
  perIpRpm: number;
  /** Per-property req/min ingest cap. From ANALYTICS_INGEST_PER_PROPERTY_RPM. */
  perPropertyRpm: number;
  /** Cache-Control max-age for the pixel bundle. */
  embedCacheMaxAgeSeconds: number;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

interface PropertyRow {
  property_id: string;
  kind: 'gatewaze_site' | 'gatewaze_host' | 'portal' | 'external';
  domains: string[];
  status: string;
  website_uuid: string | null;
}

/**
 * True iff the request's Origin (or Referer host as fallback) matches
 * the property's domains allowlist. '*' is honoured only for external
 * properties (the migration's CHECK constraint enforces that already).
 */
function isOriginAllowed(originHeader: string | undefined, refererHeader: string | undefined, domains: string[]): boolean {
  if (domains.includes('*')) return true;
  // Try Origin first; some browsers (Safari same-origin) omit it.
  const candidates: string[] = [];
  if (originHeader) {
    try { candidates.push(new URL(originHeader).hostname); } catch { /* malformed */ }
  }
  if (refererHeader) {
    try { candidates.push(new URL(refererHeader).hostname); } catch { /* malformed */ }
  }
  if (candidates.length === 0) return false;
  return candidates.some((host) => domains.includes(host.toLowerCase()));
}

function getClientIp(req: Request): string {
  // Prefer the platform's standard X-Forwarded-For (set by the ingress
  // controller). Fall back to req.ip; never trust unset.
  const xff = req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return req.ip ?? '0.0.0.0';
}

function sendError(res: Response, status: number, code: string, message: string, retryAfter?: number): void {
  if (retryAfter !== undefined) res.setHeader('Retry-After', String(Math.ceil(retryAfter / 1000)));
  res.status(status).json({ error: { code, message } });
}

export function createIngestRoutes(deps: IngestRoutesDeps) {
  // -------------------------------------------------------------------------
  // POST /a/collect
  // -------------------------------------------------------------------------
  async function collect(req: Request, res: Response): Promise<void> {
    const body = req.body as { website?: unknown; payload?: unknown; type?: unknown } | undefined;
    if (!body || typeof body !== 'object') return sendError(res, 400, 'validation_failed', 'body required');

    // Umami's /api/send shape nests the property under payload.website
    // ({ type, payload: { website, ... } }) — that's what the stock tracker
    // posts. Accept a top-level `website` too for hand-rolled senders.
    const nested = body.payload as { website?: unknown } | undefined;
    const propertyId = typeof body.website === 'string'
      ? body.website
      : typeof nested?.website === 'string' ? nested.website : '';
    if (!UUID_RE.test(propertyId)) return sendError(res, 400, 'validation_failed', 'website (property_id) required');

    const ip = getClientIp(req);

    // Per-IP rate limit (cheaper, fail fast)
    const ipLimit = await deps.rateLimit(`analytics-ingest:ip:${ip}`, deps.perIpRpm, 60_000);
    if (!ipLimit.allowed) {
      return sendError(res, 429, 'rate_limited', 'per-IP ingest limit exceeded', ipLimit.resetAt - Date.now());
    }

    // Look up the property to validate Origin + property-level limit
    const { data: prop } = await deps.supabase
      .from('analytics_properties')
      .select('property_id, kind, domains, status, website_uuid')
      .eq('property_id', propertyId)
      .maybeSingle<PropertyRow>();
    if (!prop || prop.status !== 'active') {
      return sendError(res, 404, 'property_not_found', 'property not found or not active');
    }
    if (!prop.website_uuid) {
      return sendError(res, 404, 'property_not_found', 'property has no provisioned website');
    }

    if (!isOriginAllowed(req.header('origin'), req.header('referer'), prop.domains)) {
      deps.logger.warn('analytics.ingest.bad_origin', {
        property_id: propertyId,
        origin: req.header('origin'),
        referer: req.header('referer'),
      });
      return sendError(res, 403, 'forbidden', 'origin not in property domains allowlist');
    }

    const propLimit = await deps.rateLimit(`analytics-ingest:prop:${propertyId}`, deps.perPropertyRpm, 60_000);
    if (!propLimit.allowed) {
      return sendError(res, 429, 'rate_limited', 'per-property ingest limit exceeded', propLimit.resetAt - Date.now());
    }

    // Forward to Umami. Headers passed through:
    //   X-Forwarded-For (Umami uses for IP hashing)
    //   User-Agent     (Umami parses to browser/OS labels)
    const upstreamHeaders: Record<string, string> = {
      'X-Forwarded-For': ip,
      'User-Agent': req.header('user-agent') ?? '',
    };

    // The browser talks in property_id (the only id we publish); Umami only
    // knows its own website_uuid — swap before forwarding.
    const forwarded: Record<string, unknown> = { ...(body as Record<string, unknown>) };
    if (typeof forwarded['website'] === 'string') forwarded['website'] = prop.website_uuid;
    if (nested && typeof nested.website === 'string') {
      forwarded['payload'] = { ...(nested as Record<string, unknown>), website: prop.website_uuid };
    }

    try {
      const result = await deps.umamiCollect(forwarded, upstreamHeaders);
      if (!result.ok) {
        deps.logger.warn('analytics.ingest.upstream_error', { property_id: propertyId, status: result.status });
        return sendError(res, 502, 'upstream_error', `umami responded ${result.status}`);
      }
      res.status(204).send();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown error';
      deps.logger.error('analytics.ingest.upstream_threw', { property_id: propertyId, error: message });
      return sendError(res, 502, 'upstream_error', message);
    }
  }

  // -------------------------------------------------------------------------
  // GET /a/<property_id>.js
  // -------------------------------------------------------------------------
  async function pixelBundle(req: Request, res: Response): Promise<void> {
    const filename = req.params['filename'];
    const match = filename ? /^([0-9a-f-]{36})\.js$/i.exec(filename) : null;
    if (!match) return sendError(res, 404, 'not_found', 'pixel not found');
    const propertyId = match[1]!;

    const { data: prop } = await deps.supabase
      .from('analytics_properties')
      .select('property_id, kind, status')
      .eq('property_id', propertyId)
      .maybeSingle<{ property_id: string; kind: PropertyRow['kind']; status: string }>();
    if (!prop || prop.status !== 'active') {
      return sendError(res, 404, 'not_found', 'pixel not found');
    }

    // Read scripts + segment key with service-role privileges
    // (the service-role client used here is wired by register-routes).
    const [scriptsRes, segmentRes] = await Promise.all([
      deps.supabase
        .from('analytics_tracking_scripts')
        .select('script_head, script_body')
        .eq('property_id', propertyId)
        .maybeSingle<{ script_head: string | null; script_body: string | null }>(),
      deps.supabase
        .from('analytics_secrets')
        .select('encrypted_value')
        .eq('property_id', propertyId)
        .eq('key', 'segment_write_key')
        .maybeSingle<{ encrypted_value: Buffer | string }>(),
    ]);

    const segmentWriteKey = segmentRes.data?.encrypted_value
      ? deps.decryptSecret(segmentRes.data.encrypted_value)
      : undefined;

    const ingestOrigin = `${req.protocol}://${req.header('host') ?? 'localhost'}`;

    const bundle = buildPixelBundle({
      property: { propertyId, kind: prop.kind },
      scriptHead: scriptsRes.data?.script_head ?? undefined,
      scriptBody: scriptsRes.data?.script_body ?? undefined,
      segmentWriteKey,
      ingestOrigin,
    });

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', `public, max-age=${deps.embedCacheMaxAgeSeconds}, stale-while-revalidate=60`);
    // CORS — required for cross-origin loads from external sites
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(bundle);
  }

  // -------------------------------------------------------------------------
  // GET /a/script.js — the Umami tracker, proxied + rewritten
  // -------------------------------------------------------------------------
  // The embed tags (render.ts) point at `${origin}/a/script.js`, but the
  // tracker itself lives on the Umami service (in-cluster, not browser-
  // reachable). Proxy it here and rewrite its beacon endpoint so events
  // POST to our validated /a/collect instead of Umami's raw /api/send
  // (the tracker builds its endpoint as `${data-host-url}/api/send`).
  let trackerCache: { body: string; fetchedAt: number } | null = null;

  async function trackerScript(_req: Request, res: Response): Promise<void> {
    const ttlMs = deps.embedCacheMaxAgeSeconds * 1000;
    if (!trackerCache || Date.now() - trackerCache.fetchedAt > ttlMs) {
      try {
        const upstream = await deps.fetchUmamiTracker();
        if (!upstream.ok) {
          deps.logger.warn('analytics.tracker.upstream_error', { status: upstream.status });
          // Serve a stale copy over an error if we have one.
          if (!trackerCache) return sendError(res, 502, 'upstream_error', `umami responded ${upstream.status}`);
        } else {
          trackerCache = {
            body: upstream.body.replace('/api/send', '/a/collect'),
            fetchedAt: Date.now(),
          };
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : 'unknown error';
        deps.logger.error('analytics.tracker.upstream_threw', { error: message });
        if (!trackerCache) return sendError(res, 502, 'upstream_error', message);
      }
    }

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', `public, max-age=${deps.embedCacheMaxAgeSeconds}, stale-while-revalidate=60`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(trackerCache!.body);
  }

  // GET /a/portal-config — public discovery endpoint so the PORTAL app can
  // self-configure its embed without RLS access to analytics_properties: it
  // returns the active `portal` property's id (404 when none / module
  // disabled), letting the layout compose the tracker + pixel script tags.
  async function portalConfig(_req: Request, res: Response): Promise<void> {
    const { data: prop } = await deps.supabase
      .from('analytics_properties')
      .select('property_id, status')
      .eq('kind', 'portal')
      .eq('status', 'active')
      .maybeSingle<{ property_id: string; status: string }>();
    if (!prop) return sendError(res, 404, 'not_found', 'no active portal property');
    res.setHeader('Cache-Control', `public, max-age=${deps.embedCacheMaxAgeSeconds}`);
    res.json({ property_id: prop.property_id });
  }

  return { collect, pixelBundle, portalConfig, trackerScript };
}

export function mountIngestRoutes(router: Router, routes: ReturnType<typeof createIngestRoutes>): void {
  router.post('/a/collect', routes.collect);
  // Fixed paths BEFORE the :filename catch-all.
  router.get('/a/script.js', routes.trackerScript);
  router.get('/a/portal-config', routes.portalConfig);
  router.get('/a/:filename', routes.pixelBundle);
}
