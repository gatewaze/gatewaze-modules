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

  // Resolve the boilerplate URL + branch via the central templates helper
  // so a single env-var pair (GATEWAZE_NEWSLETTER_BOILERPLATE_URL /
  // GATEWAZE_NEWSLETTER_BOILERPLATE_BRANCH) governs every newsletter
  // boilerplate consumer. Unset env → canonical defaults
  // (github.com/gatewaze/gatewaze-template-email, branch `theme`).
  const { getBoilerplateConfig } = await import('../../templates/lib/boilerplate/index.js');
  const boilerplate = getBoilerplateConfig('newsletter');

  const baseDeps = {
    supabase,
    ...(gitServer ? { gitServer } : {}),
    boilerplateUrl: boilerplate.url,
    boilerplateBranch: boilerplate.branch,
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

  // POST /api/admin/newsletters/editions/:editionId/test-send
  //
  // One-off send of the rendered HTML to a single email. Used by the
  // edition editor's "Test Send" toolbar — the operator gets the email
  // in their own inbox to sanity-check formatting against the real
  // Gmail / Outlook / Apple Mail rendering before scheduling the
  // actual send. Body shape mirrors the legacy
  // `functions/v1/send-email` call gatewaze-admin used:
  //   { recipient_email, html, subject, from_email?, from_name? }
  // — except the html is rendered by the client and posted up, rather
  // than re-rendered server-side, so this endpoint stays a thin
  // SendGrid wrapper (no DB read, no template plumbing). The subject
  // is prefixed with "[TEST] " so the recipient never confuses a
  // preview with a real edition.
  router.post('/newsletters/editions/:editionId/test-send', wrap(async (req, res) => {
    const editionId = req.params.editionId;
    const { recipient_email, html, subject, from_email, from_name } = (req.body ?? {}) as Record<string, string | undefined>;
    if (!recipient_email || !recipient_email.includes('@')) {
      res.status(400).json({ error: { code: 'invalid_recipient', message: 'recipient_email must be a valid email address' } });
      return;
    }
    if (!html || typeof html !== 'string' || html.length < 16) {
      res.status(400).json({ error: { code: 'invalid_html', message: 'html is required' } });
      return;
    }
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: { code: 'sendgrid_not_configured', message: 'SENDGRID_API_KEY is not set on the api process' } });
      return;
    }
    // Resolve the From identity. Prefer client-supplied values (so the
    // operator can preview "what the recipient will actually see"),
    // then fall back to the edition's collection, then the platform
    // EMAIL_FROM env var. SendGrid requires the From address to be
    // verified in the SendGrid account; mismatches return a 403 which
    // we surface verbatim.
    let resolvedFrom = from_email && from_email.includes('@') ? from_email : null;
    let resolvedFromName = from_name && from_name.trim() ? from_name.trim() : null;
    if (!resolvedFrom) {
      const { data: edition } = await supabase
        .from('newsletters_editions')
        .select('collection_id')
        .eq('id', editionId)
        .maybeSingle();
      if (edition?.collection_id) {
        const { data: col } = await supabase
          .from('newsletters_template_collections')
          .select('from_email, from_name')
          .eq('id', edition.collection_id)
          .maybeSingle();
        if (col?.from_email) resolvedFrom = col.from_email;
        if (!resolvedFromName && col?.from_name) resolvedFromName = col.from_name;
      }
    }
    if (!resolvedFrom) resolvedFrom = process.env.EMAIL_FROM ?? null;
    if (!resolvedFrom) {
      res.status(400).json({ error: { code: 'no_from_address', message: 'No verified from address configured on the newsletter or platform' } });
      return;
    }
    const finalSubject = `[TEST] ${(subject && subject.trim()) || 'Newsletter preview'}`;
    try {
      const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: recipient_email }] }],
          from: { email: resolvedFrom, ...(resolvedFromName ? { name: resolvedFromName } : {}) },
          subject: finalSubject,
          content: [{ type: 'text/html', value: html }],
        }),
      });
      if (!sgRes.ok) {
        const errText = await sgRes.text();
        res.status(sgRes.status).json({
          error: { code: 'sendgrid_error', message: `SendGrid ${sgRes.status}: ${errText.slice(0, 500)}` },
        });
        return;
      }
      res.json({ success: true, recipient: recipient_email, from: resolvedFrom });
    } catch (err) {
      res.status(502).json({
        error: { code: 'sendgrid_unreachable', message: err instanceof Error ? err.message : String(err) },
      });
    }
  }));

  // Mount under /api/admin so the URL ends up at
  //   /api/admin/newsletters/editions/:editionId/publish-to-git etc.
  app.use('/api/admin', router);

  void context;
  // eslint-disable-next-line no-console
  console.log('[newsletters] routes registered (publish-to-git, init-repo, graduate, drift, manifest, delete-collection, test-send)');
}
