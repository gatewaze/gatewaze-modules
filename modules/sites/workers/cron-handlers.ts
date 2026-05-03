// @ts-nocheck — depends on @supabase/supabase-js which requires workspace
// install. Excluded from strict tsconfig until install is wired.
/**
 * Cron handlers for the sites + newsletters modules.
 *
 * The platform's job runner dispatches by `data.kind`. Each handler:
 *   - Reads any necessary state from the DB
 *   - Performs the work (idempotent — safe to re-run on duplicate fires)
 *   - Updates lifecycle markers (e.g. snapshot_at)
 *   - Logs metrics
 *
 * Handlers throw on unrecoverable error; the platform retries per the
 * job queue's policy.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { InternalGitServer } from '../lib/git/internal-git-server.js';
import type { PublishWorker } from '../lib/publish-worker/publish-worker.js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface CronHandlerDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>;
  gitServer: InternalGitServer;
  publishWorker: PublishWorker;
  logger: PlatformLogger;
  /** Optional fetch override for the boilerplate poller (tests mock this). */
  fetch?: typeof globalThis.fetch;
}

// ===========================================================================
// sites:boilerplate-version-poll
// ===========================================================================

const BOILERPLATES = [
  'gatewaze/gatewaze-template-site',
  'gatewaze/gatewaze-template-newsletter',
];

export async function runBoilerplateVersionPoll(deps: CronHandlerDeps): Promise<{ checked: number; updated: number }> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  let updated = 0;

  for (const repo of BOILERPLATES) {
    try {
      const url = `https://api.github.com/repos/${repo}/releases/latest`;
      const resp = await fetchFn(url, {
        headers: { 'User-Agent': 'gatewaze-boilerplate-poller', Accept: 'application/vnd.github+json' },
      });
      if (!resp.ok) {
        deps.logger.warn('boilerplate poll non-200', { repo, status: resp.status });
        continue;
      }
      const json = (await resp.json()) as { tag_name?: string; body?: string };
      if (!json.tag_name) continue;

      const id = repo.split('/').pop()!;
      const existing = await deps.supabase
        .from('gatewaze_boilerplate_versions')
        .select('latest_tag')
        .eq('boilerplate_id', id)
        .single();

      if (existing.data && (existing.data as { latest_tag: string }).latest_tag === json.tag_name) {
        continue; // No change
      }

      await deps.supabase.from('gatewaze_boilerplate_versions').upsert({
        boilerplate_id: id,
        latest_tag: json.tag_name,
        release_notes_md: json.body ?? null,
        fetched_at: new Date().toISOString(),
      });
      updated++;
      deps.logger.info('boilerplate version updated', { repo, tag: json.tag_name });
    } catch (err) {
      deps.logger.warn('boilerplate poll failed', { repo, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { checked: BOILERPLATES.length, updated };
}

// ===========================================================================
// sites:scheduled-republish
// ===========================================================================

/**
 * Find sites with publish_schedule_cron set whose next-run has elapsed,
 * enqueue a republish for each.
 *
 * For v1 we use a coarse heuristic: fire at every minute boundary the
 * cron matches. The job runs every minute (per spec §6.7 + manifest).
 */
export async function runScheduledRepublish(deps: CronHandlerDeps): Promise<{ scheduled: number; enqueued: number }> {
  const result = await deps.supabase
    .from('sites')
    .select('id, slug, publish_schedule_cron')
    .not('publish_schedule_cron', 'is', null)
    .eq('status', 'active');

  const sites = (result.data as Array<{ id: string; slug: string; publish_schedule_cron: string }>) ?? [];
  let enqueued = 0;

  for (const site of sites) {
    if (!site.publish_schedule_cron) continue;
    if (!cronMatchesNow(site.publish_schedule_cron)) continue;

    try {
      await deps.publishWorker.enqueueRepublish({
        siteId: site.id,
        triggerKind: 'scheduled',
        triggeredBy: null,
        reason: `scheduled (${site.publish_schedule_cron})`,
      });
      enqueued++;
    } catch (err) {
      deps.logger.warn('scheduled republish enqueue failed', {
        siteId: site.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { scheduled: sites.length, enqueued };
}

// ===========================================================================
// sites:drift-watch
// ===========================================================================

/**
 * For each site, detect drift between main and publish.
 *
 * For internal git: compares local main vs publish HEAD via getHeadSha.
 *
 * For external git (BYO): runs `git fetch origin main` first to pick up
 * upstream changes pushed since the last poll, then compares fetched
 * main vs local publish. Failures (deploy key revoked, repo unreachable)
 * are logged + counted but don't fail the whole tick.
 */
export async function runDriftWatcher(deps: CronHandlerDeps): Promise<{ checked: number; drifted: number; fetchFailed: number }> {
  const result = await deps.supabase
    .from('sites')
    .select('id, slug, git_provenance, git_url')
    .eq('status', 'active');
  const sites = (result.data as Array<{ id: string; slug: string; git_provenance: string; git_url: string | null }>) ?? [];
  let drifted = 0;
  let fetchFailed = 0;

  for (const site of sites) {
    try {
      const repoResult = await deps.supabase
        .from('gatewaze_internal_repos')
        .select('host_kind, host_id, bare_path, default_branch')
        .eq('host_kind', 'site').eq('host_id', site.id).single();
      if (!repoResult.data) continue;

      const row = repoResult.data as { host_kind: string; host_id: string; bare_path: string; default_branch: string };
      const repo = {
        hostKind: 'site' as const,
        hostId: site.id,
        slug: site.slug,
        barePath: row.bare_path,
        defaultBranch: row.default_branch,
      };

      // For external-git sites, fetch upstream main first
      if (site.git_provenance === 'external' && site.git_url) {
        try {
          await fetchExternalMain(repo.barePath, site.id, deps);
        } catch (err) {
          fetchFailed++;
          deps.logger.warn('external git fetch failed', {
            siteId: site.id,
            gitUrl: site.git_url,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
      }

      const [mainSha, publishSha] = await Promise.all([
        deps.gitServer.getHeadSha(repo, 'main'),
        deps.gitServer.getHeadSha(repo, 'publish'),
      ]);
      if (mainSha && publishSha && mainSha !== publishSha) {
        drifted++;
        // Surface to admin: insert/update a drift row so the Source tab
        // can show "X commits ahead" without re-running getHeadSha.
        await deps.supabase.from('site_drift_state').upsert({
          site_id: site.id,
          main_sha: mainSha,
          publish_sha: publishSha,
          checked_at: new Date().toISOString(),
        }).eq('site_id', site.id);
      }
    } catch (err) {
      deps.logger.warn('drift check failed', { siteId: site.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  deps.logger.info('drift watch tick', { checked: sites.length, drifted, fetchFailed });
  return { checked: sites.length, drifted, fetchFailed };
}

/**
 * Fetch upstream main into the bare repo using the per-site deploy key.
 * Per spec §6.4 — external-git sites use SSH-based deploy key auth.
 */
async function fetchExternalMain(barePath: string, siteId: string, deps: CronHandlerDeps): Promise<void> {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  // Lookup the deploy key from sites_secrets
  const secretResult = await deps.supabase
    .from('sites_secrets')
    .select('encrypted_value')
    .eq('site_id', siteId).eq('key', 'deploy_key').single();
  const deployKey = (secretResult.data as { encrypted_value: string } | null)?.encrypted_value;
  if (!deployKey) {
    throw new Error('no deploy key configured for external git site');
  }

  const tmpDir = await mkdtemp(join(tmpdir(), 'gatewaze-fetch-'));
  const keyPath = join(tmpDir, 'id');
  try {
    await writeFile(keyPath, deployKey, { mode: 0o600 });
    const sshCommand = `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('git', ['--git-dir', barePath, 'fetch', 'origin', 'main'], {
        env: { ...process.env, GIT_SSH_COMMAND: sshCommand, GIT_TERMINAL_PROMPT: '0' },
      });
      let stderr = '';
      proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git fetch exit ${code}: ${stderr}`));
      });
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ===========================================================================
// sites:media-usage-reconcile
// ===========================================================================

/**
 * Walk all content tables, rebuild host_media.used_in from scratch.
 * Backstop for the transactional MediaReferenceTracker. Drift fires alert.
 */
export async function runMediaUsageReconcile(deps: CronHandlerDeps): Promise<{ scanned: number; drift: number }> {
  // Coarse v1 impl: just log a tick and zero the counter. Full impl walks
  // pages.content + page_blocks.content + page_block_bricks.content +
  // newsletters_edition_blocks.content per the JSON-key heuristic in
  // spec §18.4, then UPDATEs host_media.used_in.
  deps.logger.info('media usage reconcile tick (full impl pending)');
  return { scanned: 0, drift: 0 };
}

// ===========================================================================
// newsletter:edition-snapshot
// (delegates to lib/publish-branch/snapshot-job.ts in newsletters module)
// ===========================================================================

// (Wired from newsletters module — see modules/newsletters/workers/)

// ===========================================================================
// Cron expression matcher (5-field; minute-resolution)
// ===========================================================================

/**
 * Returns true if the cron expression matches the current minute.
 * Supports: *, N, N1,N2, N1-N2, *​/N. Standard 5 fields:
 *   minute hour day month weekday
 */
export function cronMatchesNow(cron: string, now: Date = new Date()): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const checks = [
    matchField(fields[0]!, now.getUTCMinutes(), 0, 59),
    matchField(fields[1]!, now.getUTCHours(), 0, 23),
    matchField(fields[2]!, now.getUTCDate(), 1, 31),
    matchField(fields[3]!, now.getUTCMonth() + 1, 1, 12),
    matchField(fields[4]!, now.getUTCDay(), 0, 6),
  ];
  return checks.every(Boolean);
}

function matchField(field: string, current: number, min: number, max: number): boolean {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[1]!, 10);
      if ((current - min) % step === 0) return true;
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      if (current >= start && current <= end) return true;
      continue;
    }
    if (parseInt(part, 10) === current) return true;
  }
  return false;
}
