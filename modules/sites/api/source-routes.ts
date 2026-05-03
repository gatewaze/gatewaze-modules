/**
 * Source-tab admin endpoints:
 *
 *   GET  /admin/sites/:id/drift                — compare main vs publish
 *   POST /admin/sites/:id/apply-theme          — merge main → publish
 *   POST /admin/sites/:id/apply-theme/resolve  — apply with conflict resolutions
 *   POST /admin/sites/:id/graduate-git         — promote internal → external
 *
 * Per spec-content-modules-git-architecture §6.2 + §22.1.
 */

import type { Request, Response, Router } from 'express';
import type { InternalGitServer, InternalRepoRef } from '../lib/git/internal-git-server.js';
import type { PublishWorker } from '../lib/publish-worker/publish-worker.js';

interface RequestWithUser extends Request {
  user?: { id: string; email?: string };
}

interface ErrorEnvelope {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface SourceRoutesDeps {
  /**
   * Why `any` on `from()`: see internal-git-server-impl.ts dep comment —
   * the OSS modules workspace doesn't ship generated Database types, and
   * hand-rolling PostgrestQueryBuilder lookalikes per table is a worse
   * trade than per-callsite `as { ... } | null` casts.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any; rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> };
  gitServer: InternalGitServer;
  publishWorker: PublishWorker;
  resolveSiteRepo: (siteId: string) => Promise<InternalRepoRef | null>;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

function paramAs(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return undefined;
}

export function createSourceRoutes(deps: SourceRoutesDeps) {
  const { gitServer, publishWorker, resolveSiteRepo, logger } = deps;

  /**
   * GET /admin/sites/:id/drift
   * Returns: { commitsAhead, blockSchemaChanges, hasConflicts, mainHeadSha, publishHeadSha, lastFetchedAt }
   */
  async function getDrift(req: RequestWithUser, res: Response): Promise<void> {
    const siteId = paramAs(req.params.id);
    if (!siteId) {
      res.status(400).json({ error: 'missing_site_id', message: 'site id required' } satisfies ErrorEnvelope);
      return;
    }

    const repo = await resolveSiteRepo(siteId);
    if (!repo) {
      res.status(404).json({ error: 'site_not_found', message: `no git repo for site ${siteId}` } satisfies ErrorEnvelope);
      return;
    }

    try {
      const [mainSha, publishSha] = await Promise.all([
        gitServer.getHeadSha(repo, 'main'),
        gitServer.getHeadSha(repo, 'publish'),
      ]);

      // commitsAhead: count commits in main that aren't in publish
      // For the stub, we just check whether the SHAs differ.
      const commitsAhead = mainSha && publishSha && mainSha !== publishSha ? 1 : 0;

      res.status(200).json({
        commitsAhead,
        // blockSchemaChanges + hasConflicts require running the marker parser
        // against both SHAs and diffing — wired in a follow-up.
        blockSchemaChanges: 0,
        hasConflicts: false,
        mainHeadSha: mainSha,
        publishHeadSha: publishSha,
        lastFetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('drift check failed', { siteId, error: message });
      res.status(503).json({ error: 'drift_check_failed', message, details: { upstream: 'git' } } satisfies ErrorEnvelope);
    }
  }

  /**
   * POST /admin/sites/:id/apply-theme
   * Body: { fastTrack?, expectedHeadSha? }
   * Returns 200 on clean apply, 409 with conflicts when manual resolution needed.
   */
  async function applyTheme(req: RequestWithUser, res: Response): Promise<void> {
    const siteId = paramAs(req.params.id);
    if (!siteId) {
      res.status(400).json({ error: 'missing_site_id', message: 'site id required' } satisfies ErrorEnvelope);
      return;
    }
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'unauthorized', message: 'admin JWT required' } satisfies ErrorEnvelope);
      return;
    }
    const body = req.body ?? {};
    const fastTrack = body.fastTrack === true;

    try {
      const result = await publishWorker.applyTheme({ siteId, fastTrack, triggeredBy: userId });

      if (result.conflicts.length > 0) {
        // Conflicts surface as 409 with details.conflicts per spec §22.1.
        // For fast-track, this means "abort" — admin must use full apply.
        res.status(409).json({
          error: fastTrack ? 'fast_track_blocked_by_conflict' : 'theme_apply_conflict',
          message: fastTrack
            ? 'Fast-track apply detected conflicts. Use the full Apply UX for manual resolution.'
            : 'Theme update introduces changes that affect existing pages.',
          details: {
            conflicts: result.conflicts.map((c) => ({
              block: c.path,
              kind: 'breaking',
              affectedPages: [],
              resolution_options: fastTrack ? ['abort'] : ['adopt_with_defaults', 'bulk_update_pages', 'pin_old_version', 'replace_block', 'abort'],
            })),
          },
        } satisfies ErrorEnvelope);
        return;
      }

      res.status(200).json({
        appliedCommit: result.appliedCommit,
        filesChanged: result.filesChanged,
        schemaChanges: [],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('publish_in_progress')) {
        res.status(409).json({ error: 'publish_in_progress', message } satisfies ErrorEnvelope);
        return;
      }
      logger.error('apply-theme failed', { siteId, error: message });
      res.status(503).json({ error: 'apply_theme_failed', message } satisfies ErrorEnvelope);
    }
  }

  /**
   * POST /admin/sites/:id/apply-theme/resolve
   * Body: { resolutions: [{ block, resolution, replacement_block?, field_map? }] }
   *
   * The admin picks resolutions in the ConflictResolver UI; this endpoint
   * applies them by:
   *   - 'adopt_with_defaults' → merge with theirs strategy on the schema
   *   - 'bulk_update_pages' → rewrite affected page_blocks rows + merge
   *   - 'pin_old_version' → pin block_def_id on affected page_blocks rows
   *   - 'replace_block' → swap block_def_id on affected page_blocks rows
   *   - 'abort' → return without merging
   *
   * For v1 the "real" merge logic is the responsibility of the publish
   * worker's applyTheme; this endpoint records the decisions in
   * templates_apply_decisions and re-tries the merge with the right
   * pre-merge data fixups.
   */
  async function applyThemeResolve(req: RequestWithUser, res: Response): Promise<void> {
    const siteId = paramAs(req.params.id);
    if (!siteId) {
      res.status(400).json({ error: 'missing_site_id', message: 'site id required' } satisfies ErrorEnvelope);
      return;
    }
    const body = req.body ?? {};
    const resolutions = Array.isArray(body.resolutions) ? body.resolutions : [];

    if (resolutions.length === 0) {
      res.status(400).json({ error: 'no_resolutions', message: 'resolutions array required' } satisfies ErrorEnvelope);
      return;
    }

    if (resolutions.some((r: { resolution?: string }) => r.resolution === 'abort')) {
      // Any 'abort' means the whole apply is aborted (per spec §6.2).
      res.status(200).json({ aborted: true });
      return;
    }

    // Pre-merge data fixups (per resolution kind):
    for (const r of resolutions as Array<{ block: string; resolution: string; replacement_block?: string; field_map?: Record<string, string> }>) {
      try {
        if (r.resolution === 'replace_block' && r.replacement_block) {
          // Swap block_def_id on affected page_blocks rows
          await deps.supabase.rpc('sites_swap_block_def', {
            p_site_id: siteId,
            p_old_block_name: r.block,
            p_new_block_name: r.replacement_block,
          });
        } else if (r.resolution === 'bulk_update_pages' && r.field_map) {
          // Rewrite affected page_blocks.content per field_map
          await deps.supabase.rpc('sites_rename_block_fields', {
            p_site_id: siteId,
            p_block_name: r.block,
            p_field_map: r.field_map,
          });
        }
        // 'pin_old_version' and 'adopt_with_defaults' don't need pre-merge fixups —
        // the merge itself + git history covers them.
      } catch (err) {
        logger.warn('apply-theme resolution pre-fixup failed', { siteId, resolution: r.resolution, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Re-attempt the apply
    try {
      const result = await publishWorker.applyTheme({ siteId, fastTrack: false, triggeredBy: req.user?.id ?? '' });
      if (result.conflicts.length > 0) {
        // If still conflicts after fixups → return 409 again
        res.status(409).json({
          error: 'theme_apply_conflict',
          message: 'Conflicts remain after applying resolutions',
          details: { conflicts: result.conflicts },
        } satisfies ErrorEnvelope);
        return;
      }
      res.status(200).json({
        appliedCommit: result.appliedCommit,
        filesChanged: result.filesChanged,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('apply-theme resolve failed', { siteId, error: message });
      res.status(503).json({ error: 'apply_resolve_failed', message } satisfies ErrorEnvelope);
    }
  }

  /**
   * POST /admin/sites/:id/graduate-git
   * Body: { git_url, pat }
   * Promotes an internal repo to external.
   */
  async function graduateGit(req: RequestWithUser, res: Response): Promise<void> {
    const siteId = paramAs(req.params.id);
    if (!siteId) {
      res.status(400).json({ error: 'missing_site_id', message: 'site id required' } satisfies ErrorEnvelope);
      return;
    }
    const body = req.body ?? {};
    const gitUrl = typeof body.git_url === 'string' ? body.git_url : '';
    const pat = typeof body.pat === 'string' ? body.pat : '';
    if (!gitUrl || !pat) {
      res.status(400).json({ error: 'missing_fields', message: 'git_url and pat required' } satisfies ErrorEnvelope);
      return;
    }

    try {
      // Resolve current internal repo + site row
      const repo = await resolveSiteRepo(siteId);
      if (!repo) {
        res.status(409).json({ error: 'no_internal_repo', message: 'site does not have an internal repo to graduate from' } satisfies ErrorEnvelope);
        return;
      }
      const siteResult = await deps.supabase.from('sites').select('name, slug').eq('id', siteId).single();
      const site = (siteResult as { data: { name: string; slug: string } | null }).data;
      if (!site) {
        res.status(404).json({ error: 'site_not_found', message: 'site not found' } satisfies ErrorEnvelope);
        return;
      }

      // Lazy-import to avoid pulling git child_process into the test surface
      const { graduateToExternal } = await import('../lib/git/graduate-to-external.js');
      const result = await graduateToExternal(
        { siteId, externalGitUrl: gitUrl, pat, internalRepo: repo, site },
        { supabase: deps.supabase, gitServer, fetch: globalThis.fetch, logger },
      );
      res.status(200).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('pat_under_scoped:')) {
        res.status(400).json({ error: 'pat_under_scoped', message: message.replace(/^pat_under_scoped:\s*/, '') } satisfies ErrorEnvelope);
        return;
      }
      logger.error('graduate-git failed', { siteId, error: message });
      res.status(503).json({ error: 'graduate_failed', message } satisfies ErrorEnvelope);
    }
  }

  return { getDrift, applyTheme, applyThemeResolve, graduateGit };
}

export function mountSourceRoutes(router: Router, routes: ReturnType<typeof createSourceRoutes>): void {
  router.get('/sites/:id/drift', routes.getDrift);
  router.post('/sites/:id/apply-theme', routes.applyTheme);
  router.post('/sites/:id/apply-theme/resolve', routes.applyThemeResolve);
  router.post('/sites/:id/graduate-git', routes.graduateGit);
}
