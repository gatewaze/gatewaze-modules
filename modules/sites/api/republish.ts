/**
 * Republish API — manual trigger + HMAC-signed webhook receiver +
 * MCP tool stubs.
 *
 * Per spec-content-modules-git-architecture §6.7 + §22.1:
 *   POST /api/sites/:id/publish                       — manual / API trigger
 *   POST /api/sites/:id/republish-webhook/rotate      — rotate webhook secret
 *   POST /api/webhooks/republish/:siteSlug            — HMAC-signed webhook receive
 *
 * The actual publish work runs asynchronously through a worker; these
 * endpoints enqueue and return 202 with a publishId.
 *
 * Concurrency: per-site Postgres advisory lock prevents double-publish.
 *
 * MCP tools (gatewaze.republish, gatewaze.send_edition) are exported as
 * thin wrappers over the same publishWorker.enqueueRepublish call — see
 * mcp-tools.ts in the same module.
 */

import type { Request, Response, Router } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Narrow Supabase surface for the republish-related tables
// ---------------------------------------------------------------------------

interface RepublishSupabaseQuery {
  select(cols: string): RepublishSupabaseQuery;
  insert(values: Record<string, unknown>): RepublishSupabaseQuery;
  update(values: Record<string, unknown>): RepublishSupabaseQuery;
  /**
   * `.eq()` is also awaitable when terminating an `update()` chain — the
   * postgrest-js client returns the result envelope directly.
   */
  eq(col: string, val: unknown): RepublishSupabaseQuery & PromiseLike<{ data: unknown; error: { message: string } | null }>;
  single<T = Record<string, unknown>>(): Promise<{ data: T | null; error: { message: string } | null }>;
}

export interface RepublishSupabaseClient {
  from(table: string): RepublishSupabaseQuery;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface RepublishRoutesDeps {
  supabase: RepublishSupabaseClient;
  publishWorker: {
    /**
     * Enqueue a publish job. Returns the publishId immediately; the worker
     * picks it up async, runs build-time fetchers, writes content/*.json,
     * commits, tags, pushes. Failure is recorded in site_republish_log.
     */
    enqueueRepublish(args: {
      siteId: string;
      triggerKind: 'manual' | 'scheduled' | 'webhook' | 'mcp';
      triggeredBy: string | null;
      webhookRequestId?: string;
      reason?: string;
      pages?: string[];
      force?: boolean;
    }): Promise<{ publishId: string; status: 'pending' }>;
  };
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  rateLimit: (key: string, max: number, windowMs: number) => Promise<{ allowed: boolean; resetAt: number }>;
}

interface RequestWithUser extends Request {
  user?: { id: string };
}

interface PublishResponseSuccess {
  publishId: string;
  status: 'pending';
  tag: string | null;
  estimatedCompletionAt: string;
  trackUrl: string;
}

interface ErrorEnvelope {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

// ===========================================================================
// Manual / API-driven publish
// ===========================================================================

export function createRepublishRoutes(deps: RepublishRoutesDeps) {
  const { supabase, publishWorker, logger, rateLimit } = deps;

  /**
   * POST /admin/sites/:id/publish
   * Body: { tag_suffix?, reason?, force?, pages? }
   * Auth: admin JWT (verified upstream)
   */
  async function publishSite(req: RequestWithUser, res: Response): Promise<void> {
    const rawId = req.params.id;
    const siteId = typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] : undefined;
    if (!siteId) {
      res.status(400).json({ error: 'missing_site_id', message: 'site id required' } satisfies ErrorEnvelope);
      return;
    }
    const userId = req.user?.id ?? null;
    const body = req.body ?? {};
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined;
    const force = body.force === true;
    const pages = Array.isArray(body.pages) ? body.pages.filter((p: unknown) => typeof p === 'string').slice(0, 100) : undefined;

    try {
      const { publishId, status } = await publishWorker.enqueueRepublish({
        siteId,
        triggerKind: 'manual',
        triggeredBy: userId,
        reason,
        pages,
        force,
      });
      logger.info('publish enqueued', { siteId, publishId, triggerKind: 'manual', userId });
      res.status(202).json({
        publishId,
        status,
        tag: null,
        estimatedCompletionAt: new Date(Date.now() + 8000).toISOString(),
        trackUrl: `/api/sites/${siteId}/publishes/${publishId}`,
      } satisfies PublishResponseSuccess);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      if (message.includes('publish_in_progress')) {
        res.status(409).json({
          error: 'publish_in_progress',
          message: 'Another publish for this site is already running.',
        } satisfies ErrorEnvelope);
        return;
      }
      logger.error('publish enqueue failed', { siteId, error: message });
      res.status(503).json({ error: 'publish_failed', message } satisfies ErrorEnvelope);
    }
  }

  /**
   * POST /admin/sites/:id/republish-webhook/rotate
   * Generates a new HMAC secret, stores it, returns it ONCE.
   */
  async function rotateWebhookSecret(req: RequestWithUser, res: Response): Promise<void> {
    const rawId = req.params.id;
    const siteId = typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] : undefined;
    if (!siteId) {
      res.status(400).json({ error: 'missing_site_id', message: 'site id required' } satisfies ErrorEnvelope);
      return;
    }
    const newSecret = randomBytes(32).toString('hex');
    const { error } = await supabase
      .from('sites')
      .update({ republish_webhook_secret: newSecret })
      .eq('id', siteId);
    if (error) {
      logger.error('rotate webhook secret failed', { siteId, error: error.message });
      res.status(500).json({ error: 'db_error', message: error.message } satisfies ErrorEnvelope);
      return;
    }
    res.status(200).json({ newSecret });
  }

  // ===========================================================================
  // Public webhook receiver
  // ===========================================================================

  /**
   * POST /webhooks/republish/:siteSlug
   * Headers: X-Gatewaze-Signature, X-Request-Id
   * Body: arbitrary JSON (signed)
   *
   * Validates HMAC; checks rate limit; checks dedup against
   * site_republish_log.webhook_request_id; enqueues publish; returns 202.
   */
  async function handleRepublishWebhook(req: Request, res: Response): Promise<void> {
    const rawSlug = req.params.siteSlug;
    const siteSlug = typeof rawSlug === 'string' ? rawSlug : Array.isArray(rawSlug) ? rawSlug[0] : undefined;
    if (!siteSlug) {
      res.status(400).json({ error: 'missing_site_slug', message: 'site slug required' } satisfies ErrorEnvelope);
      return;
    }
    const signatureHeader = req.header('x-gatewaze-signature') ?? '';
    const requestId = req.header('x-request-id') ?? '';

    if (!signatureHeader || !requestId) {
      res.status(400).json({
        error: 'missing_webhook_headers',
        message: 'X-Gatewaze-Signature and X-Request-Id are required',
      } satisfies ErrorEnvelope);
      return;
    }

    // Resolve site by slug
    const { data: site, error: siteErr } = await supabase
      .from('sites')
      .select('id, republish_webhook_secret')
      .eq('slug', siteSlug)
      .single<{ id: string; republish_webhook_secret: string | null }>();
    if (siteErr || !site || !site.republish_webhook_secret) {
      // Don't leak existence — webhook callers either have a secret or they don't.
      res.status(403).json({
        error: 'invalid_webhook_signature',
        message: 'Signature validation failed',
      } satisfies ErrorEnvelope);
      return;
    }

    // Rate limit (10 req/min per site)
    const limit = await rateLimit(`republish-webhook:${site.id}`, 10, 60_000);
    if (!limit.allowed) {
      res.status(429).json({
        error: 'rate_limited',
        message: 'Webhook rate limit exceeded',
        details: { resetAt: new Date(limit.resetAt).toISOString() },
      } satisfies ErrorEnvelope);
      return;
    }

    // Validate HMAC (timing-safe)
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const expected = createHmac('sha256', site.republish_webhook_secret).update(rawBody).digest('hex');
    const provided = signatureHeader.replace(/^sha256=/, '');
    let valid = false;
    try {
      valid = expected.length === provided.length
        && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
    } catch {
      valid = false;
    }
    if (!valid) {
      logger.warn('webhook signature invalid', { siteId: site.id, requestId });
      res.status(403).json({
        error: 'invalid_webhook_signature',
        message: 'Signature validation failed',
      } satisfies ErrorEnvelope);
      return;
    }

    // Dedup against site_republish_log.webhook_request_id
    // (the UNIQUE INDEX created in 019_republish_log.sql enforces; we just enqueue
    // and let the DB-side index reject duplicates — handled below)
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : 'webhook trigger';

    try {
      const { publishId, status } = await publishWorker.enqueueRepublish({
        siteId: site.id,
        triggerKind: 'webhook',
        triggeredBy: null,
        webhookRequestId: requestId,
        reason,
      });
      res.status(202).json({ publishId, status });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      if (message.includes('webhook_replay_detected') || message.includes('duplicate key')) {
        res.status(409).json({
          error: 'webhook_replay_detected',
          message: 'This X-Request-Id has already been processed within the 24h window',
        } satisfies ErrorEnvelope);
        return;
      }
      logger.error('webhook enqueue failed', { siteId: site.id, error: message });
      res.status(503).json({ error: 'publish_failed', message } satisfies ErrorEnvelope);
    }
  }

  return { publishSite, rotateWebhookSecret, handleRepublishWebhook };
}

export function mountRepublishRoutes(
  router: Router,
  routes: ReturnType<typeof createRepublishRoutes>,
  publicRouter?: Router,
): void {
  router.post('/sites/:id/publish', routes.publishSite);
  router.post('/sites/:id/republish-webhook/rotate', routes.rotateWebhookSecret);
  // Webhook receiver mounts on the public router (no JWT required)
  if (publicRouter) {
    publicRouter.post('/webhooks/republish/:siteSlug', routes.handleRepublishWebhook);
  }
}
