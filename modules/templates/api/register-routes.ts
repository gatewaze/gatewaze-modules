/**
 * Register the templates module's HTTP routes against the platform's
 * Express app. Mounted under `/api/modules/templates/...`.
 *
 * Auth: every route assumes the platform's `requireJwt` middleware has
 * populated `req.user`. RLS on the underlying tables enforces tenancy +
 * per-host `can_admin_<host_kind>` permissions.
 */

// eslint-disable-next-line @ts-nocheck — see modules/sites/api/register-routes.ts
// for the matching justification: this file lives in the modules workspace
// where cross-workspace `@gatewaze/shared` peer-deps don't resolve under
// `tsc --noEmit`. The runtime resolves them via the api server's loader.
// @ts-nocheck

import type { Express, Request } from 'express';
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import { requireJwt } from '../../newsletters/lib/require-jwt.js';
import { createSourcesRoutes, mountSourcesRoutes } from './sources.js';

// ModuleContext shape mirrors what `gatewaze/packages/api` passes when
// invoking each module's `apiRoutes(app, ctx)` lifecycle hook.
interface ModuleContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  labeledRouter?: (label: 'jwt' | 'public' | 'service') => any;
}

export function registerRoutes(app: Express, context?: ModuleContext): void {
  // The api server's ModuleRuntimeContext exposes `supabase: null` —
  // it doesn't pass a pre-built service-role client. Earlier drafts
  // of this hook expected one and silently no-op'd, so /api/modules/
  // templates/* never mounted and the admin's Connect Repository
  // button hit Express's default 404. Build our own client from env
  // vars (same pattern as modules/newsletters/api/register-routes.ts).
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const supabase = context?.supabase
    ?? (supabaseUrl && supabaseServiceKey
      ? createClient(supabaseUrl, supabaseServiceKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        })
      : null);
  if (!supabase) {
    // eslint-disable-next-line no-console
    console.warn('[templates] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping route mount');
    return;
  }

  const logger = context?.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  const sourcesRoutes = createSourcesRoutes({
    supabase,
    logger,
    getUserId: (req: Request) => {
      // requireJwt() sets req.userId (no `user` object). Fall back to
      // the older shape just in case the platform middleware ever
      // wraps the request the other way.
      const r = req as Request & { userId?: string; user?: { id?: string } };
      return r.userId ?? r.user?.id ?? null;
    },
  });

  // Wrap the inner router so all routes mount at /api/modules/templates/*.
  // labeledRouter is the platform's preferred path — when present, it
  // mounts under the right prefix automatically. When absent (current
  // api server runtime), build our own Router with requireJwt() and
  // mount it under the expected path so each handler sees req.userId.
  if (context?.labeledRouter) {
    const router = context.labeledRouter('jwt');
    mountSourcesRoutes(router, sourcesRoutes);
  } else {
    const sub = Router();
    sub.use(requireJwt());
    mountSourcesRoutes(sub, sourcesRoutes);
    app.use('/api/modules/templates', sub);
  }
  // eslint-disable-next-line no-console
  console.log('[templates] routes registered (/api/modules/templates/sources/*)');
}
