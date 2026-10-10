// @ts-nocheck — supabase-js + express are resolved at module-host install time.

/**
 * event-agenda module — apiRoutes entry.
 *
 * Mounts the schedule-import admin endpoints under
 * /api/modules/event-agenda/admin/* (the platform's /api/modules/<id> prefix
 * is labelled 'jwt', so the upstream JWT middleware runs first). The agenda
 * itself is still read and written through the core agenda service; only the
 * importer needs module-owned routes.
 */

import { Router, type Express } from 'express';
import { createClient } from '@supabase/supabase-js';
import { mountAdminScheduleRoutes } from './admin-routes.js';

interface RegisterCtx {
  enqueueJob?: (
    queue: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ id: string | undefined }>;
}

export async function registerRoutes(app: Express, ctx?: RegisterCtx): Promise<void> {
  const logger = {
    info: (msg: string, meta?: Record<string, unknown>) => console.log(`[event-agenda] ${msg}`, meta ?? ''),
    warn: (msg: string, meta?: Record<string, unknown>) => console.warn(`[event-agenda] ${msg}`, meta ?? ''),
  };

  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseServiceKey) {
    logger.warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — schedule-import endpoints will fail');
  }
  if (!supabaseAnonKey) {
    logger.warn('SUPABASE_ANON_KEY not set — schedule-import endpoints will refuse every request');
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const extractBearer = (req: { headers?: Record<string, unknown> }): string | null => {
    const raw = req?.headers?.authorization ?? req?.headers?.Authorization;
    if (typeof raw !== 'string') return null;
    const m = raw.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : null;
  };

  const adminRouter = Router();
  mountAdminScheduleRoutes(adminRouter, {
    supabase,
    // The permission check must run as the CALLER, not as the service role,
    // or can_admin_event would be evaluated with RLS bypassed and always pass.
    // No anon key or no token means no client, and the routes fail closed.
    userClient: (req) => {
      if (!supabaseAnonKey) return null;
      const token = extractBearer(req as never);
      if (!token) return null;
      return createClient(supabaseUrl, supabaseAnonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
    },
    logger,
    ...(ctx?.enqueueJob && { enqueueJob: ctx.enqueueJob }),
  });

  app.use('/api/modules/event-agenda', adminRouter);
  logger.info('routes mounted at /api/modules/event-agenda');
}
