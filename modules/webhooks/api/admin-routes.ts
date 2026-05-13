/**
 * Admin endpoints for managing webhook_subscriptions (per spec §5.1).
 *
 *   GET    /admin/sites/:siteId/webhook-subscriptions
 *   POST   /admin/sites/:siteId/webhook-subscriptions
 *   PATCH  /admin/sites/:siteId/webhook-subscriptions/:id
 *   DELETE /admin/sites/:siteId/webhook-subscriptions/:id
 *   POST   /admin/sites/:siteId/webhook-subscriptions/:id/rotate-secret
 *   POST   /admin/sites/:siteId/webhook-subscriptions/:id/test
 *
 * Per the gatewaze-production-readiness skill:
 *   - PICK_* allowlists for mass-assignment guards
 *   - PostgREST `.or()` sanitisation (escapes commas/parens) — N/A here
 *     because we only filter by exact eq() on host_kind / host_id / id
 *   - No `: any`; narrow Supabase surface
 *   - Service-role client bypasses RLS — admin auth is enforced upstream
 *     by the platform's labeledRouter('jwt') + requireJwt middleware
 *
 * Rate-limit: 100 mutations / 60s per site (spec §5.1).
 */

import type { Request, Response, Router } from 'express';
import { generateWebhookSecret, signWebhook } from '../lib/hmac.js';

// ---------------------------------------------------------------------------
// Narrow Supabase surface
// ---------------------------------------------------------------------------

interface AdminSupabaseQuery {
  select(cols: string): AdminSupabaseQuery;
  insert(values: Record<string, unknown>): AdminSupabaseQuery;
  update(values: Record<string, unknown>): AdminSupabaseQuery;
  delete(): AdminSupabaseQuery;
  eq(col: string, val: unknown): AdminSupabaseQuery;
  single<T = Record<string, unknown>>(): Promise<{ data: T | null; error: { message: string } | null }>;
  maybeSingle<T = Record<string, unknown>>(): Promise<{ data: T | null; error: { message: string } | null }>;
  then<TResult>(
    onfulfilled: (value: { data: Array<Record<string, unknown>> | null; error: { message: string } | null }) => TResult,
  ): Promise<TResult>;
}

export interface AdminSupabaseClient {
  from(table: string): AdminSupabaseQuery;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MAX_URL_LENGTH = 2048;
const MAX_TOPICS_PER_SUB = 100;

// SSRF denylist — block local/private/link-local CIDRs.
const PRIVATE_HOST_REGEXES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^0\./,
  /^::1$/i,
  /^fc[0-9a-f]{2}:/i,
  /^fe80:/i,
];

interface UrlValidationResult {
  ok: boolean;
  reason?: string;
}

function validateSubscriberUrl(url: string, opts: { allowLocalhost: boolean }): UrlValidationResult {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) {
    return { ok: false, reason: `url must be a 1..${MAX_URL_LENGTH} char string` };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'url must be a valid absolute URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'url must use http or https' };
  }
  const isLocalhost =
    parsed.hostname === 'localhost'
    || parsed.hostname.endsWith('.localhost')
    || parsed.hostname === 'host.docker.internal';
  if (parsed.protocol === 'http:') {
    if (!isLocalhost && !opts.allowLocalhost) {
      return { ok: false, reason: 'http:// allowed only for localhost / *.localhost' };
    }
  }
  // Private CIDRs — allowed only when WEBHOOK_ALLOW_LOCALHOST=1 (dev).
  if (!opts.allowLocalhost && !isLocalhost) {
    for (const re of PRIVATE_HOST_REGEXES) {
      if (re.test(parsed.hostname)) {
        return { ok: false, reason: `host ${parsed.hostname} is in the private-address denylist (SSRF)` };
      }
    }
  }
  return { ok: true };
}

interface SubscriptionInput {
  url?: string;
  topics?: string[];
  status?: 'enabled' | 'disabled' | 'suspended';
}

const WRITE_FIELDS: Record<keyof SubscriptionInput, true> = {
  url: true,
  topics: true,
  status: true,
};

/** Mass-assignment guard. Mirrors sites/api/admin.ts patterns. */
function pickWriteFields(body: unknown): { ok: true; value: SubscriptionInput } | { ok: false; reason: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'request body must be an object' };
  }
  const src = body as Record<string, unknown>;
  const out: SubscriptionInput = {};
  for (const key of Object.keys(WRITE_FIELDS) as (keyof SubscriptionInput)[]) {
    if (!(key in src)) continue;
    const v = src[key];
    if (key === 'url') {
      if (typeof v !== 'string') return { ok: false, reason: 'url must be a string' };
      out.url = v;
    } else if (key === 'topics') {
      if (!Array.isArray(v)) return { ok: false, reason: 'topics must be an array of strings' };
      if (v.length > MAX_TOPICS_PER_SUB) {
        return { ok: false, reason: `topics may contain at most ${MAX_TOPICS_PER_SUB} entries` };
      }
      const dedup = new Set<string>();
      for (const t of v) {
        if (typeof t !== 'string' || t.length === 0 || t.length > 200) {
          return { ok: false, reason: 'topics[*] must be 1..200 char strings' };
        }
        dedup.add(t);
      }
      out.topics = Array.from(dedup);
    } else if (key === 'status') {
      if (v !== 'enabled' && v !== 'disabled' && v !== 'suspended') {
        return { ok: false, reason: "status must be one of 'enabled','disabled','suspended'" };
      }
      out.status = v;
    }
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface ErrorEnvelope {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

function sendError(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  const body: ErrorEnvelope = { error: code, message };
  if (details) body.details = details;
  res.status(status).json(body);
}

// ---------------------------------------------------------------------------
// Rate-limiter — same shape as sites/api/register-routes.ts defaultRateLimiter
// ---------------------------------------------------------------------------

export interface RateLimiter {
  check(key: string, max: number, windowMs: number): Promise<{ allowed: boolean; resetAt: number }>;
}

function defaultRateLimiter(): RateLimiter {
  const buckets = new Map<string, number[]>();
  return {
    async check(key, max, windowMs) {
      const now = Date.now();
      const bucket = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
      if (bucket.length >= max) {
        return { allowed: false, resetAt: (bucket[0] ?? now) + windowMs };
      }
      bucket.push(now);
      buckets.set(key, bucket);
      return { allowed: true, resetAt: now + windowMs };
    },
  };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export interface AdminRoutesDeps {
  supabase: AdminSupabaseClient;
  logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
  rateLimit?: RateLimiter;
  /** Returns the user id from a JWT-attached request. */
  getUserId?: (req: Request) => string | null;
  /** Allow localhost / private addresses (dev). Defaults to env var. */
  allowLocalhost?: boolean;
  /** Override fetch — used by the /test endpoint. */
  fetchImpl?: typeof fetch;
}

interface StoredSubscription {
  id: string;
  host_kind: string;
  host_id: string;
  url: string;
  topics: string[];
  status: 'enabled' | 'disabled' | 'suspended';
  secret: string;
  secret_previous: string | null;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure_message: string | null;
  created_at: string;
  updated_at: string;
}

const REDACTED = '<redacted>';

function redactSecret(row: StoredSubscription): Omit<StoredSubscription, 'secret' | 'secret_previous'> & { secret: string } {
  // We strip both `secret` and `secret_previous` on read; the masked
  // placeholder lets the admin UI render a "rotate" button without ever
  // seeing the value.
  const { secret: _s, secret_previous: _p, ...rest } = row;
  void _s;
  void _p;
  return { ...rest, secret: REDACTED };
}

export function createAdminRoutes(deps: AdminRoutesDeps) {
  const allowLocalhost = deps.allowLocalhost ?? (process.env.WEBHOOK_ALLOW_LOCALHOST === '1');
  const rateLimiter = deps.rateLimit ?? defaultRateLimiter();
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function rateLimit(req: Request, res: Response): Promise<boolean> {
    const siteId = req.params['siteId'] ?? 'unknown';
    const limit = await rateLimiter.check(`webhook-admin:${siteId}`, 100, 60_000);
    if (!limit.allowed) {
      sendError(res, 429, 'rate_limited', 'too many webhook admin operations', { reset_at: limit.resetAt });
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // GET /sites/:siteId/webhook-subscriptions
  // -------------------------------------------------------------------------
  async function list(req: Request, res: Response): Promise<void> {
    const siteId = req.params['siteId'];
    if (!siteId) return sendError(res, 400, 'invalid_input', 'siteId required');

    const result = await deps.supabase
      .from('webhook_subscriptions')
      .select('id, host_kind, host_id, url, topics, status, consecutive_failures, last_success_at, last_failure_at, last_failure_message, created_at, updated_at')
      .eq('host_kind', 'site')
      .eq('host_id', siteId);

    if (result.error) {
      sendError(res, 500, 'internal', result.error.message);
      return;
    }
    const rows = (result.data ?? []) as unknown as StoredSubscription[];
    res.status(200).json({ subscriptions: rows.map((r) => redactSecret(r)) });
  }

  // -------------------------------------------------------------------------
  // POST /sites/:siteId/webhook-subscriptions
  // -------------------------------------------------------------------------
  async function create(req: Request, res: Response): Promise<void> {
    if (!(await rateLimit(req, res))) return;

    const siteId = req.params['siteId'];
    if (!siteId) return sendError(res, 400, 'invalid_input', 'siteId required');

    const picked = pickWriteFields(req.body);
    if (!picked.ok) return sendError(res, 400, 'invalid_input', picked.reason);
    const { url, topics, status } = picked.value;
    if (!url) return sendError(res, 400, 'invalid_input', 'url is required');

    const urlCheck = validateSubscriberUrl(url, { allowLocalhost });
    if (!urlCheck.ok) {
      return sendError(res, 400, 'invalid_input', urlCheck.reason ?? 'invalid url');
    }

    // Topics must exist in webhook_event_topics.
    if (topics && topics.length > 0) {
      const known = await fetchKnownTopics(deps.supabase);
      const missing = topics.filter((t) => !known.has(t));
      if (missing.length > 0) {
        return sendError(res, 400, 'invalid_input', 'one or more topics are not registered', { missing });
      }
    }

    const secret = generateWebhookSecret();
    const userId = deps.getUserId?.(req) ?? null;
    const insertRes = await deps.supabase
      .from('webhook_subscriptions')
      .insert({
        host_kind: 'site',
        host_id: siteId,
        url,
        topics: topics ?? [],
        secret,
        status: status ?? 'enabled',
        created_by: userId,
      })
      .select('id, host_kind, host_id, url, topics, status, consecutive_failures, last_success_at, last_failure_at, last_failure_message, created_at, updated_at')
      .single<StoredSubscription>();

    if (insertRes.error || !insertRes.data) {
      sendError(res, 500, 'internal', insertRes.error?.message ?? 'insert failed');
      return;
    }
    const created = insertRes.data;
    deps.logger.info('webhooks.subscription_created', {
      subscription_id: created.id,
      host_kind: created.host_kind,
      host_id: created.host_id,
      url: created.url,
    });
    res.status(201).json({
      subscription: redactSecret(created),
      // Returned ONCE only — caller stores it in their theme env.
      secret,
    });
  }

  // -------------------------------------------------------------------------
  // PATCH /sites/:siteId/webhook-subscriptions/:id
  // -------------------------------------------------------------------------
  async function patch(req: Request, res: Response): Promise<void> {
    if (!(await rateLimit(req, res))) return;
    const siteId = req.params['siteId'];
    const id = req.params['id'];
    if (!siteId || !id) return sendError(res, 400, 'invalid_input', 'siteId and id required');

    const picked = pickWriteFields(req.body);
    if (!picked.ok) return sendError(res, 400, 'invalid_input', picked.reason);
    const updates: Record<string, unknown> = {};
    if (picked.value.url !== undefined) {
      const urlCheck = validateSubscriberUrl(picked.value.url, { allowLocalhost });
      if (!urlCheck.ok) return sendError(res, 400, 'invalid_input', urlCheck.reason ?? 'invalid url');
      updates['url'] = picked.value.url;
    }
    if (picked.value.topics !== undefined) {
      if (picked.value.topics.length > 0) {
        const known = await fetchKnownTopics(deps.supabase);
        const missing = picked.value.topics.filter((t) => !known.has(t));
        if (missing.length > 0) {
          return sendError(res, 400, 'invalid_input', 'one or more topics are not registered', { missing });
        }
      }
      updates['topics'] = picked.value.topics;
    }
    if (picked.value.status !== undefined) updates['status'] = picked.value.status;

    if (Object.keys(updates).length === 0) {
      return sendError(res, 400, 'invalid_input', 'no fields to update');
    }

    // If the operator is re-enabling a suspended/disabled subscription,
    // reset consecutive_failures so a stale counter doesn't immediately
    // suspend it again on the next failure.
    if (updates['status'] === 'enabled') {
      updates['consecutive_failures'] = 0;
    }

    const updateRes = await deps.supabase
      .from('webhook_subscriptions')
      .update(updates)
      .eq('id', id)
      .eq('host_kind', 'site')
      .eq('host_id', siteId)
      .select('id, host_kind, host_id, url, topics, status, consecutive_failures, last_success_at, last_failure_at, last_failure_message, created_at, updated_at')
      .single<StoredSubscription>();

    if (updateRes.error || !updateRes.data) {
      return sendError(res, 404, 'not_found', updateRes.error?.message ?? 'subscription not found');
    }
    res.status(200).json({ subscription: redactSecret(updateRes.data) });
  }

  // -------------------------------------------------------------------------
  // DELETE /sites/:siteId/webhook-subscriptions/:id
  // -------------------------------------------------------------------------
  async function remove(req: Request, res: Response): Promise<void> {
    if (!(await rateLimit(req, res))) return;
    const siteId = req.params['siteId'];
    const id = req.params['id'];
    if (!siteId || !id) return sendError(res, 400, 'invalid_input', 'siteId and id required');

    const result = await deps.supabase
      .from('webhook_subscriptions')
      .delete()
      .eq('id', id)
      .eq('host_kind', 'site')
      .eq('host_id', siteId);
    const error = (result as unknown as { error?: { message: string } | null }).error;
    if (error) {
      return sendError(res, 500, 'internal', error.message);
    }
    res.status(204).send();
  }

  // -------------------------------------------------------------------------
  // POST /sites/:siteId/webhook-subscriptions/:id/rotate-secret
  // -------------------------------------------------------------------------
  async function rotateSecret(req: Request, res: Response): Promise<void> {
    if (!(await rateLimit(req, res))) return;
    const siteId = req.params['siteId'];
    const id = req.params['id'];
    if (!siteId || !id) return sendError(res, 400, 'invalid_input', 'siteId and id required');

    // Load current secret so we can demote it to secret_previous.
    const current = await deps.supabase
      .from('webhook_subscriptions')
      .select('id, host_kind, host_id, secret')
      .eq('id', id)
      .eq('host_kind', 'site')
      .eq('host_id', siteId)
      .single<{ id: string; host_kind: string; host_id: string; secret: string }>();
    if (current.error || !current.data) {
      return sendError(res, 404, 'not_found', current.error?.message ?? 'subscription not found');
    }

    const newSecret = generateWebhookSecret();
    const upd = await deps.supabase
      .from('webhook_subscriptions')
      .update({
        secret: newSecret,
        secret_previous: current.data.secret,
        secret_rotated_at: new Date().toISOString(),
      })
      .eq('id', id);
    const error = (upd as unknown as { error?: { message: string } | null }).error;
    if (error) {
      return sendError(res, 500, 'internal', error.message);
    }
    deps.logger.info('webhooks.subscription_secret_rotated', { subscription_id: id });
    res.status(200).json({ secret: newSecret, rotated_at: new Date().toISOString() });
  }

  // -------------------------------------------------------------------------
  // POST /sites/:siteId/webhook-subscriptions/:id/test
  // Fires a synthetic test event at the subscriber URL and returns the
  // observed status. Doesn't write to webhook_deliveries (test traffic
  // doesn't pollute the audit log).
  // -------------------------------------------------------------------------
  async function sendTest(req: Request, res: Response): Promise<void> {
    if (!(await rateLimit(req, res))) return;
    const siteId = req.params['siteId'];
    const id = req.params['id'];
    if (!siteId || !id) return sendError(res, 400, 'invalid_input', 'siteId and id required');

    const sub = await deps.supabase
      .from('webhook_subscriptions')
      .select('id, host_kind, host_id, url, secret')
      .eq('id', id)
      .eq('host_kind', 'site')
      .eq('host_id', siteId)
      .single<{ id: string; host_kind: string; host_id: string; url: string; secret: string }>();
    if (sub.error || !sub.data) {
      return sendError(res, 404, 'not_found', sub.error?.message ?? 'subscription not found');
    }

    const payload = {
      id: cryptoRandomUUID(),
      event_id: cryptoRandomUUID(),
      delivered_at: Math.floor(Date.now() / 1000),
      host_kind: sub.data.host_kind,
      host_id: sub.data.host_id,
      topic: 'gatewaze.webhooks.test',
      op: 'update' as const,
      row_id: null,
      row: {},
      surrogate_keys: ['gatewaze:test'],
    };
    const rawBody = JSON.stringify(payload);
    const { signature, timestamp } = signWebhook(sub.data.secret, rawBody);

    const startedAt = Date.now();
    let status = 0;
    let body = '';
    let error: string | null = null;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5_000);
      try {
        const r = await fetchImpl(sub.data.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-gatewaze-signature': signature,
            'x-gatewaze-timestamp': String(timestamp),
            'x-gatewaze-event-id': payload.event_id,
            'x-gatewaze-delivery-id': payload.id,
            'user-agent': 'Gatewaze-Webhook/1.0 (test)',
          },
          body: rawBody,
          signal: controller.signal,
        });
        status = r.status;
        body = (await r.text().catch(() => '')).slice(0, 2048);
      } finally {
        clearTimeout(t);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const durationMs = Date.now() - startedAt;
    res.status(200).json({
      url: sub.data.url,
      status,
      duration_ms: durationMs,
      response_body_preview: body,
      error,
    });
  }

  return { list, create, patch, remove, rotateSecret, sendTest };
}

async function fetchKnownTopics(supabase: AdminSupabaseClient): Promise<Set<string>> {
  const r = await supabase.from('webhook_event_topics').select('topic');
  const rows = (r.data ?? []) as Array<{ topic: string }>;
  return new Set(rows.map((row) => row.topic));
}

// Node's `crypto.randomUUID` exists since 14.17, but the module workspace
// doesn't always type-link node:crypto from a top-level import; inline
// import keeps it test-stable.
function cryptoRandomUUID(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomUUID } = require('node:crypto') as { randomUUID(): string };
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Mount helper
// ---------------------------------------------------------------------------

export function mountAdminRoutes(router: Router, routes: ReturnType<typeof createAdminRoutes>): void {
  router.get('/sites/:siteId/webhook-subscriptions', routes.list);
  router.post('/sites/:siteId/webhook-subscriptions', routes.create);
  router.patch('/sites/:siteId/webhook-subscriptions/:id', routes.patch);
  router.delete('/sites/:siteId/webhook-subscriptions/:id', routes.remove);
  router.post('/sites/:siteId/webhook-subscriptions/:id/rotate-secret', routes.rotateSecret);
  router.post('/sites/:siteId/webhook-subscriptions/:id/test', routes.sendTest);
}
