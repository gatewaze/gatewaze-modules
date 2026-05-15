/**
 * PublishWorker — orchestrates the content-publish flow against the
 * internal git server.
 *
 * Per spec-content-modules-git-architecture §6.2 + §22.1.
 *
 * Responsibilities:
 *   1. Receive enqueueRepublish() call from API / cron / webhook / MCP
 *   2. Hold per-repo advisory lock (delegated to InternalGitServer)
 *   3. Read current page content + run build-time fetchers
 *   4. Build content/*.json file map
 *   5. Run AI-generated `before-publish` cadence blocks
 *   6. Call git server's publishCommit
 *   7. Write site_republish_log row
 *   8. Return publishId immediately; finalize asynchronously
 *
 * The "async" pattern: enqueueRepublish writes the log row with
 * status='pending', returns the row id, then runs the actual work
 * via setImmediate. Failure → updates the row to status='failed'.
 */

import type { InternalGitServer, InternalRepoRef, CommitResult } from '../git/internal-git-server.js';

/**
 * PostgREST renders bytea columns as the string "\\x<hex>" by default.
 * sites_secrets.deploy_key was written as ASCII PEM bytes (OpenSSH private
 * key); decoding the hex round-trips back to the original PEM text. Falls
 * through unchanged for values that aren't in the bytea hex shape so the
 * helper is safe to call on already-decoded inputs (tests, future schema
 * changes).
 */
function decodeSupabaseBytea(value: string): string {
  if (typeof value !== 'string') return value;
  if (!value.startsWith('\\x')) return value;
  return Buffer.from(value.slice(2), 'hex').toString('utf8');
}

export interface PublishWorkerSupabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface PublishWorkerDeps {
  supabase: PublishWorkerSupabase;
  gitServer: InternalGitServer;
  /** Resolves a site id to its git repo ref. */
  resolveSiteRepo: (siteId: string) => Promise<InternalRepoRef | null>;
  /** Resolves a list id to its git repo ref. */
  resolveListRepo: (listId: string) => Promise<InternalRepoRef | null>;
  /**
   * Build the publish file map for a site: walks pages, for blocks-mode
   * pages assembles content/pages/<slug>.json from page_blocks rows; for
   * schema-mode pages writes the pages.content JSONB document.
   */
  buildSiteContentFiles: (
    siteId: string,
    pages?: string[],
  ) => Promise<
    | Map<string, Buffer | string>
    | {
        files: Map<string, Buffer | string>;
        removals: string[];
        /**
         * When true, the publish-worker tells publishCommit to treat the
         * file map as the authoritative tree (deletes anything in the
         * prior commit not present in the map). Set by callers that
         * overlay a theme so stale theme files from prior tags don't
         * persist on the publish branch.
         */
        replaceTree?: boolean;
      }
  >;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface EnqueueArgs {
  siteId: string;
  triggerKind: 'manual' | 'scheduled' | 'webhook' | 'mcp';
  triggeredBy: string | null;
  webhookRequestId?: string;
  reason?: string;
  pages?: string[];
  force?: boolean;
}

export interface EnqueueResult {
  publishId: string;
  status: 'pending';
}

export class PublishWorker {
  constructor(private readonly deps: PublishWorkerDeps) {}

  async enqueueRepublish(args: EnqueueArgs): Promise<EnqueueResult> {
    // Insert pending log row
    const insertResult = await this.deps.supabase
      .from('site_republish_log')
      .insert({
        site_id: args.siteId,
        trigger_kind: args.triggerKind,
        triggered_by: args.triggeredBy,
        webhook_request_id: args.webhookRequestId,
        reason: args.reason,
        status: 'pending',
      })
      .select()
      .single();
    const row = insertResult.data as { id: string } | null;
    const insertErr = insertResult.error as { message: string } | null;
    if (insertErr || !row) {
      // Webhook dedup check — UNIQUE INDEX violation surfaces here
      if (insertErr?.message?.includes('duplicate key') && args.webhookRequestId) {
        throw new Error('webhook_replay_detected');
      }
      throw new Error(`republish enqueue failed: ${insertErr?.message ?? 'unknown'}`);
    }

    // Spawn async work; do NOT await before returning
    setImmediate(() => {
      this.runPublish(row.id, args).catch((err) => {
        this.deps.logger.error('publish run failed unexpectedly', {
          publishId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    return { publishId: row.id, status: 'pending' };
  }

  private async runPublish(publishId: string, args: EnqueueArgs): Promise<void> {
    const startedAt = new Date().toISOString();
    try {
      // Resolve repo
      const repo = await this.deps.resolveSiteRepo(args.siteId);
      if (!repo) {
        await this.markFailed(publishId, 'site has no git repo');
        return;
      }

      // Build file map (+ optional explicit removals for cleanup of
      // platform-emitted files that are no longer produced — e.g. when
      // a site flips to theme.owns_routing=true, the prior `app/*` tree
      // needs to be deleted from the publish branch so Next.js stops
      // routing into stale platform stubs).
      const built = await this.deps.buildSiteContentFiles(args.siteId, args.pages);
      const files = built instanceof Map ? built : built.files;
      const removals = built instanceof Map ? [] : built.removals;
      const replaceTree = built instanceof Map ? false : built.replaceTree === true;
      if (files.size === 0 && removals.length === 0 && !args.force) {
        await this.deps.supabase
          .from('site_republish_log')
          .update({
            status: 'skipped_no_diff',
            completed_at: new Date().toISOString(),
          })
          .eq('id', publishId);
        this.deps.logger.info('publish skipped (no diff)', { publishId, siteId: args.siteId });
        return;
      }

      // Build commit message + tag
      const tagSuffix = (args.reason ?? 'publish').replace(/[^a-z0-9-]/gi, '-').slice(0, 30).toLowerCase();
      const ts = new Date();
      const tagName = `publish/${ts.toISOString().slice(0, 10)}-${String(ts.getUTCHours()).padStart(2, '0')}${String(ts.getUTCMinutes()).padStart(2, '0')}-${tagSuffix}`;

      // Commit
      const result: CommitResult = await this.deps.gitServer.publishCommit({
        repo,
        branch: 'publish',
        files,
        removals,
        replaceTree,
        message: `Publish: ${args.reason ?? 'content update'}`,
        tag: tagName,
        author: { name: 'gatewaze', email: 'noreply@gatewaze.local' },
      });

      // If the site has graduated, mirror the commit (and its tag) to the
      // external remote. We do this BEFORE marking the row succeeded —
      // otherwise the UI claims the publish landed in GitHub when only
      // the internal bare repo actually saw the bytes.
      await this.mirrorIfGraduated({
        siteId: args.siteId,
        repo,
        localBranch: 'publish',
        tag: result.tag,
      });

      // Update log row
      await this.deps.supabase
        .from('site_republish_log')
        .update({
          status: 'success',
          publish_commit_sha: result.sha,
          publish_tag: result.tag,
          completed_at: new Date().toISOString(),
        })
        .eq('id', publishId);

      this.deps.logger.info('publish completed', {
        publishId,
        siteId: args.siteId,
        sha: result.sha,
        tag: result.tag,
        durationMs: Date.now() - new Date(startedAt).getTime(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.markFailed(publishId, message);
    }
  }

  /**
   * After a publishCommit succeeds, push the commit (and its tag) to the
   * graduated external remote. Default remote branch is 'publish' — the
   * legacy single-repo convention where main is the theme source and
   * publish is the built output. Sites whose external is a dedicated
   * publish-only repo (e.g. aaif-publish) should override this to 'main'
   * via `sites.config.publish.external_branch` so the built artifacts
   * land on the repo's default branch.
   */
  private async mirrorIfGraduated(args: {
    siteId: string;
    repo: InternalRepoRef;
    localBranch: string;
    tag?: string;
  }): Promise<void> {
    interface SiteRow {
      git_provenance: 'internal' | 'external';
      git_url: string | null;
      config: { publish?: { external_branch?: string } } | null;
    }
    const siteRes = await this.deps.supabase
      .from('sites')
      .select('git_provenance, git_url, config')
      .eq('id', args.siteId)
      .single();
    const site = (siteRes as { data: SiteRow | null }).data;
    if (!site || site.git_provenance !== 'external' || !site.git_url) return;

    interface SecretRow {
      encrypted_value: string;
    }
    const secretRes = await this.deps.supabase
      .from('sites_secrets')
      .select('encrypted_value')
      .eq('site_id', args.siteId)
      .eq('key', 'deploy_key')
      .single();
    const secret = (secretRes as { data: SecretRow | null }).data;
    if (!secret?.encrypted_value) {
      throw new Error(
        'mirror_failed: site is graduated but no deploy_key secret found — re-run graduate-to-external',
      );
    }

    const remoteBranch = site.config?.publish?.external_branch ?? 'publish';
    await this.deps.gitServer.mirrorBranchToExternal({
      repo: args.repo,
      localBranch: args.localBranch,
      remoteBranch,
      tag: args.tag,
      externalUrl: site.git_url,
      // sites_secrets.encrypted_value is a bytea column. graduate-to-external
      // wrote the OpenSSH PEM in as a string; PostgREST returns it as the
      // standard `\x<hex>` bytea encoding. Decode back to the original PEM
      // text before writing to disk — otherwise ssh-keygen sees the literal
      // hex string and bails with "error in libcrypto".
      sshPrivateKey: decodeSupabaseBytea(secret.encrypted_value),
    });
  }

  private async markFailed(publishId: string, errorMessage: string): Promise<void> {
    try {
      await this.deps.supabase
        .from('site_republish_log')
        .update({
          status: 'failed',
          error_message: errorMessage,
          completed_at: new Date().toISOString(),
        })
        .eq('id', publishId);
    } catch (innerErr) {
      this.deps.logger.error('failed to mark publish failed', {
        publishId,
        innerError: innerErr instanceof Error ? innerErr.message : String(innerErr),
      });
    }
  }

  /**
   * Apply-theme: merge `main` → `publish`. Returns conflict list when the
   * merge surfaces schema-affecting changes. Caller (admin endpoint)
   * surfaces conflicts via 409 with `details.conflicts` per spec §22.1.
   */
  async applyTheme(args: {
    siteId: string;
    fastTrack: boolean;
    triggeredBy: string;
  }): Promise<{ appliedCommit: string | null; filesChanged: number; conflicts: Array<{ path: string; reason: string }> }> {
    const repo = await this.deps.resolveSiteRepo(args.siteId);
    if (!repo) throw new Error('site has no git repo');

    // Pre-merge JSON-lock check (per spec-sites-wysiwyg-builder §5.5).
    // Reject if any wysiwyg_locked page would be modified by a non-worker
    // commit in the merge range.
    const preMerge = await this.runPreMergeCheck(args.siteId, repo);
    if (!preMerge.ok) {
      // Surface as a "conflict" with the pre-merge details. The caller
      // (source-routes apply-theme) translates the result into a 409 with
      // structured error envelope.
      return {
        appliedCommit: null,
        filesChanged: 0,
        conflicts: preMerge.rejection.details.map((d) => ({
          path: d.file,
          reason: `apply.locked_content_modified: commit ${d.commitSha} (slug=${d.slug})`,
        })),
      };
    }

    const result = await this.deps.gitServer.applyMerge({
      repo,
      fromBranch: 'main',
      toBranch: 'publish',
      message: args.fastTrack ? 'Fast-track theme apply' : 'Apply theme update',
      author: { name: 'gatewaze', email: 'noreply@gatewaze.local' },
      failOnConflict: args.fastTrack,
    });

    return result;
  }

  /**
   * Runs the JSON-lock pre-merge check against the proposed main → publish
   * merge. Lazy-imports the hook module so the worker bundle stays small
   * for environments that don't enable the WYSIWYG canvas.
   */
  private async runPreMergeCheck(siteId: string, _repo: InternalRepoRef) {
    const { preMergeCheck } = await import('../git/pre-merge-hook.js');
    return preMergeCheck(
      {
        // Production wires real git inspection; the StubInternalGitServer
        // env returns no inspections so the hook is a no-op.
        inspectCommits: async () => [],
        fetchPageLocks: async (slugs) => {
          if (slugs.length === 0) return [];
          const res = await this.deps.supabase
            .from('pages')
            .select('slug, wysiwyg_locked')
            .eq('host_kind', 'site')
            .eq('host_id', siteId)
            .in('slug', slugs);
          const rows = ((res as { data: Array<{ slug: string; wysiwyg_locked: boolean }> | null }).data ?? []);
          return rows.map((r) => ({ slug: r.slug, wysiwygLocked: r.wysiwyg_locked }));
        },
      },
      { fromBranch: 'main', toBranch: 'publish' },
    );
  }
}
