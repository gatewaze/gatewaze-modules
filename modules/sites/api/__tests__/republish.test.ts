/**
 * Tests for republish API + webhook receiver.
 *
 * Covers (per gatewaze-production-readiness skill):
 *   - happy path (manual publish, webhook publish)
 *   - HMAC signature validation (valid + invalid + replay)
 *   - rate limit
 *   - missing required headers
 *   - publish_in_progress conflict
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { Request, Response } from 'express';
import { createRepublishRoutes, type RepublishRoutesDeps } from '../republish.js';

interface RecordedCall {
  table: string;
  op: 'update' | 'insert';
  values?: Record<string, unknown>;
}

function makeStubDeps(opts: {
  enqueueResult?: { publishId: string; status: 'pending' };
  enqueueError?: Error;
  siteSecret?: string | null;
  rateLimitAllowed?: boolean;
} = {}): RepublishRoutesDeps & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    supabase: {
      from(table: string) {
        return {
          select: () => ({
            eq: (col: string, val: unknown) => ({
              single: async () => ({
                data: opts.siteSecret !== undefined
                  ? { id: 'site-1', republish_webhook_secret: opts.siteSecret }
                  : { id: 'site-1', republish_webhook_secret: 'shared-secret' },
                error: null,
              }),
            }),
          }),
          insert: (values: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                calls.push({ table, op: 'insert', values });
                return { data: { id: 'log-1' }, error: null };
              },
            }),
          }),
          update: (values: Record<string, unknown>) => ({
            eq: async () => {
              calls.push({ table, op: 'update', values });
              return { error: null };
            },
          }),
        };
      },
      rpc: async () => ({ data: null, error: null }),
    },
    publishWorker: {
      enqueueRepublish: vi.fn(async () => {
        if (opts.enqueueError) throw opts.enqueueError;
        return opts.enqueueResult ?? { publishId: 'pub-1', status: 'pending' as const };
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    rateLimit: vi.fn(async () => ({ allowed: opts.rateLimitAllowed ?? true, resetAt: Date.now() + 60_000 })),
  };
}

function makeRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const end = vi.fn();
  const res = { status, json, end } as unknown as Response;
  return { res, status, json };
}

describe('publishSite (manual trigger)', () => {
  it('returns 202 with publishId on success', async () => {
    const deps = makeStubDeps();
    const routes = createRepublishRoutes(deps);
    const req = { params: { id: 'site-1' }, user: { id: 'admin-1' }, body: { reason: 'test publish' } } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.publishSite(req as Request & { user: { id: string } }, res);

    expect(status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      publishId: 'pub-1',
      status: 'pending',
    }));
    expect(deps.publishWorker.enqueueRepublish).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 'site-1',
      triggerKind: 'manual',
      triggeredBy: 'admin-1',
      reason: 'test publish',
    }));
  });

  it('returns 400 when site_id param missing', async () => {
    const deps = makeStubDeps();
    const routes = createRepublishRoutes(deps);
    const req = { params: {}, user: { id: 'admin-1' }, body: {} } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.publishSite(req as Request & { user: { id: string } }, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'missing_site_id' }));
  });

  it('returns 409 when publish_in_progress is thrown', async () => {
    const deps = makeStubDeps({ enqueueError: new Error('publish_in_progress: another publish for this repo is in flight') });
    const routes = createRepublishRoutes(deps);
    const req = { params: { id: 'site-1' }, user: { id: 'admin-1' }, body: {} } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.publishSite(req as Request & { user: { id: string } }, res);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'publish_in_progress' }));
  });

  it('caps reason length to 500 chars', async () => {
    const deps = makeStubDeps();
    const routes = createRepublishRoutes(deps);
    const longReason = 'X'.repeat(1000);
    const req = { params: { id: 'site-1' }, user: { id: 'admin-1' }, body: { reason: longReason } } as unknown as Request;
    const { res } = makeRes();

    await routes.publishSite(req as Request & { user: { id: string } }, res);

    const call = (deps.publishWorker.enqueueRepublish as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.reason.length).toBe(500);
  });
});

describe('handleRepublishWebhook', () => {
  function makeWebhookReq(body: unknown, signature: string, requestId: string): Request {
    return {
      params: { siteSlug: 'marketing' },
      header: (name: string) => {
        const h = name.toLowerCase();
        if (h === 'x-gatewaze-signature') return signature;
        if (h === 'x-request-id') return requestId;
        if (h === 'host') return 'api.brand.com';
        return undefined;
      },
      headers: { host: 'api.brand.com' },
      url: '/webhooks/republish/marketing',
      ip: '10.0.0.1',
      body,
      rawBody: Buffer.from(JSON.stringify(body)),
    } as unknown as Request;
  }

  it('returns 202 for valid HMAC signature', async () => {
    const deps = makeStubDeps();
    const routes = createRepublishRoutes(deps);
    const body = { reason: 'event published' };
    const sig = 'sha256=' + createHmac('sha256', 'shared-secret').update(JSON.stringify(body)).digest('hex');
    const req = makeWebhookReq(body, sig, 'req-uuid-1');
    const { res, status } = makeRes();

    await routes.handleRepublishWebhook(req, res);

    expect(status).toHaveBeenCalledWith(202);
    expect(deps.publishWorker.enqueueRepublish).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 'site-1',
      triggerKind: 'webhook',
      webhookRequestId: 'req-uuid-1',
    }));
  });

  it('returns 403 for invalid HMAC signature', async () => {
    const deps = makeStubDeps();
    const routes = createRepublishRoutes(deps);
    const req = makeWebhookReq({ reason: 'x' }, 'sha256=deadbeef00', 'req-uuid-2');
    const { res, status, json } = makeRes();

    await routes.handleRepublishWebhook(req, res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_webhook_signature' }));
    expect(deps.publishWorker.enqueueRepublish).not.toHaveBeenCalled();
  });

  it('returns 400 when X-Gatewaze-Signature header missing', async () => {
    const deps = makeStubDeps();
    const routes = createRepublishRoutes(deps);
    const req = makeWebhookReq({}, '', 'req-uuid-3');
    const { res, status, json } = makeRes();

    await routes.handleRepublishWebhook(req, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'missing_webhook_headers' }));
  });

  it('returns 429 when rate limit exceeded', async () => {
    const deps = makeStubDeps({ rateLimitAllowed: false });
    const routes = createRepublishRoutes(deps);
    const body = { reason: 'x' };
    const sig = 'sha256=' + createHmac('sha256', 'shared-secret').update(JSON.stringify(body)).digest('hex');
    const req = makeWebhookReq(body, sig, 'req-uuid-4');
    const { res, status, json } = makeRes();

    await routes.handleRepublishWebhook(req, res);

    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'rate_limited' }));
  });

  it('returns 409 on webhook_replay_detected (UNIQUE INDEX violation)', async () => {
    const deps = makeStubDeps({ enqueueError: new Error('webhook_replay_detected') });
    const routes = createRepublishRoutes(deps);
    const body = { reason: 'replay' };
    const sig = 'sha256=' + createHmac('sha256', 'shared-secret').update(JSON.stringify(body)).digest('hex');
    const req = makeWebhookReq(body, sig, 'req-uuid-5');
    const { res, status, json } = makeRes();

    await routes.handleRepublishWebhook(req, res);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'webhook_replay_detected' }));
  });

  it('does not leak existence of unknown sites — returns 403 same as bad signature', async () => {
    const deps = makeStubDeps({ siteSecret: null });
    const routes = createRepublishRoutes(deps);
    const body = { reason: 'x' };
    const sig = 'sha256=' + createHmac('sha256', 'shared-secret').update(JSON.stringify(body)).digest('hex');
    const req = makeWebhookReq(body, sig, 'req-uuid-6');
    const { res, status, json } = makeRes();

    await routes.handleRepublishWebhook(req, res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_webhook_signature' }));
  });
});

describe('rotateWebhookSecret', () => {
  it('returns 200 with newSecret', async () => {
    const deps = makeStubDeps();
    const routes = createRepublishRoutes(deps);
    const req = { params: { id: 'site-1' }, user: { id: 'admin-1' } } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.rotateWebhookSecret(req as Request & { user: { id: string } }, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ newSecret: expect.any(String) }));
  });
});
