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
  buildSiteContentFiles: (siteId: string, pages?: string[]) => Promise<Map<string, Buffer | string>>;
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

      // Build file map
      const files = await this.deps.buildSiteContentFiles(args.siteId, args.pages);
      if (files.size === 0 && !args.force) {
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
        message: `Publish: ${args.reason ?? 'content update'}`,
        tag: tagName,
        author: { name: 'gatewaze', email: 'noreply@gatewaze.local' },
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

    const result = await this.deps.gitServer.applyMerge({
      repo,
      fromBranch: 'main',
      toBranch: 'publish',
      message: args.fastTrack ? 'Fast-track theme apply' : 'Apply theme update',
      author: { name: 'gatewaze', email: 'noreply@gatewaze.local' },
      failOnConflict: args.fastTrack, // fast-track rejects on any conflict per spec §6.2
    });

    return result;
  }
}
