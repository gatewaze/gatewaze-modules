// @ts-nocheck — module workspace isn't linked into the platform's
//                node_modules at typecheck time. Routes are exercised
//                via runtime tests + the live editor.
/**
 * Newsletters module — apiRoutes hook entry point. Mirrors
 * `modules/host-media/api/register-routes.ts`:
 *
 *   - Builds its own service-role supabase client from env vars
 *     (the api server's runtime context exposes `supabase: null`;
 *     it doesn't pass a pre-built client through `context.deps`,
 *     and an earlier draft of this hook silently no-op'd because
 *     it expected one).
 *   - Mounts an Express Router under `/api/admin` with our local
 *     `requireJwt()` upstream so each handler sees `req.userId`.
 *   - Wires the publish-to-git, init-repo, graduate-to-external,
 *     drift, manifest, and delete-collection routes.
 *
 * Optional gitServer: the sites module owns the InternalGitServer
 * implementation. We resolve it on-demand via dynamic import; if
 * sites isn't installed (or the impl path moves), we surface a
 * clear "git server unavailable" 5xx from the handlers themselves
 * rather than crashing here.
 */

import type { ModuleContext } from '@gatewaze/shared';
import { createClient } from '@supabase/supabase-js';
import { Router, type Express, type Request, type Response, type NextFunction } from 'express';

import { requireJwt } from '../lib/require-jwt.js';

export async function registerRoutes(app: Express, context?: ModuleContext): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !supabaseServiceKey) {
    // eslint-disable-next-line no-console
    console.warn('[newsletters] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping route registration');
    return;
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve the optional git server from the sites module. The impl
  // exposes a singleton accessor at `lib/git/internal-git-server-impl`
  // that lazily provisions on first use. Failures here are
  // non-fatal — the routes themselves return a typed error response
  // if a git operation is requested without the impl.
  let gitServer: unknown = null;
  try {
    const mod = await import('../../sites/lib/git/internal-git-server-impl.js');
    const factory = (mod as { getInternalGitServer?: () => unknown; default?: { getInternalGitServer?: () => unknown } });
    const get = factory.getInternalGitServer ?? factory.default?.getInternalGitServer;
    if (typeof get === 'function') {
      gitServer = get();
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[newsletters] internal git server unavailable; git routes will return 503 if invoked:', (err as Error).message);
  }

  const {
    createPublishToGitRoute,
    createInitRepoRoute,
    createGraduateToExternalRoute,
    createDriftRoute,
    createManifestRoute,
    createDeleteCollectionRoute,
  } = await import('./index.js');

  const baseDeps = {
    supabase,
    ...(gitServer ? { gitServer } : {}),
    boilerplateUrl: process.env.NEWSLETTERS_BOILERPLATE_URL ?? null,
    boilerplateBranch: process.env.NEWSLETTERS_BOILERPLATE_BRANCH ?? 'main',
  } as never;

  const publishHandler = createPublishToGitRoute(baseDeps);
  const initRepoHandler = createInitRepoRoute(baseDeps);
  const graduateHandler = createGraduateToExternalRoute(baseDeps);
  const driftHandler = createDriftRoute(baseDeps);
  const manifestHandler = createManifestRoute(baseDeps);
  const deleteCollectionHandler = createDeleteCollectionRoute({
    supabase,
    ...(gitServer ? { gitServer } : {}),
  } as never);

  // Each handler uses async/await but Express 4 doesn't propagate
  // rejections automatically. Wrap them so unhandled errors land in
  // the express error pipeline (5xx) rather than hanging the request.
  const wrap = (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        await fn(req, res, next);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[newsletters] route handler threw:', err);
        if (!res.headersSent) {
          res.status(500).json({
            error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
          });
        }
      }
    };

  const router = Router();
  router.use(requireJwt());

  router.post('/newsletters/editions/:editionId/publish-to-git', wrap(publishHandler));
  router.post('/newsletters/collections/:collectionId/init-repo', wrap(initRepoHandler));
  router.post('/newsletters/collections/:collectionId/graduate-to-external', wrap(graduateHandler));
  router.get('/newsletters/collections/:collectionId/drift', wrap(driftHandler));
  router.get('/newsletters/collections/:collectionId/manifest', wrap(manifestHandler));
  router.delete('/newsletters/collections/:collectionId', wrap(deleteCollectionHandler));

  // Mount under /api/admin so the URL ends up at
  //   /api/admin/newsletters/editions/:editionId/publish-to-git etc.
  app.use('/api/admin', router);

  void context;
  // eslint-disable-next-line no-console
  console.log('[newsletters] routes registered (publish-to-git, init-repo, graduate, drift, manifest, delete-collection)');
}
