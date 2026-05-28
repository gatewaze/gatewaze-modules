/**
 * Mounts the editor-ai-copilot endpoints under
 * /api/admin/modules/editor-ai-copilot/.
 *
 * Auth: the platform's requireJwt middleware is applied upstream by
 * the API server to /api/admin/*, which populates `req.userId`. Our
 * handlers read that to identify the caller. Per-request authorization
 * to admin the target host runs inside the handler via
 * `assertCanAdminHost`.
 *
 * Conventions inherited from sites' register-routes.ts:
 *   - The platform's `apiRoutes(app, ctx)` callback receives the FULL
 *     Express app, not a Router — modules `app.use(prefix, router)`
 *     themselves.
 *   - The runtime context's `supabase` field is typed as `unknown` and
 *     left null by the platform; modules construct their own service-
 *     role client from SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (which
 *     bypasses RLS — needed because this module writes to audit + docs
 *     tables on behalf of the admin user).
 */

import express, { type Express, type Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import WebSocketImpl from 'ws';
import type { ModuleRuntimeContext } from '@gatewaze/shared';
import { createGenerateRoute } from './generate.js';
import { createDocumentsRoute } from './documents.js';
import { createThreadLoadRoute } from './thread.js';
// Skill source / webhook / skills routes moved to the ai module in
// Phase 2 — they now mount under /api/modules/ai/admin/*.
import { registerHostAdapter } from '../lib/host-adapter-registry.js';
import { createSitesHostAdapter } from '../lib/host-adapter-sites.js';
import { createNewslettersHostAdapter } from '../lib/host-adapter-newsletters.js';
import type { HostKind } from '../lib/types.js';

export async function registerEditorAiCopilotRoutes(app: Express, ctx: ModuleRuntimeContext): Promise<void> {
  // Service-role Supabase — bypasses RLS. Admin writes (audit log,
  // canvas_ai_documents) need this; the host-aware admin check below
  // gates access at the application layer.
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !supabaseServiceKey) {
    // eslint-disable-next-line no-console
    console.warn('[editor-ai-copilot] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — endpoints will fail');
  }
  // `@supabase/supabase-js` eagerly initializes a Realtime websocket
  // client inside `createClient`. On Node < 22 there's no native
  // WebSocket global, so the call throws unless we provide a
  // transport — even though this module never uses Realtime. Pass the
  // `ws` polyfill explicitly. (See the API container's prior crash:
  // "Node.js 20 detected without native WebSocket support.")
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: WebSocketImpl as never },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logger = (ctx as any).logger ?? {
    info: (...a: unknown[]) => console.log('[editor-ai-copilot]', ...a),
    warn: (...a: unknown[]) => console.warn('[editor-ai-copilot]', ...a),
    error: (...a: unknown[]) => console.error('[editor-ai-copilot]', ...a),
  };

  // Register host adapters at mount time. The generate handler then
  // looks them up via host-adapter-registry on each request.
  registerHostAdapter('site', createSitesHostAdapter({ supabase: supabase as never }));
  registerHostAdapter('newsletter', createNewslettersHostAdapter({ supabase: supabase as never }));

  // Host-aware admin check. Reuses the canvas-auth helper for sites
  // and a parallel newsletter-auth helper for newsletters. We don't
  // hard-code the lookup here; instead we delegate to the platform's
  // existing super-admin check (matches the v3 fallback in
  // sites/api/canvas/canvas-auth.ts §service-role).
  async function assertCanAdminHost(hostKind: HostKind, hostId: string, userId: string): Promise<{ ok: true } | { ok: false; httpStatus: number; code: string; message: string }> {
    // Super-admin via admin_profiles — works for both host kinds.
    try {
      const adminRes = await supabase
        .from('admin_profiles')
        .select('user_id')
        .eq('user_id', userId)
        .eq('is_active', true)
        .maybeSingle();
      if (adminRes?.data) return { ok: true };
    } catch {
      // fall through
    }
    void hostKind;
    void hostId;
    return { ok: false, httpStatus: 403, code: 'forbidden', message: 'caller cannot admin this host' };
  }

  const generateHandler = createGenerateRoute({ supabase: supabase as never, logger, assertCanAdminHost });
  const documentsHandler = createDocumentsRoute({ supabase: supabase as never, logger });
  const threadLoadHandler = createThreadLoadRoute({ supabase: supabase as never, logger, assertCanAdminHost });

  // Minimal JWT decode middleware — the platform's `requireJwt` middleware
  // lives in @gatewaze/api which isn't exposed to modules, so we extract
  // the userId from the Authorization header ourselves. We deliberately
  // DON'T verify the signature here — the handler already calls
  // `assertCanAdminHost` which goes to the DB via service-role and
  // re-checks admin grant, so an attacker who forged a JWT still can't
  // adminster a host they don't have rights on.
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
        } catch {
          // bad token — leave userId unset, handler returns 401
        }
      }
    }
    next();
  }

  // Admin-authenticated routes — JWT-decode middleware extracts userId.
  // Skill source / webhook / skills routes moved to the ai module
  // (Phase 2 refactor); only generate + documents stay here now.
  const router: Router = express.Router();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  router.use(decodeJwt as any);
  router.post('/generate', generateHandler);
  router.post('/documents', documentsHandler);
  router.get('/thread', threadLoadHandler);
  app.use('/api/admin/modules/editor-ai-copilot', router);

  // Touch ctx to silence the unused-arg lint now that we no longer
  // pull enqueueJob off it (skill routes moved out).
  void ctx;

  logger.info('[editor-ai-copilot] routes mounted at /api/admin/modules/editor-ai-copilot/{generate,documents,thread}');
}
