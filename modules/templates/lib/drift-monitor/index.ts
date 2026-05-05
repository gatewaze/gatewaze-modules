/**
 * Drift monitor — periodic git source poller.
 *
 * Per spec-templates-module §6.5 and spec-module-git-update-monitoring.md.
 *
 * Wired into the platform's BullMQ scheduler via templates/index.ts:
 *   workers: [{ name: 'templates:check-source-updates', handler: '...' }]
 *
 * Every tick this function:
 *   1. Selects all `templates_sources WHERE kind='git' AND status='active'`
 *   2. For each source: clones/updates the cached repo, reads HEAD SHA
 *   3. UPDATEs the row with `last_checked_at`, `last_check_duration_ms`,
 *      `last_check_error`, and (if HEAD moved) `available_git_sha`
 *   4. If `auto_apply=true` AND the new state classifies as safe (no
 *      detached artifacts via dry-run), auto-applies; otherwise leaves
 *      `available_git_sha` set so the admin sees the drift in the Source
 *      tab and can apply manually.
 *
 * Realtime fan-out: the row UPDATE triggers Supabase Realtime which the
 * admin UI subscribes to (TemplateTabContent in newsletters/admin/pages/
 * detail.tsx). No extra plumbing needed beyond the standard Realtime
 * `postgres_changes` channel.
 */

import { createHash } from 'node:crypto';
import { parse } from '../parser/parse.js';
import { applySource } from '../sources/apply.js';
import {
  cloneOrUpdateGitSource,
  readHeadSha,
  walkSourceFiles,
} from '../sources/git.js';

// ---------------------------------------------------------------------------
// Narrow Supabase shape — works with both the service-role admin client and
// the API server's narrow query interface.
// ---------------------------------------------------------------------------

export interface DriftSupabaseClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

interface GitSourceRow {
  id: string;
  url: string;
  branch: string | null;
  manifest_path: string | null;
  installed_git_sha: string | null;
  available_git_sha: string | null;
  auto_apply: boolean;
  // token_secret_ref is the pointer; tests + worker glue resolve it to the
  // actual token via the platform's secrets store. The drift monitor itself
  // accepts the pre-resolved token via the `resolveToken` callback below.
  token_secret_ref: string | null;
}

export interface DriftMonitorDeps {
  supabase: DriftSupabaseClient;
  /**
   * Resolve a `token_secret_ref` pointer to the actual git PAT. Called
   * once per source per tick. Return null when no token is available
   * (public repo). Failures should return null + log; the source falls
   * back to anonymous clone (which fails gracefully for private repos).
   */
  resolveToken?: (ref: string | null) => Promise<string | null>;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface DriftMonitorResult {
  checked: number;
  drifted: number;
  autoApplied: number;
  errors: number;
  perSource: Array<{
    sourceId: string;
    status: 'unchanged' | 'drifted' | 'auto_applied' | 'error';
    headSha?: string;
    error?: string;
  }>;
}

// Sources are checked at most every N seconds — short-circuit when the
// last_checked_at is within this window. Default 60s; the worker schedule
// (see templates/index.ts) usually fires every 15 min so this is rarely
// hit, but it protects against accidentally hammering Nominatim/git when
// an operator manually re-enqueues the cron job.
const MIN_CHECK_INTERVAL_MS = 60 * 1000;

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// ---------------------------------------------------------------------------
// Main entrypoint — called by the cron worker
// ---------------------------------------------------------------------------

export async function checkAllGitSources(deps: DriftMonitorDeps): Promise<DriftMonitorResult> {
  const log = deps.logger ?? noopLogger;
  const result: DriftMonitorResult = {
    checked: 0,
    drifted: 0,
    autoApplied: 0,
    errors: 0,
    perSource: [],
  };

  // Pull the candidate sources. We deliberately filter by kind+status here
  // rather than rely on RLS — this is a server-side worker running with
  // the service-role key.
  const { data, error } = await deps.supabase
    .from('templates_sources')
    .select('id, url, branch, manifest_path, installed_git_sha, available_git_sha, auto_apply, token_secret_ref, last_checked_at')
    .eq('kind', 'git')
    .eq('status', 'active');

  if (error) {
    log.error('drift-monitor: failed to load sources', { error: error.message });
    return result;
  }

  const sources = (data ?? []) as Array<GitSourceRow & { last_checked_at: string | null }>;
  const now = Date.now();

  for (const source of sources) {
    if (!source.url) continue;

    // Throttle: skip sources we've checked recently
    if (source.last_checked_at) {
      const lastMs = Date.parse(source.last_checked_at);
      if (Number.isFinite(lastMs) && now - lastMs < MIN_CHECK_INTERVAL_MS) {
        continue;
      }
    }

    result.checked++;
    const startedAt = Date.now();

    try {
      const token = deps.resolveToken
        ? await deps.resolveToken(source.token_secret_ref)
        : null;

      // 1. Clone or fast-forward, read HEAD SHA
      const repoDir = cloneOrUpdateGitSource({
        url: source.url,
        branch: source.branch ?? undefined,
        token: token ?? undefined,
      });
      const headSha = readHeadSha(repoDir);
      const drifted = source.installed_git_sha !== headSha;
      const checkDurationMs = Date.now() - startedAt;

      // 2. Update the source row with the check result
      const baseUpdate: Record<string, unknown> = {
        last_checked_at: new Date().toISOString(),
        last_check_duration_ms: checkDurationMs,
        last_check_error: null,
      };
      if (drifted) baseUpdate['available_git_sha'] = headSha;

      // 3. Auto-apply path — only when the source opted in AND the change
      //    classifies as safe. "Safe" here = parse succeeds AND no
      //    artifacts marked 'detached' (i.e., nothing removed from the
      //    source that consumer instances might still reference).
      let autoAppliedSucceeded = false;
      if (drifted && source.auto_apply) {
        try {
          const files = walkSourceFiles(repoDir, source.manifest_path ?? undefined);
          const concatenated = files
            .map((f) => `<!-- file: ${f.relativePath} -->\n${f.content}`)
            .join('\n\n');
          const parsed = parse(concatenated, { sourcePath: `git:${source.url}#${headSha.slice(0, 8)}` });

          if (parsed.errors.length === 0) {
            // Dry-run first to classify the change
            const sha = createHash('sha256').update(concatenated).digest('hex');
            const dryRun = await applySource(deps.supabase, source.id, parsed, { sourceSha: sha, dryRun: true });
            const hasDetached = dryRun.artifacts.some((a) => a.action === 'detached');
            const dryRunHadErrors = dryRun.errors.length > 0;

            if (!hasDetached && !dryRunHadErrors) {
              const realApply = await applySource(deps.supabase, source.id, parsed, { sourceSha: sha, dryRun: false });
              if (realApply.errors.length === 0) {
                baseUpdate['installed_git_sha'] = headSha;
                baseUpdate['available_git_sha'] = null;
                autoAppliedSucceeded = true;
                result.autoApplied++;
                log.info('drift-monitor: auto-applied', {
                  sourceId: source.id,
                  headSha,
                  artifacts: realApply.artifacts.length,
                });
              } else {
                log.warn('drift-monitor: auto-apply failed at apply step', {
                  sourceId: source.id,
                  errors: realApply.errors,
                });
              }
            } else {
              log.info('drift-monitor: auto-apply skipped (unsafe drift)', {
                sourceId: source.id,
                hasDetached,
                dryRunErrors: dryRun.errors.length,
              });
            }
          } else {
            log.warn('drift-monitor: auto-apply skipped (parse errors)', {
              sourceId: source.id,
              errors: parsed.errors.length,
            });
          }
        } catch (autoApplyErr) {
          // Auto-apply failure isn't fatal — the drift is still recorded
          // so the admin can apply manually.
          const message = autoApplyErr instanceof Error ? autoApplyErr.message : String(autoApplyErr);
          log.warn('drift-monitor: auto-apply threw', { sourceId: source.id, error: message });
        }
      }

      await deps.supabase
        .from('templates_sources')
        .update(baseUpdate)
        .eq('id', source.id);

      if (autoAppliedSucceeded) {
        result.perSource.push({ sourceId: source.id, status: 'auto_applied', headSha });
      } else if (drifted) {
        result.drifted++;
        result.perSource.push({ sourceId: source.id, status: 'drifted', headSha });
      } else {
        result.perSource.push({ sourceId: source.id, status: 'unchanged', headSha });
      }
    } catch (err) {
      result.errors++;
      const message = err instanceof Error ? err.message : String(err);
      const checkDurationMs = Date.now() - startedAt;

      // Persist the error so the admin sees it in the Source tab
      await deps.supabase
        .from('templates_sources')
        .update({
          last_checked_at: new Date().toISOString(),
          last_check_duration_ms: checkDurationMs,
          last_check_error: message.slice(0, 500),
        })
        .eq('id', source.id);

      log.error('drift-monitor: source check failed', { sourceId: source.id, error: message });
      result.perSource.push({ sourceId: source.id, status: 'error', error: message });
    }
  }

  log.info('drift-monitor: tick complete', {
    checked: result.checked,
    drifted: result.drifted,
    autoApplied: result.autoApplied,
    errors: result.errors,
  });

  return result;
}
