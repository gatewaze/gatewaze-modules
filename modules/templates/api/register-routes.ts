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
  if (!context?.supabase) {
    // eslint-disable-next-line no-console
    console.warn('[templates] registerRoutes: no supabase in context; skipping route mount');
    return;
  }

  const logger = context.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  // Use the platform's JWT-protected router if available; fall back to the
  // raw app for module-context shapes that don't expose labeledRouter.
  const router = context.labeledRouter ? context.labeledRouter('jwt') : app;

  const sourcesRoutes = createSourcesRoutes({
    supabase: context.supabase,
    logger,
    getUserId: (req: Request) => {
      const user = (req as Request & { user?: { id?: string } }).user;
      return user?.id ?? null;
    },
  });

  // Wrap the inner router so all routes mount at /api/modules/templates/*.
  // Some platform glue mounts the labeled router itself at /api/modules/<id>;
  // others expect us to call app.use() with the prefix here. Branch on
  // whether labeledRouter handed us a router that's already mounted.
  if (context.labeledRouter) {
    mountSourcesRoutes(router, sourcesRoutes);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const express = require('express') as { Router(): any };
    const sub = express.Router();
    mountSourcesRoutes(sub, sourcesRoutes);
    app.use('/api/modules/templates', sub);
  }
}
