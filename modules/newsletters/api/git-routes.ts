/**
 * Newsletter Git management endpoints — Phase 2 of the unified
 * sites/newsletters publish architecture. Per spec-builder-evaluation
 * §3.6 (extended).
 *
 * Surfaces three operations on the newsletter channel container
 * (`newsletters_template_collections`):
 *
 *   1. POST /api/admin/newsletters/collections/:id/graduate-to-external
 *      — promote the internal bare repo to a GitHub/GitLab remote
 *        (mirrors sites' `graduateToExternal`). Phase 2.1.
 *
 *   2. GET  /api/admin/newsletters/collections/:id/drift
 *      — compare internal HEAD vs external HEAD on the configured
 *        branch. Phase 2.3.
 *
 *   3. GET  /api/admin/newsletters/collections/:id/manifest
 *      — read the cloned boilerplate's `manifest.json` to drive
 *        per-channel overrides (block labels, defaults, enablement).
 *        Phase 2.2.
 *
 * The git-mutating routes delegate the heavy lifting to the
 * sites-module helpers via interface-minimal adapters; the route
 * layer is thin and module-local.
 */

import type { Router, Response, NextFunction } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';

interface RequestWithUser {
  userId?: string;
  params: Record<string, string>;
  body: Record<string, unknown>;
}

interface MinimalGitServer {
  lookupRepo(hostKind: 'newsletter', hostId: string): Promise<{ id: string; barePath: string; defaultBranch: string } | null>;
  createRepo(args: {
    hostKind: 'newsletter';
    hostId: string;
    slug: string;
    boilerplateUrl?: string | null;
    boilerplateBranch?: string | null;
  }): Promise<{ id: string; barePath: string; defaultBranch: string }>;
  // Subset used here for HEAD-SHA + soft-delete operations during graduate.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  headSha?: (repo: { barePath: string }, branch: string) => Promise<string | null>;
  softDeleteRepo?: (repo: { id: string; barePath: string }) => Promise<void>;
}

export interface GitRoutesDeps {
  supabase: SupabaseClient;
  gitServer?: MinimalGitServer;
  /** Boilerplate repo URL — only used by init-repo. */
  boilerplateUrl?: string | null;
  /** Boilerplate branch (default `main`). */
  boilerplateBranch?: string | null;
}

// ---------------------------------------------------------------------------
// Init-repo — eager boilerplate clone at newsletter creation. Called by the
// Setup Wizard after the `newsletters_template_collections` row inserts.
// Idempotent: when a repo already exists for this collection, returns the
// existing repo unchanged. When `NEWSLETTERS_BOILERPLATE_URL` is unset OR
// `gitServer` isn't wired, returns `{ kind: 'skipped' }` so the wizard
// proceeds even in dev environments without the boilerplate.
// ---------------------------------------------------------------------------

export function createInitRepoRoute(deps: GitRoutesDeps) {
  return async function initRepo(req: RequestWithUser, res: Response, _next: NextFunction): Promise<void> {
    if (!req.userId) {
      res.status(401).json({ error: { code: 'unauthenticated' } });
      return;
    }
    const collectionId = req.params.collectionId;
    if (!collectionId) {
      res.status(400).json({ error: { code: 'missing_collection_id' } });
      return;
    }

    if (!deps.gitServer) {
      res.status(200).json({ kind: 'skipped', reason: 'gitServer dependency not wired' });
      return;
    }
    if (!deps.boilerplateUrl) {
      res.status(200).json({ kind: 'skipped', reason: 'NEWSLETTERS_BOILERPLATE_URL not set' });
      return;
    }

    try {
      // Look up the collection to get its slug (used in the bare repo
      // path: /var/gatewaze/git/newsletter/<slug>.git).
      const collRes = await deps.supabase
        .from('newsletters_template_collections')
        .select('id, slug, name')
        .eq('id', collectionId)
        .maybeSingle();
      if (collRes.error || !collRes.data) {
        res.status(404).json({ error: { code: 'collection_not_found', message: collRes.error?.message ?? '' } });
        return;
      }
      const coll = collRes.data as { id: string; slug: string; name: string };

      // Idempotent: createRepo in the existing impl returns the existing
      // row when it's already there. When it's truly new, it clones the
      // boilerplate into a fresh bare repo.
      const repo = await deps.gitServer.createRepo({
        hostKind: 'newsletter',
        hostId: coll.id,
        slug: coll.slug,
        boilerplateUrl: deps.boilerplateUrl,
        boilerplateBranch: deps.boilerplateBranch ?? 'theme',
      });

      res.status(200).json({
        kind: 'initialised',
        collectionId: coll.id,
        slug: coll.slug,
        repoId: repo.id,
        defaultBranch: repo.defaultBranch,
      });
    } catch (err) {
      // Boilerplate clone can fail (network, auth, missing repo).
      // The wizard treats this as non-fatal — the newsletter is
      // already created in the DB; the operator can retry from the
      // Source tab once the issue is resolved.
      // eslint-disable-next-line no-console
      console.warn('[newsletters init-repo] failed', err);
      res.status(200).json({
        kind: 'failed',
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Phase 2.1 — graduate-to-external
// ---------------------------------------------------------------------------
//
// Two layouts are supported:
//
//   1. LEGACY single-repo: body provides `externalGitUrl` + `pat`.
//      Internal bare repo is mirror-pushed to that one remote; `main`
//      (theme/source) and `publish` (built output) both live there.
//
//   2. SEPARATE theme + publish repos: body provides
//      `externalThemeGitUrl` + `externalPublishGitUrl` + `pat`. The
//      platform provisions a deploy key on EACH, pushes `main` to the
//      theme repo, pushes `publish` to the publish repo's `main`
//      (default branch), and sets `config.theme.url` so future
//      publishes overlay the theme automatically.
//
// Either-or — callers MUST NOT mix both shapes. We sniff which shape
// arrived and dispatch to graduateNewsletterToExternal accordingly.

interface NewsletterGraduateBody {
  externalGitUrl?: string;
  externalThemeGitUrl?: string;
  externalPublishGitUrl?: string;
  pat?: string;
}

function pickString(body: Record<string, unknown>, key: keyof NewsletterGraduateBody): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

export function createGraduateToExternalRoute(deps: GitRoutesDeps) {
  return async function graduateToExternal(req: RequestWithUser, res: Response, _next: NextFunction): Promise<void> {
    if (!req.userId) {
      res.status(401).json({ error: { code: 'unauthenticated' } });
      return;
    }
    const collectionId = req.params.collectionId;
    if (!collectionId) {
      res.status(400).json({ error: { code: 'missing_collection_id' } });
      return;
    }

    const externalGitUrl = pickString(req.body, 'externalGitUrl');
    const externalThemeGitUrl = pickString(req.body, 'externalThemeGitUrl');
    const externalPublishGitUrl = pickString(req.body, 'externalPublishGitUrl');
    const pat = pickString(req.body, 'pat');

    const isSingle = !!externalGitUrl;
    const isSeparate = !!externalThemeGitUrl && !!externalPublishGitUrl;

    if (!pat) {
      res.status(400).json({ error: { code: 'missing_fields', message: 'pat is required' } });
      return;
    }
    if (isSingle && (externalThemeGitUrl || externalPublishGitUrl)) {
      res.status(400).json({
        error: {
          code: 'mixed_layout',
          message:
            'cannot mix externalGitUrl (single-repo) with externalThemeGitUrl / externalPublishGitUrl (separate-repos)',
        },
      });
      return;
    }
    if (!isSingle && !isSeparate) {
      res.status(400).json({
        error: {
          code: 'missing_fields',
          message:
            'either externalGitUrl OR both externalThemeGitUrl + externalPublishGitUrl are required',
        },
      });
      return;
    }

    // Provider whitelist (mirrors the legacy check; applies to every URL).
    const urls = isSingle
      ? [externalGitUrl]
      : [externalThemeGitUrl, externalPublishGitUrl];
    for (const url of urls) {
      if (!/^https?:\/\/(github|gitlab)\.com\//.test(url)) {
        res.status(400).json({
          error: {
            code: 'unsupported_provider',
            message: 'only github.com / gitlab.com URLs are supported',
          },
        });
        return;
      }
    }

    if (!deps.gitServer) {
      res.status(503).json({ error: { code: 'git_server_unavailable', message: 'gitServer dependency not wired' } });
      return;
    }

    try {
      // 1. Confirm the collection has an internal repo to graduate.
      const repo = await deps.gitServer.lookupRepo('newsletter', collectionId);
      if (!repo) {
        res.status(409).json({
          error: {
            code: 'no_internal_repo',
            message: 'No internal repo for this newsletter yet. Publish at least one edition first to create it.',
          },
        });
        return;
      }

      // 2. Fetch the collection row for name/slug (used in deploy-key titles).
      const collRes = await deps.supabase
        .from('newsletters_template_collections')
        .select('id, name, slug')
        .eq('id', collectionId)
        .maybeSingle();
      if (collRes.error || !collRes.data) {
        res.status(404).json({ error: { code: 'collection_not_found', message: collRes.error?.message ?? '' } });
        return;
      }
      const coll = collRes.data as { id: string; name: string; slug: string };

      // 3. Lazy-import the graduate impl so this route module doesn't
      //    drag ssh-keygen / spawn at parse time.
      const { graduateNewsletterToExternal } = await import('../lib/git/graduate-to-external.js');

      const softDeleteFn = deps.gitServer.softDeleteRepo
        ? async (r: { id: string; barePath: string }) => {
            // The GitServer's softDeleteRepo expects a richer ref; we
            // build it locally from the lookup result above so the
            // graduate helper can stay narrow on its dependency.
            await deps.gitServer!.softDeleteRepo!({
              id: r.id,
              barePath: r.barePath,
            } as never);
          }
        : undefined;

      const result = await graduateNewsletterToExternal(
        {
          collectionId,
          collection: { name: coll.name, slug: coll.slug },
          internalRepo: { id: repo.id, barePath: repo.barePath },
          externalGitUrl: isSingle ? externalGitUrl : undefined,
          externalThemeGitUrl: isSeparate ? externalThemeGitUrl : undefined,
          externalPublishGitUrl: isSeparate ? externalPublishGitUrl : undefined,
          pat,
        },
        {
          supabase: deps.supabase,
          ...(softDeleteFn ? { softDeleteInternalRepo: softDeleteFn } : {}),
          logger: {
            info: (msg, meta) => { console.info('[newsletters graduate]', msg, meta ?? {}); },
            warn: (msg, meta) => { console.warn('[newsletters graduate]', msg, meta ?? {}); },
            error: (msg, meta) => { console.error('[newsletters graduate]', msg, meta ?? {}); },
          },
        },
      );

      res.status(200).json({
        kind: 'graduated',
        collectionId,
        layout: result.layout,
        externalGitUrl: result.externalGitUrl,
        externalThemeGitUrl: result.externalThemeGitUrl,
        publishRemoteBranch: result.publishRemoteBranch,
        deployKeyId: result.deployKeyId,
        themeDeployKeyId: result.themeDeployKeyId,
        branchProtectionApplied: result.branchProtectionApplied,
        internalPurgeScheduledFor: result.internalPurgeScheduledFor,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[newsletters graduate-to-external] error', err);
      if (message.startsWith('pat_under_scoped:')) {
        res.status(400).json({
          error: { code: 'pat_under_scoped', message: message.replace(/^pat_under_scoped:\s*/, '') },
        });
        return;
      }
      if (message.startsWith('graduate_layout_invalid:')) {
        res.status(400).json({
          error: { code: 'invalid_layout', message: message.replace(/^graduate_layout_invalid:\s*/, '') },
        });
        return;
      }
      res.status(500).json({
        error: { code: 'graduate_failed', message },
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Phase 2.3 — drift detection
// ---------------------------------------------------------------------------

export function createDriftRoute(deps: GitRoutesDeps) {
  return async function drift(req: RequestWithUser, res: Response, _next: NextFunction): Promise<void> {
    if (!req.userId) {
      res.status(401).json({ error: { code: 'unauthenticated' } });
      return;
    }
    const collectionId = req.params.collectionId;
    if (!collectionId) {
      res.status(400).json({ error: { code: 'missing_collection_id' } });
      return;
    }

    try {
      const collRes = await deps.supabase
        .from('newsletters_template_collections')
        .select('git_provenance, git_url, git_branch')
        .eq('id', collectionId)
        .maybeSingle();
      if (collRes.error || !collRes.data) {
        res.status(404).json({ error: { code: 'collection_not_found' } });
        return;
      }
      const coll = collRes.data as { git_provenance: 'internal' | 'external'; git_url: string | null; git_branch: string };

      if (coll.git_provenance !== 'external' || !coll.git_url) {
        // Internal-mode: no drift possible — the platform is the only writer.
        res.status(200).json({ kind: 'no-drift', reason: 'internal repo (platform is sole writer)' });
        return;
      }

      if (!deps.gitServer) {
        res.status(503).json({ error: { code: 'git_server_unavailable' } });
        return;
      }

      const repo = await deps.gitServer.lookupRepo('newsletter', collectionId);
      if (!repo) {
        res.status(200).json({ kind: 'no-drift', reason: 'no internal repo' });
        return;
      }

      const branch = coll.git_branch || 'publish';

      // Internal HEAD (read directly via git rev-parse on the bare repo).
      const internalHeadRes = await execGit(['rev-parse', `refs/heads/${branch}`], { cwd: repo.barePath });
      const internalHead = internalHeadRes.exitCode === 0 ? internalHeadRes.stdout.trim() : null;

      // External HEAD via ls-remote (anonymous; works for public repos
      // and for private repos that have the platform's deploy key).
      const remoteHeadRes = await execGit(['ls-remote', coll.git_url, `refs/heads/${branch}`], { cwd: repo.barePath });
      const remoteHead = remoteHeadRes.exitCode === 0
        ? (remoteHeadRes.stdout.split('\t')[0] ?? '').trim() || null
        : null;

      const drift = internalHead && remoteHead && internalHead !== remoteHead;

      res.status(200).json({
        kind: drift ? 'drift-detected' : 'in-sync',
        branch,
        internalHead,
        remoteHead,
        externalGitUrl: coll.git_url,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[newsletters drift] error', err);
      res.status(500).json({
        error: { code: 'drift_check_failed', message: err instanceof Error ? err.message : String(err) },
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Phase 2.2 — manifest-driven block config
// ---------------------------------------------------------------------------

export function createManifestRoute(deps: GitRoutesDeps) {
  return async function manifest(req: RequestWithUser, res: Response, _next: NextFunction): Promise<void> {
    if (!req.userId) {
      res.status(401).json({ error: { code: 'unauthenticated' } });
      return;
    }
    const collectionId = req.params.collectionId;
    if (!collectionId) {
      res.status(400).json({ error: { code: 'missing_collection_id' } });
      return;
    }

    try {
      if (!deps.gitServer) {
        res.status(200).json({ kind: 'no-manifest', reason: 'gitServer unavailable' });
        return;
      }
      const repo = await deps.gitServer.lookupRepo('newsletter', collectionId);
      if (!repo) {
        res.status(200).json({ kind: 'no-manifest', reason: 'no internal repo' });
        return;
      }

      // Read manifest.json from the bare repo's tree at HEAD of the
      // default branch. We use `git show <branch>:manifest.json`
      // rather than checking out a working tree.
      const showRes = await execGit(['show', `refs/heads/main:manifest.json`], { cwd: repo.barePath });
      if (showRes.exitCode !== 0 || !showRes.stdout) {
        res.status(200).json({ kind: 'no-manifest', reason: 'manifest.json not found at HEAD' });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(showRes.stdout);
      } catch (e) {
        res.status(200).json({
          kind: 'no-manifest',
          reason: `manifest.json invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }

      res.status(200).json({ kind: 'manifest', manifest: parsed });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[newsletters manifest] error', err);
      res.status(500).json({
        error: { code: 'manifest_read_failed', message: err instanceof Error ? err.message : String(err) },
      });
    }
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ExecGitResult { exitCode: number; stdout: string; stderr: string; }

function execGit(args: string[], opts: { cwd: string; env?: Record<string, string | undefined> } = { cwd: process.cwd() }): Promise<ExecGitResult> {
  return new Promise((resolveP) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}), GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('close', (code) => resolveP({ exitCode: code ?? 1, stdout, stderr }));
    child.on('error', (err) => resolveP({ exitCode: 1, stdout: '', stderr: err.message }));
  });
}

// `existsSync` + `readFileSync` + `resolvePath` are imported above so this
// file can be statically analysed even when callers don't exercise the
// fallback branches; tests mock `execGit` rather than the fs helpers.
void existsSync; void readFileSync; void resolvePath;

// ---------------------------------------------------------------------------
// route mount
// ---------------------------------------------------------------------------

export function mountGitRoutes(
  router: Router,
  routes: {
    initRepo: ReturnType<typeof createInitRepoRoute>;
    graduateToExternal: ReturnType<typeof createGraduateToExternalRoute>;
    drift: ReturnType<typeof createDriftRoute>;
    manifest: ReturnType<typeof createManifestRoute>;
  },
): void {
  router.post('/newsletters/collections/:collectionId/init-repo', routes.initRepo as never);
  router.post('/newsletters/collections/:collectionId/graduate-to-external', routes.graduateToExternal as never);
  router.get('/newsletters/collections/:collectionId/drift', routes.drift as never);
  router.get('/newsletters/collections/:collectionId/manifest', routes.manifest as never);
}
