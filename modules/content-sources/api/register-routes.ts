/**
 * Admin API for the Sources tab. Bearer token → is_admin() evaluated as the
 * caller (same predicate RLS uses), then the service-role client does the
 * work through lib/sources.ts, which owns field allowlists and enum checks.
 *
 *   POST  /api/admin/content-sources/resolve            { site_url } → candidates
 *   POST  /api/admin/content-sources/sources            create (admin: active)
 *   PATCH /api/admin/content-sources/sources/:id        allowlisted fields
 *   POST  /api/admin/content-sources/sources/:id/run    run the scraper for this source
 *   POST  /api/admin/content-sources/run                run the scraper for every active source
 *
 * Reads (the list) go straight from the admin UI to PostgREST under RLS.
 */

import type { Express, Request, Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ModuleContext } from '@gatewaze/shared';
import { resolve, submit, patch, enqueueRun, SourceError } from '../lib/sources.js';
import { redisConnection } from '../lib/redis-connection.js';

let _sb: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[content-sources] missing SUPABASE env');
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

// is_admin() must run AS the caller so auth.uid() resolves to them (the
// content-platform module documents why a per-call header on .rpc() is not
// enough). Returns the caller's user id, or sends the failure response.
async function requireAdmin(req: Request, res: Response): Promise<string | null> {
  try {
    return await requireAdminInner(req, res);
  } catch (e) {
    console.error('[content-sources] requireAdmin failed:', e instanceof Error ? e.message : e);
    if (!res.headersSent) res.status(500).json({ error: { code: 'INTERNAL', message: 'Auth check failed' } });
    return null;
  }
}

async function requireAdminInner(req: Request, res: Response): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: { code: 'unauthorized', message: 'Missing bearer token' } });
    return null;
  }
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    res.status(500).json({ error: { code: 'server_misconfigured', message: 'Auth not configured' } });
    return null;
  }
  const asUser = createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: authHeader } } });
  const [{ data: isAdmin, error }, { data: userData }] = await Promise.all([asUser.rpc('is_admin'), asUser.auth.getUser()]);
  if (error || isAdmin !== true) {
    res.status(403).json({ error: { code: 'forbidden', message: 'Admin privileges required' } });
    return null;
  }
  const uid = userData?.user?.id;
  if (!uid) {
    res.status(401).json({ error: { code: 'unauthorized', message: 'Could not resolve the caller' } });
    return null;
  }
  return uid;
}

async function personIdForUser(userId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const { data } = await sb().from('people').select('id').eq('auth_user_id', userId).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

function sendError(res: Response, e: unknown) {
  if (e instanceof SourceError) {
    return res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } });
  }
  const msg = e instanceof Error ? e.message : String(e);
  console.error('[content-sources] admin api error:', msg);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected error' } });
}

// The scrapers module owns the queue name/prefix bridge for legacy brands;
// mirror its enqueue so a run from here lands where the dashboard's would.
function makeAddJob(projectRoot: string) {
  const QUEUE_NAME = process.env.SCRAPER_QUEUE_NAME || 'jobs';
  const QUEUE_PREFIX = process.env.SCRAPER_QUEUE_PREFIX || `bull:${process.env.BRAND || 'default'}`;
  let queue: { add: (name: string, data: unknown, opts: unknown) => Promise<{ id?: string | number }> } | null = null;
  return async (type: string, data: Record<string, unknown>) => {
    if (!queue) {
      const require = createRequire(join(projectRoot, 'packages', 'api', 'package.json'));
      const { Queue } = require('bullmq');
      queue = new Queue(QUEUE_NAME, {
        connection: redisConnection(),
        prefix: QUEUE_PREFIX,
        defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { count: 1000, age: 24 * 3600 }, removeOnFail: { count: 500, age: 7 * 24 * 3600 } },
      });
    }
    const job = await queue!.add(type, { ...data, enqueuedAt: new Date().toISOString() }, { jobId: `${type.replace(/:/g, '-')}-${Date.now()}` });
    return { id: job.id };
  };
}

export function registerRoutes(app: Express, _context?: ModuleContext) {
  const projectRoot = process.cwd();
  const addJob = makeAddJob(projectRoot);

  app.post('/api/admin/content-sources/resolve', async (req: Request, res: Response) => {
    const user = await requireAdmin(req, res);
    if (!user) return;
    try {
      res.json(await resolve((req.body ?? {}).site_url));
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/admin/content-sources/sources', async (req: Request, res: Response) => {
    const user = await requireAdmin(req, res);
    if (!user) return;
    try {
      const b = req.body ?? {};
      const source = await submit(sb(), {
        site_url: b.site_url, feed_url: b.feed_url, kind: b.kind, path_prefix: b.path_prefix,
        foundation: b.foundation, project: b.project, content_category: b.content_category,
        note: b.note, is_canary: b.is_canary, egress: b.egress, scraper_id: b.scraper_id,
      }, { personId: await personIdForUser(user), addedVia: 'admin_ui', isAdmin: true });
      res.status(201).json({ source });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.patch('/api/admin/content-sources/sources/:id', async (req: Request, res: Response) => {
    const user = await requireAdmin(req, res);
    if (!user) return;
    try {
      const b = req.body ?? {};
      const source = await patch(sb(), String(req.params.id), {
        status: b.status, egress: b.egress, egress_locked: b.egress_locked, foundation: b.foundation,
        project: b.project, content_category: b.content_category, note: b.note, is_canary: b.is_canary,
        feed_url: b.feed_url, path_prefix: b.path_prefix, kind: b.kind, scraper_id: b.scraper_id,
      });
      res.json({ source });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/admin/content-sources/sources/:id/run', async (req: Request, res: Response) => {
    const user = await requireAdmin(req, res);
    if (!user) return;
    try {
      const id = String(req.params.id);
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new SourceError(400, 'VALIDATION_ERROR', 'invalid id');
      res.json(await enqueueRun(sb(), addJob, { sourceIds: [id], createdBy: `admin:${user}` }));
    } catch (e) {
      sendError(res, e);
    }
  });

  app.post('/api/admin/content-sources/run', async (req: Request, res: Response) => {
    const user = await requireAdmin(req, res);
    if (!user) return;
    try {
      res.json(await enqueueRun(sb(), addJob, { createdBy: `admin:${user}` }));
    } catch (e) {
      sendError(res, e);
    }
  });
}
