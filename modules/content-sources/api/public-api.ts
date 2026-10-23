/**
 * Public API: /api/v1/content-sources/*  (API-key auth, scopes
 * content-sources:read | write | admin — the framework prefixes the module id).
 *
 *   GET   /sources            read   filters: status, foundation, q; limit/offset
 *   GET   /sources/:id        read
 *   POST  /sources            write  submit; pending unless the key has the admin scope
 *   PATCH /sources/:id        admin
 *   POST  /resolve            read   { site_url } → candidates, no write
 *
 * Pagination and envelopes follow the events public API. `resolve` and the
 * submit path make outbound requests, so both are rate limited per key.
 */

import type { PublicApiContext } from '@gatewaze/shared';
import type { Router, Request, Response, RequestHandler } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { list, get, submit, patch, resolve, SourceError } from '../lib/sources.js';

interface ApiKeyLike { id?: string; scopes: string[] }

// Small fixed-window limiter per API key for the two routes that fetch the
// internet on the caller's behalf. In-memory per process; the public API is a
// single api deployment per brand, which is enough to blunt a loop.
//
// The bucket is the API key, nothing finer. The hosted MCP server
// (packages/mcp GatewazeApiClient) calls with its deployment key and sends
// only X-API-Key: no user JWT and no verified caller identity reaches this
// API, so every hosted-MCP user shares that key's bucket. That is the
// intended ceiling for the key, not a per-user quota. Do not split on a
// client-supplied header (a caller id, X-Forwarded-For): any key holder could
// rotate it to mint fresh buckets. If the MCP server starts forwarding a
// verified identity (a signed user token this API checks), bucket on
// key id + that identity instead.
const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimited(key: string, perMinute: number): boolean {
  const now = Date.now();
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  b.count += 1;
  return b.count > perMinute;
}

function sendError(res: Response, e: unknown) {
  if (e instanceof SourceError) {
    return res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } });
  }
  console.error('[content-sources] public api error:', e instanceof Error ? e.message : e);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected error' } });
}

export function registerPublicApi(router: Router, ctx: PublicApiContext) {
  const sb = ctx.supabase as SupabaseClient;
  // The framework types requireScope's result as unknown to avoid an express dependency in shared.
  const scope = (action: string) => ctx.requireScope(action) as RequestHandler;
  const keyOf = (req: Request) => ((req as Request & { apiKey?: ApiKeyLike }).apiKey?.id ?? req.ip ?? 'anon');
  const hasAdmin = (req: Request) => ((req as Request & { apiKey?: ApiKeyLike }).apiKey?.scopes ?? []).includes('content-sources:admin');

  router.get('/sources', scope('read'), async (req: Request, res: Response) => {
    try {
      const { limit, offset } = ctx.parsePagination(req.query as { limit?: string; offset?: string });
      const { items, total } = await list(sb, { status: req.query.status, foundation: req.query.foundation, q: req.query.q, limit, offset });
      ctx.setCache(res, { kind: 'no-store' });
      const hasMore = offset + limit < total;
      res.json({
        data: items,
        pagination: { total, limit, offset, has_more: hasMore },
        _links: { self: req.originalUrl, ...(hasMore ? { next: `${req.baseUrl}/sources?offset=${offset + limit}&limit=${limit}` } : {}) },
      });
    } catch (e) {
      if ((e as { code?: string })?.code === 'VALIDATION_ERROR') {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: (e as Error).message ?? 'invalid pagination' } });
      }
      sendError(res, e);
    }
  });

  router.get('/sources/:id', scope('read'), async (req: Request, res: Response) => {
    try {
      ctx.setCache(res, { kind: 'no-store' });
      res.json({ data: await get(sb, String(req.params.id)) });
    } catch (e) {
      sendError(res, e);
    }
  });

  router.post('/resolve', scope('read'), async (req: Request, res: Response) => {
    if (rateLimited(`resolve:${keyOf(req)}`, 10)) {
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many resolve requests; try again in a minute' } });
    }
    try {
      res.json({ data: await resolve((req.body ?? {}).site_url) });
    } catch (e) {
      sendError(res, e);
    }
  });

  router.post('/sources', scope('write'), async (req: Request, res: Response) => {
    if (rateLimited(`submit:${keyOf(req)}`, 10)) {
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many submissions; try again in a minute' } });
    }
    try {
      const b = req.body ?? {};
      const source = await submit(sb, {
        site_url: b.site_url, feed_url: b.feed_url, kind: b.kind, path_prefix: b.path_prefix,
        foundation: b.foundation, project: b.project, content_category: b.content_category, note: b.note,
        scraper_id: b.scraper_id, as_pending: b.as_pending === true,
      }, { personId: null, addedVia: 'api', isAdmin: hasAdmin(req) });
      res.status(201).json({ data: source });
    } catch (e) {
      sendError(res, e);
    }
  });

  router.patch('/sources/:id', scope('admin'), async (req: Request, res: Response) => {
    try {
      const b = req.body ?? {};
      const source = await patch(sb, String(req.params.id), {
        status: b.status, egress: b.egress, egress_locked: b.egress_locked, foundation: b.foundation, project: b.project,
        content_category: b.content_category, note: b.note, is_canary: b.is_canary, feed_url: b.feed_url, path_prefix: b.path_prefix, kind: b.kind, scraper_id: b.scraper_id,
      });
      res.json({ data: source });
    } catch (e) {
      sendError(res, e);
    }
  });
}
