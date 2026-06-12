/**
 * Edition publish-to-git — server-side renderer + commit pipeline. Per
 * spec-builder-evaluation §3.6 (extended).
 *
 * Mirrors sites' publish-worker pattern: take an edition, render via
 * `<EditionEmail/>` once, commit the output to the newsletter's
 * internal Git repo on the `publish` branch. Each newsletter's repo
 * accumulates one commit per edition publish; operators can graduate
 * the internal repo to an external GitHub remote at any time
 * (graduate-to-external, sites-shared infra).
 *
 * Lazy clone: if the newsletter doesn't yet have an internal repo
 * (no `gatewaze_internal_repos` row with host_kind='newsletter',
 * host_id=<newsletter_id>), the first publish creates it via
 * `gitServer.createRepo({ boilerplateUrl })`, where the URL comes from
 * `getBoilerplateConfig('newsletter')` (env-overridable via
 * GATEWAZE_NEWSLETTER_BOILERPLATE_URL).
 *
 * The endpoint is deliberately tolerant of missing pieces: when the
 * boilerplate URL is unset OR the gitServer dep isn't wired in this
 * deployment, the route returns a 200 with `{ kind: 'skipped',
 * reason: ... }` so the editor's Publish flow degrades gracefully
 * to DB-only persistence (today's behaviour).
 */

import type { Router, Response, NextFunction } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { editionFolderSlug } from '../lib/edition-slug.js';

const execFileP = promisify(execFile);

/** One entry in the publish branch's root `editions.json` archive manifest. */
interface ArchiveEntry {
  slug: string;
  edition_date: string;
  subject: string | null;
  preheader: string | null;
}

/**
 * PostgREST returns bytea columns as `\\x<hex>` strings. Tokens written
 * into templates_sources.token_secret_ref as ASCII (PAT or deploy-key PEM)
 * round-trip through that encoding when the column is bytea; for text
 * columns they come back unchanged. Tolerate both shapes so the same
 * publish-to-git code paths work in either schema.
 */
function decodeMaybeBytea(value: string): string {
  if (typeof value !== 'string') return value;
  if (!value.startsWith('\\x')) return value;
  try {
    return Buffer.from(value.slice(2), 'hex').toString('utf8');
  } catch {
    return value;
  }
}

// NOTE: This endpoint used to import EditionEmail + @react-email/render and
// render the HTML server-side. That pulled the admin's email-blocks barrel
// which transitively requires the field adapters (Puck, @heroicons/react,
// sonner, the admin's RichTextEditor via the `@/` alias) — none of which
// resolve in the API container. The editor already produces the rendered
// HTML via `exportEditionHtml` (the same path the Send and HTML-export
// buttons use), so the client now POSTs it in the request body. The
// endpoint just commits it to git.

interface RequestWithUser {
  userId?: string;
  params: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Minimal subset of sites' InternalGitServer interface — the only
 * methods this route calls. Imported lazily so the newsletters
 * module doesn't hard-depend on sites being installed; if absent,
 * the endpoint short-circuits to skipped-mode.
 */
interface MinimalGitServer {
  lookupRepo(hostKind: 'newsletter', hostId: string): Promise<{ id: string; barePath: string; defaultBranch: string } | null>;
  createRepo(args: {
    hostKind: 'newsletter';
    hostId: string;
    slug: string;
    boilerplateUrl?: string | null;
    boilerplateBranch?: string | null;
  }): Promise<{ id: string; barePath: string; defaultBranch: string }>;
  publishCommit(args: {
    repo: { id: string; barePath: string };
    branch: string;
    /**
     * Map of relative path → file contents. The impl iterates
     * via `for (const [path, contents] of args.files)`; an array
     * of `{path, content}` objects would silently destructure to
     * `undefined, undefined` and fail with "for is not iterable"
     * (the impl expects a Map per sites/lib/git/internal-git-server.ts).
     */
    files: Map<string, Buffer | string>;
    /**
     * When true (used by the theme-overlay path) the impl treats the
     * files map as the authoritative tree, deleting anything in the
     * prior commit not present in the map. Without this, stale theme
     * files would accumulate across publishes once a theme deletes a
     * file. Mirrors sites' PublishCommitArgs.replaceTree.
     */
    replaceTree?: boolean;
    message: string;
    author: { name: string; email: string };
  }): Promise<{ sha: string; diffBytes: number; filesChanged: number }>;
}

export interface PublishToGitDeps {
  supabase: SupabaseClient;
  gitServer?: MinimalGitServer;
  /** Override env. Empty string / undefined → skipped. */
  boilerplateUrl?: string | null;
  boilerplateBranch?: string | null;
}

export function createPublishToGitRoute(deps: PublishToGitDeps) {
  return async function publishToGit(req: RequestWithUser, res: Response, _next: NextFunction): Promise<void> {
    if (!req.userId) {
      res.status(401).json({ error: { code: 'unauthenticated', message: 'session required' } });
      return;
    }
    const editionId = req.params.editionId;
    if (!editionId) {
      res.status(400).json({ error: { code: 'missing_edition_id' } });
      return;
    }

    if (!deps.gitServer) {
      res.status(200).json({ kind: 'skipped', reason: 'gitServer dependency not wired in this deployment' });
      return;
    }

    try {
      // 1. Load edition + blocks + parent newsletter.
      const editionRes = await deps.supabase
        .from('newsletters_editions')
        .select('id, title, edition_date, preheader, status, collection_id')
        .eq('id', editionId)
        .maybeSingle();
      if (editionRes.error || !editionRes.data) {
        // eslint-disable-next-line no-console
        console.warn('[newsletters publish-to-git] edition lookup failed', {
          editionId,
          supabaseError: editionRes.error?.message ?? null,
          supabaseDetails: editionRes.error?.details ?? null,
          hasData: !!editionRes.data,
        });
        res.status(404).json({
          error: {
            code: 'edition_not_found',
            // Surface the actual lookup parameters in the message so
            // the editor's toast tells the operator exactly which
            // edition the server couldn't find. Previously the
            // message was the bare supabase error (empty string when
            // .single() returned 0 rows), which read like a route-
            // not-found from the network tab.
            message: editionRes.error?.message
              ? `Edition lookup failed: ${editionRes.error.message} (editionId=${editionId})`
              : `No newsletters_editions row with id=${editionId}. Has the edition been saved to the database yet?`,
            editionId,
          },
        });
        return;
      }
      const ed = editionRes.data as {
        id: string; title: string | null; edition_date: string;
        preheader: string | null; status: string; collection_id: string | null;
      };

      // 2. Resolve the channel container — `newsletters_template_collections`
      //    holds the actual channel definition (name, slug, branding). The
      //    repo is keyed off this row's id, mirroring how sites use
      //    `sites.id` as the gatewaze_internal_repos.host_id.
      if (!ed.collection_id) {
        res.status(200).json({
          kind: 'skipped',
          reason: 'edition has no parent collection',
          editionId,
        });
        return;
      }
      const collRes = await deps.supabase
        .from('newsletters_template_collections')
        .select('id, slug, name, git_provenance, git_url, git_url_theme, git_branch, config, view_online_external_base_url')
        .eq('id', ed.collection_id)
        .maybeSingle();
      if (collRes.error || !collRes.data) {
        res.status(200).json({
          kind: 'skipped',
          reason: 'collection lookup failed',
          editionId,
        });
        return;
      }
      const collection = collRes.data as {
        id: string;
        slug: string;
        name: string;
        git_provenance: 'internal' | 'external';
        git_url: string | null;
        git_url_theme: string | null;
        git_branch: string | null;
        config: {
          theme?: {
            url?: string;
            ref?: string;
            subdir?: string;
            owns_routing?: boolean;
          };
          publish?: {
            external_branch?: string;
            embed_media_in_git?: boolean;
          };
        } | null;
        view_online_external_base_url: string | null;
      };
      const newsletterConfig = collection.config ?? {};
      const newsletterId = collection.id;
      const newsletterSlug = collection.slug;

      // Gate: only publish to git when the newsletter has graduated
      // to an EXTERNAL git repo. While git_provenance='internal' the
      // platform's lazy-cloned boilerplate is the only thing on the
      // PVC — committing edition output there pollutes the
      // gatewaze-template-email starting point and confuses the
      // graduate-to-external flow later. Return a 200/skipped so the
      // editor can surface a clear "no external repo connected"
      // warning instead of an opaque error.
      if (collection.git_provenance !== 'external' || !collection.git_url) {
        res.status(200).json({
          kind: 'skipped',
          reason: 'no_external_git_repo',
          message:
            'This newsletter is using the platform boilerplate template. ' +
            'Connect an external git repo (Settings → Git) before publishing — ' +
            'editions are still saved to the database.',
          editionId,
        });
        return;
      }

      // 3. Lookup or lazy-create the internal repo for the newsletter.
      let repo = await deps.gitServer.lookupRepo('newsletter', newsletterId);
      if (!repo) {
        if (!deps.boilerplateUrl) {
          res.status(200).json({
            kind: 'skipped',
            reason: 'GATEWAZE_NEWSLETTER_BOILERPLATE_URL not set; edition saved to DB only',
          });
          return;
        }
        repo = await deps.gitServer.createRepo({
          hostKind: 'newsletter',
          hostId: newsletterId,
          slug: newsletterSlug,
          boilerplateUrl: deps.boilerplateUrl,
          boilerplateBranch: deps.boilerplateBranch ?? 'theme',
        });
      }

      // 4. Take the rendered HTML from the request body (produced
      //    client-side via exportEditionHtml — same path the editor's
      //    Send and HTML-export buttons use). We also still load the
      //    blocks so we can persist a content-stable JSON snapshot
      //    alongside the HTML; the join to templates_block_defs is
      //    only used to record render_kind / component_id on each
      //    block row in the JSON output, so external consumers know
      //    how the HTML was produced.
      const html = typeof req.body?.html === 'string' ? req.body.html : '';
      if (!html) {
        res.status(400).json({
          error: {
            code: 'missing_rendered_html',
            message:
              'publish-to-git requires the editor-rendered HTML in the request body (`html` field). ' +
              'The server no longer renders editions — exportEditionHtml runs client-side.',
          },
        });
        return;
      }

      const blocksRes = await deps.supabase
        .from('newsletters_edition_blocks')
        .select(`
          id, block_type, content, sort_order, templates_block_def_id,
          block_template:templates_block_defs!templates_block_def_id(id, html, render_kind, component_id)
        `)
        .eq('edition_id', editionId)
        .order('sort_order');
      if (blocksRes.error) {
        res.status(500).json({ error: { code: 'blocks_fetch_failed', message: blocksRes.error.message } });
        return;
      }
      const blockRows = (blocksRes.data ?? []) as Array<{
        id: string; block_type: string; content: Record<string, unknown>; sort_order: number;
        templates_block_def_id: string | null;
        block_template: { id: string; html: string | null; render_kind: 'mustache' | 'react-email'; component_id: string | null } | null;
      }>;

      // 6. Build the publish file map.
      //
      //    - The newsletter's edition artifacts ALWAYS go to the
      //      conventional `editions/<id>.{html,json}` paths.
      //    - When `config.theme.url + ref` is set, we overlay the theme
      //      repo's files BEFORE the platform-emitted artifacts, so a
      //      theme component shipping its own `editions/<id>.html` is
      //      overridden by the freshly-rendered HTML. The resulting tree
      //      is self-contained — a static site generator pointed at the
      //      publish branch can build the archive page without any
      //      additional inputs.
      //
      //    publishCommit expects a Map<path, contents>; the iteration in
      //    modules/sites/lib/git/internal-git-server-impl.ts requires
      //    that exact shape.
      const files = new Map<string, Buffer | string>();

      // Local workspace branch on the internal bare repo — always 'publish'
      // (the edition-writer + snapshot-job target it). The REMOTE branch name
      // is resolved separately at push time (step 7). Declared here so the
      // archive-manifest read below can reference it.
      const localPublishBranch = 'publish';

      // Theme overlay (optional). Failures are logged but non-fatal —
      // the edition still publishes with platform-only deltas. The
      // operator's deploy target needs to supply the theme separately
      // in that case.
      let themeOverlayApplied: { url: string; ref: string; clonedSha: string } | null = null;
      const themeConfig = newsletterConfig.theme;
      if (themeConfig?.url && themeConfig.ref) {
        try {
          const { applyThemeOverlay } = await import('../lib/publish-worker/theme-overlay.js');
          const overlayLog = await applyThemeOverlay(
            { url: themeConfig.url, ref: themeConfig.ref, subdir: themeConfig.subdir },
            files,
            {
              logger: {
                info: (msg, meta) => { console.info('[newsletters publish-to-git]', msg, meta ?? {}); },
                warn: (msg, meta) => { console.warn('[newsletters publish-to-git]', msg, meta ?? {}); },
              },
            },
          );
          themeOverlayApplied = {
            url: themeConfig.url,
            ref: themeConfig.ref,
            clonedSha: overlayLog.clonedSha,
          };
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[newsletters publish-to-git] theme overlay failed (continuing)', {
            editionId,
            themeUrl: themeConfig.url,
            themeRef: themeConfig.ref,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Each edition is its own folder at the publish-branch root:
      //   <date-subject>/index.html   — the rendered email, served at
      //                                 <base>/<date-subject>/ (no .html suffix)
      //   <date-subject>/edition.json — machine-readable snapshot alongside it
      // The slug is shared with the send-time "View Online" link so the two
      // always resolve to the same path.
      const editionSlug = editionFolderSlug(ed.edition_date, ed.title);
      files.set(`${editionSlug}/index.html`, html);
      // Effective per-block render path sent by the editor (how the HTML was
      // actually produced). Falls back to the templates_block_defs metadata
      // for older clients that don't send it.
      const blockRenderById = new Map<string, { render_kind?: string; component_id?: string }>();
      if (Array.isArray(req.body?.blockRender)) {
        for (const r of req.body.blockRender as Array<{ id?: unknown; render_kind?: unknown; component_id?: unknown }>) {
          if (r && typeof r.id === 'string') {
            blockRenderById.set(r.id, {
              render_kind: typeof r.render_kind === 'string' ? r.render_kind : undefined,
              component_id: typeof r.component_id === 'string' ? r.component_id : undefined,
            });
          }
        }
      }
      files.set(`${editionSlug}/edition.json`, JSON.stringify({
        id: ed.id,
        slug: editionSlug,
        edition_date: ed.edition_date,
        subject: ed.title,
        preheader: ed.preheader,
        status: ed.status,
        blocks: blockRows.map((b) => {
          const eff = blockRenderById.get(b.id);
          return {
            id: b.id,
            block_type: b.block_type,
            content: b.content,
            sort_order: b.sort_order,
            render_kind: eff?.render_kind ?? b.block_template?.render_kind ?? 'react-email',
            component_id: eff?.component_id ?? b.block_template?.component_id ?? b.block_type,
          };
        }),
      }, null, 2));

      // Maintain a root archive: `editions.json` (the manifest of everything
      // published to this branch) drives a regenerated `index.html`. The
      // manifest is the source of truth — NOT the DB — because editions are
      // pushed to git while still in 'draft' status, so a status query would
      // miss them. Read the existing manifest off the branch, upsert this
      // edition, and rewrite. Non-fatal on failure.
      try {
        let manifest: ArchiveEntry[] = [];
        try {
          const { stdout } = await execFileP(
            'git',
            ['show', `${localPublishBranch}:editions.json`],
            { cwd: repo.barePath, timeout: 10_000 },
          );
          const parsed = JSON.parse(stdout);
          if (Array.isArray(parsed)) manifest = parsed as ArchiveEntry[];
        } catch {
          // No manifest yet (first publish) — start fresh.
        }
        manifest = manifest.filter((e) => e.slug !== editionSlug);
        manifest.push({
          slug: editionSlug,
          edition_date: String(ed.edition_date),
          subject: ed.title,
          preheader: ed.preheader,
        });
        manifest.sort((a, b) => b.edition_date.localeCompare(a.edition_date));
        const siteBase = collection.view_online_external_base_url?.trim().replace(/\/+$/, '') || '';
        files.set('editions.json', JSON.stringify(manifest, null, 2));
        files.set('index.html', renderArchiveIndex(collection.name || newsletterSlug, manifest, { hasFeed: true }));
        files.set('feed.xml', renderRssFeed(collection.name || newsletterSlug, siteBase, manifest));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[newsletters publish-to-git] archive index generation failed (continuing)', {
          editionId, error: err instanceof Error ? err.message : String(err),
        });
      }

      // Commit to the local publish branch (localPublishBranch, declared
      // above). Migration 027 stored a `git_branch` column for legacy
      // reasons; the INTERNAL commit stays on 'publish' — the publish-worker
      // abstraction owns the remote-side branch name (see step 7 below).
      const result = await deps.gitServer.publishCommit({
        repo: { id: repo.id, barePath: repo.barePath },
        branch: localPublishBranch,
        files,
        // When the theme overlay ran the file map now represents the
        // full intended publish tree; tell the impl to prune anything
        // not in the map so old theme files don't accumulate.
        // Without an overlay we keep the legacy delta-publish behaviour
        // so newsletters that never enable themes still accumulate
        // commits the same way they always have.
        replaceTree: themeOverlayApplied !== null,
        message: `Publish edition ${ed.title ?? ed.edition_date}`,
        author: { name: 'gatewaze-publisher', email: 'noreply@gatewaze' },
      });

      // 7. Mirror the local `publish` branch out to the external repo.
      //    The REMOTE branch name comes from `config.publish.external_
      //    branch` — defaults to 'publish' for the legacy single-repo
      //    convention; set to 'main' for separate-repo graduations (the
      //    publish repo's default branch is `main`).
      //
      //    Auth precedence:
      //      1. templates_sources.token_secret_ref looked up by the
      //         publish URL. The graduate flow stores the deploy
      //         PRIVATE KEY here (PEM). When present, we push via SSH
      //         with that key. PAT-bearing strings (no '-----BEGIN ...
      //         PRIVATE KEY-----' marker) fall through to HTTPS-with-
      //         token for back-compat with earlier graduations.
      //      2. No source row / no token → push fails with no_token_
      //         persisted. The publish-worker model intentionally
      //         drops the user's PAT after graduate; we never persist
      //         it anywhere else.
      const remoteBranch =
        newsletterConfig.publish?.external_branch ||
        // Fall back to the legacy `git_branch` column when set (operators
        // upgrading from migration 027 might have it).
        collection.git_branch ||
        'publish';

      let externalPush: null | { pushed: true; branch: string } | { pushed: false; error: string } = null;
      const sourceRes = await deps.supabase
        .from('templates_sources')
        .select('token_secret_ref')
        .eq('library_id', collection.id)
        .eq('kind', 'git')
        .eq('url', collection.git_url)
        .maybeSingle();
      const tokenRaw = (sourceRes.data as { token_secret_ref: string | null } | null)?.token_secret_ref;
      const token = tokenRaw ? decodeMaybeBytea(tokenRaw) : null;

      if (!token || token === '<redacted>') {
        externalPush = { pushed: false, error: 'no_token_persisted' };
      } else if (isOpenSshPrivateKey(token)) {
        // SSH push using deploy key
        externalPush = await pushWithDeployKey({
          repoBarePath: repo.barePath,
          externalUrl: collection.git_url!,
          remoteBranch,
          localBranch: localPublishBranch,
          deployKeyPem: token,
          editionId,
        });
      } else {
        // PAT-with-HTTPS fallback (legacy graduations)
        const urlWithAuth = collection.git_url!.replace(
          /^https?:\/\//,
          (m) => `${m}x-access-token:${encodeURIComponent(token)}@`,
        );
        try {
          // --force: the internal bare repo is canonical for the publish
          // branch — it accumulates every rendered edition. The external
          // `publish` branch is a generated mirror, so we overwrite it
          // rather than fast-forward (mirrors sites' mirrorBranchToExternal).
          // Without this, an external `publish` branch that was created with
          // its own initial commit diverges and rejects the push as
          // non-fast-forward ("fetch first").
          await execFileP(
            'git',
            ['push', '--force', urlWithAuth, `${localPublishBranch}:${remoteBranch}`],
            { cwd: repo.barePath, timeout: 30_000 },
          );
          externalPush = { pushed: true, branch: remoteBranch };
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          // Strip the PAT-bearing URL before logging or returning.
          const safe = raw.replace(urlWithAuth, collection.git_url!).slice(0, 500);
          // eslint-disable-next-line no-console
          console.warn('[newsletters publish-to-git] external mirror push failed', { editionId, error: safe });
          externalPush = { pushed: false, error: safe };
        }
      }

      res.status(200).json({
        kind: 'published',
        editionId: ed.id,
        repoId: repo.id,
        commitSha: result.sha,
        branch: localPublishBranch,
        files: [`editions/${ed.id}.html`, `editions/${ed.id}.json`],
        externalPush,
        externalUrl: collection.git_url,
        externalThemeUrl: collection.git_url_theme,
        remoteBranch,
        themeOverlay: themeOverlayApplied,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[newsletters publish-to-git] unexpected error', err);
      res.status(500).json({
        error: {
          code: 'publish_to_git_failed',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  };
}

export function mountPublishToGitRoute(
  router: Router,
  handler: ReturnType<typeof createPublishToGitRoute>,
): void {
  router.post('/newsletters/editions/:editionId/publish-to-git', handler as never);
}

// ---------------------------------------------------------------------------
// Deploy-key SSH push helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Detect whether a token string is an OpenSSH private key (PEM-encoded
 * Ed25519 from `ssh-keygen`) vs a classic PAT. The graduate flow writes
 * private keys to templates_sources.token_secret_ref; older single-repo
 * graduations may have written the user's PAT instead. We branch on
 * shape rather than on a sentinel column so both states keep working
 * during the rollout.
 */
export function isOpenSshPrivateKey(value: string): boolean {
  return /-----BEGIN (OPENSSH|RSA|EC|DSA) PRIVATE KEY-----/.test(value);
}

/**
 * Convert an HTTPS or SSH-style URL into the canonical SSH-pushable form
 * (`git@github.com:owner/repo.git`). Leaves SSH URLs unchanged. Returns
 * null for shapes we don't know how to push to (we surface a clear
 * "unsupported_url" error rather than guessing).
 */
export function toSshPushUrl(url: string): string | null {
  if (/^git@[^:]+:/.test(url)) return url; // already SSH
  const ghMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (ghMatch) return `git@github.com:${ghMatch[1]}/${ghMatch[2]}.git`;
  const glMatch = url.match(/^https?:\/\/gitlab\.com\/(.+?)(?:\.git)?\/?$/);
  if (glMatch) return `git@gitlab.com:${glMatch[1]}.git`;
  return null;
}

/**
 * Push a local branch to the external repo using an Ed25519 deploy key.
 * Writes the key to a tmp file (0600 perms), passes it to git via
 * GIT_SSH_COMMAND, and cleans up regardless of push outcome.
 */
export async function pushWithDeployKey(args: {
  repoBarePath: string;
  externalUrl: string;
  remoteBranch: string;
  localBranch: string;
  deployKeyPem: string;
  editionId: string;
}): Promise<{ pushed: true; branch: string } | { pushed: false; error: string }> {
  const sshUrl = toSshPushUrl(args.externalUrl);
  if (!sshUrl) {
    return { pushed: false, error: `unsupported_url: cannot derive ssh form from ${args.externalUrl}` };
  }
  const tmpDir = await mkdtemp(join(tmpdir(), 'gatewaze-newsletter-push-'));
  const keyPath = join(tmpDir, 'deploy_key');
  try {
    await writeFile(keyPath, args.deployKeyPem, { mode: 0o600 });
    const sshCmd = `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes`;
    // --force: the internal bare repo is canonical for the publish branch;
    // the external mirror is overwritten, not fast-forwarded (see the PAT
    // path above and sites' mirrorBranchToExternal for the same rationale).
    await execFileP(
      'git',
      ['push', '--force', sshUrl, `${args.localBranch}:${args.remoteBranch}`],
      {
        cwd: args.repoBarePath,
        timeout: 30_000,
        env: { ...process.env, GIT_SSH_COMMAND: sshCmd, GIT_TERMINAL_PROMPT: '0' },
      },
    );
    return { pushed: true, branch: args.remoteBranch };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn('[newsletters publish-to-git] deploy-key push failed', {
      editionId: args.editionId,
      error: raw.slice(0, 500),
    });
    return { pushed: false, error: raw.slice(0, 500) };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the static archive index for the publish branch — a self-contained
 * `index.html` listing every published edition, newest first, linking to each
 * edition's `<slug>/` folder (clean URL, no `.html`). A static host (GitHub
 * Pages / Netlify / Cloudflare Pages) pointed at the publish branch serves this
 * as the newsletter's public archive with no build step.
 */
export function renderArchiveIndex(
  title: string,
  editions: Array<{ slug: string; edition_date: string; subject: string | null; preheader: string | null }>,
  opts: { hasFeed?: boolean } = {},
): string {
  const items = editions
    .map((e) => {
      const dateLabel = (() => {
        const d = new Date(`${e.edition_date}T00:00:00Z`);
        return Number.isNaN(d.getTime())
          ? e.edition_date
          : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
      })();
      const heading = escapeHtml(e.subject?.trim() || dateLabel);
      const preheader = e.preheader?.trim() ? `<p class="pre">${escapeHtml(e.preheader.trim())}</p>` : '';
      return `      <li class="edition">
        <a href="${e.slug.split('/').map(encodeURIComponent).join('/')}/">
          <span class="date">${escapeHtml(dateLabel)}</span>
          <span class="title">${heading}</span>
          ${preheader}
        </a>
      </li>`;
    })
    .join('\n');

  const safeTitle = escapeHtml(title);
  const feedLink = opts.hasFeed
    ? `\n  <link rel="alternate" type="application/rss+xml" title="${safeTitle}" href="feed.xml" />`
    : '';
  const feedCta = opts.hasFeed
    ? `\n  <p class="sub"><a href="feed.xml" class="rss">Subscribe via RSS</a></p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle} — Archive</title>${feedLink}
  <style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
           max-width: 680px; margin: 0 auto; padding: 48px 20px; line-height: 1.5;
           color: #1a1a1a; background: #fff; }
    h1 { font-size: 28px; margin: 0 0 8px; }
    .sub { color: #666; margin: 0 0 32px; font-size: 15px; }
    ul { list-style: none; padding: 0; margin: 0; }
    .edition { border-top: 1px solid #eaeaea; }
    .edition a { display: block; padding: 16px 4px; text-decoration: none; color: inherit; }
    .edition a:hover { background: #fafafa; }
    .date { display: block; font-size: 13px; color: #888; text-transform: uppercase; letter-spacing: .04em; }
    .title { display: block; font-size: 18px; font-weight: 600; margin-top: 2px; }
    .pre { margin: 4px 0 0; color: #666; font-size: 14px; }
    .rss { color: #c2570c; text-decoration: none; }
    .rss:hover { text-decoration: underline; }
    @media (prefers-color-scheme: dark) {
      body { color: #eaeaea; background: #111; }
      .sub, .date, .pre { color: #999; }
      .edition { border-color: #2a2a2a; }
      .edition a:hover { background: #1a1a1a; }
      .rss { color: #f0822e; }
    }
  </style>
</head>
<body>
  <h1>${safeTitle}</h1>
  <p class="sub">Newsletter archive — ${editions.length} edition${editions.length === 1 ? '' : 's'}</p>${feedCta}
  <ul>
${items}
  </ul>
</body>
</html>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render an RSS 2.0 feed (feed.xml) for the publish-branch root. Items link to
 * each edition's `<slug>/` folder, resolved against the newsletter's configured
 * site base URL when present; otherwise links are folder-relative (feed readers
 * resolve them against the feed URL). Referenced from index.html via
 * <link rel="alternate" type="application/rss+xml">.
 */
export function renderRssFeed(
  title: string,
  siteBase: string,
  editions: Array<{ slug: string; edition_date: string; subject: string | null; preheader: string | null }>,
): string {
  const base = siteBase.replace(/\/+$/, '');
  const items = editions
    .map((e) => {
      const path = `${e.slug.split('/').map(encodeURIComponent).join('/')}/`;
      const link = base ? `${base}/${path}` : path;
      const d = new Date(`${e.edition_date}T00:00:00Z`);
      const pubDate = Number.isNaN(d.getTime()) ? '' : `\n      <pubDate>${d.toUTCString()}</pubDate>`;
      const desc = e.preheader?.trim() ? `\n      <description>${escapeXml(e.preheader.trim())}</description>` : '';
      return `    <item>
      <title>${escapeXml(e.subject?.trim() || e.edition_date)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(e.slug)}</guid>${pubDate}${desc}
    </item>`;
    })
    .join('\n');

  const channelTitle = escapeXml(title);
  const selfHref = base ? `${base}/feed.xml` : 'feed.xml';
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${channelTitle}</title>
    <link>${escapeXml(base || '')}</link>
    <description>${channelTitle} — newsletter archive</description>
    <atom:link href="${escapeXml(selfHref)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;
}
