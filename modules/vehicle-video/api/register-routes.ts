// @ts-nocheck — depends on supabase-js + express; resolved at module-host install time.

/**
 * vehicle-video module — apiRoutes entry. Mounts the admin router under
 * /api/modules/vehicle-video. Every route is an admin/dealer operation (drives
 * real Kling/Veo/Gemini spend, deletes runs, overwrites branding), so the module
 * enforces its OWN auth here — the platform does NOT apply JWT to dynamic module
 * routes (their auth is the module author's responsibility; see the core
 * `assertAllRoutesLabeled` exemption). We gate the whole router with requireJwt
 * (verified session) + an admin_profiles check, matching the newsletters module.
 * No public endpoints in v1.
 */

import { Router, type Express, json, type Request, type Response, type NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { mountAdminRoutes } from './admin-routes.js';
import { requireJwt } from '../lib/require-jwt.js';

interface RegisterCtx {
  enqueueJob?: (queue: string, name: string, data: Record<string, unknown>) => Promise<{ id: string | undefined }>;
}

export async function registerRoutes(app: Express, ctx?: RegisterCtx): Promise<void> {
  const logger = {
    info: (m: string, x?: Record<string, unknown>) => console.log(`[vehicle-video] ${m}`, x ?? ''),
    warn: (m: string, x?: Record<string, unknown>) => console.warn(`[vehicle-video] ${m}`, x ?? ''),
  };

  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) {
    logger.warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — vehicle-video endpoints will fail');
  }
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const router = Router();
  // base64 photo chunks can be large; allow a generous JSON body.
  router.use(json({ limit: '64mb' }));

  // Auth gate for the whole router (every route is admin-only). requireJwt
  // verifies the session and sets req.userId; requireAdmin then confirms the
  // user is a platform admin — the service-role client below bypasses RLS, so
  // without this any caller reaching the network prefix could drive spend/delete.
  router.use(requireJwt());
  const requireAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = (req as Request & { userId?: string }).userId;
    if (!userId) {
      res.status(401).json({ error: { code: 'unauthenticated', message: 'No session' } });
      return;
    }
    const { data } = await supabase
      .from('admin_profiles')
      .select('role, is_active')
      .eq('user_id', userId)
      .maybeSingle();
    const ok = !!data && data.is_active && ['super_admin', 'admin', 'editor'].includes(data.role);
    if (!ok) {
      res.status(403).json({ error: { code: 'forbidden', message: 'Admin access required' } });
      return;
    }
    next();
  };
  router.use(requireAdmin);

  mountAdminRoutes(router, {
    supabase,
    logger,
    ...(ctx?.enqueueJob && { enqueueJob: ctx.enqueueJob }),
  });

  app.use('/api/modules/vehicle-video', router);
  logger.info('routes mounted at /api/modules/vehicle-video');
}
