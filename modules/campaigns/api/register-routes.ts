/**
 * Mounts the campaigns admin API under /api/admin/modules/campaigns/.
 *
 * Only the AI segment copilot lives here — it must run Node-side because the AI
 * module (@gatewaze-modules/ai runChat) is not Deno-compatible. The send path
 * stays in Supabase edge functions (campaign-send / campaign-unsubscribe).
 *
 * Conventions copied from editor-ai-copilot/api/register-routes.ts:
 *   - the platform passes the FULL Express app; modules app.use(prefix, router).
 *   - ctx.supabase is null; we build our own service-role client.
 *   - a minimal decodeJwt middleware extracts userId (the handler re-checks
 *     admin via service-role admin_profiles, so an unverified token can't
 *     escalate).
 */

import express, { type Express, type Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import type { ModuleRuntimeContext } from '@gatewaze/shared';
import { createSegmentsAiBuildRoute } from './segments-ai-build.js';

export async function registerCampaignsRoutes(app: Express, ctx: ModuleRuntimeContext): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !supabaseServiceKey) {
    // eslint-disable-next-line no-console
    console.warn('[campaigns] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — copilot endpoint will fail');
  }
  // Mirror newsletters/host-media/sites: no realtime transport needed (these
  // routes never use Realtime), which also avoids an extra `ws` npm dep the api
  // container would have to bake in.
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logger = (ctx as any).logger ?? {
    info: (...a: unknown[]) => console.log('[campaigns]', ...a),
    warn: (...a: unknown[]) => console.warn('[campaigns]', ...a),
    error: (...a: unknown[]) => console.error('[campaigns]', ...a),
  };

  function decodeJwt(req: { headers: Record<string, string | string[] | undefined>; userId?: string }, _res: unknown, next: () => void): void {
    const auth = req.headers['authorization'];
    const header = Array.isArray(auth) ? auth[0] : auth;
    if (header && header.startsWith('Bearer ')) {
      const token = header.slice(7);
      const parts = token.split('.');
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as { sub?: string };
          if (typeof payload.sub === 'string') req.userId = payload.sub;
        } catch { /* bad token — handler returns 401 */ }
      }
    }
    next();
  }

  const segmentsAiBuild = createSegmentsAiBuildRoute({ supabase: supabase as never, logger });

  const router: Router = express.Router();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  router.use(decodeJwt as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  router.post('/segments-ai-build', segmentsAiBuild as any);
  app.use('/api/admin/modules/campaigns', router);

  logger.info('[campaigns] routes mounted at /api/admin/modules/campaigns/{segments-ai-build}');
}
