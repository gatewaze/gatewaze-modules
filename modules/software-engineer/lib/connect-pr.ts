// @ts-nocheck
/**
 * Connect an EXISTING external PR (opened outside Gatewaze) to a WATCHING run — the shared core
 * behind BOTH intake surfaces:
 *   - the admin route `POST /prs/connect` (api/admin-routes.ts, user-JWT + is_admin gated), and
 *   - the GitHub webhook's `agent:adopt` PR-label intake (api/webhook-routes.ts, HMAC + applier-trust
 *     gated) — so a locally-developed PR can be handed off from the CLI without admin credentials.
 *
 * The created run is kind='external_pr': the pr-monitor reconciler watches it and auto-revises on
 * TRUSTED review feedback, but skips issue bookkeeping, never runs the CI-fix pass, and never
 * auto-merges (workers/pr-monitor.ts kind gates). blast_radius is pinned 'needs_human' as belt +
 * braces with those gates.
 *
 * Every validation lives HERE so neither caller can drift: repo must be one of the project's
 * CONNECTED code repos, the project's intake kill switch must be on, the PR must be open with a
 * refname-safe head branch, and a PR already watched by an active run dedupes to that run.
 */
import { getCodeRepos } from './credentials.js';
import { githubClient } from './github.js';
import { upsertRunPr } from './run-state.js';

/** PR label that hands an open PR on a connected code repo to the pr-monitor (webhook intake). */
export const ADOPT_LABEL = 'agent:adopt';

const sanitizeTitle = (v: unknown) =>
  v == null ? null : String(v).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200) || null;

export type ConnectPrResult =
  | { ok: true; runId: string; existing?: boolean }
  | { ok: false; code: 'no_token' | 'intake_disabled' | 'repo_not_connected' | 'pr_not_open' | 'no_branch' | 'bad_branch' | 'insert_failed' | 'connect_failed'; message: string };

/**
 * Core connect logic. `project` is the already-loaded ProjectSettings (lib/credentials.ts) the
 * caller resolved + authorized; `labeller` records who initiated the adoption (an admin user id on
 * the route, the GitHub applier login on the webhook) — it also becomes the run's trusted-feedback
 * identity (lib/feedback-authz.ts), so callers MUST only pass an applier they have authorized.
 */
export async function connectExternalPr(supabase, deps, args): Promise<ConnectPrResult> {
  const { enqueueJob, logger } = deps ?? {};
  const { project, owner, name, number, labeller } = args;
  if (!project?.githubToken) return { ok: false, code: 'no_token', message: 'project has no GitHub token' };
  if (!project.intakeEnabled) return { ok: false, code: 'intake_disabled', message: 'project is disabled (kill switch)' };
  const codeRepos = await getCodeRepos(supabase, project.projectId);
  if (!new Set(codeRepos.map((r) => `${r.repoOwner}/${r.repoName}`.toLowerCase())).has(`${owner}/${name}`.toLowerCase())) {
    return { ok: false, code: 'repo_not_connected', message: 'repo is not connected to this project' };
  }
  // Idempotent: reuse an active run already watching this PR (also dedupes label re-applies and
  // at-least-once webhook deliveries).
  const { data: existingPr } = await supabase.from('se_run_prs')
    .select('run_id, se_runs(id, status, archived_at)')
    .eq('repo_owner', owner).eq('repo_name', name).eq('pr_number', number).eq('state', 'open').maybeSingle();
  const existingRun = existingPr && (Array.isArray(existingPr.se_runs) ? existingPr.se_runs[0] : existingPr.se_runs);
  if (existingRun && !existingRun.archived_at && existingRun.status !== 'cancelled') {
    return { ok: true, runId: existingRun.id, existing: true };
  }

  const gh = githubClient(project.githubToken);
  try {
    const pull = await gh.getPullRequest(owner, name, number);
    if (!pull || pull.state !== 'open') return { ok: false, code: 'pr_not_open', message: 'PR is not open' };
    const branch = String(pull.head?.ref ?? '');
    if (!branch) return { ok: false, code: 'no_branch', message: 'could not resolve the PR head branch' };
    // SECURITY: this ref (attacker-controlled on an external PR) becomes run.branch_name and is
    // later passed as a bare `git push origin <branch>` refspec. A name like `--mirror` / `--delete`
    // would be read as a git OPTION, not a ref — arbitrary remote-ref destruction with the project
    // PAT. Reject a leading '-' and anything outside a safe refname subset before storing it.
    if (branch.startsWith('-') || branch.includes('..') || branch.endsWith('.lock') || !/^[A-Za-z0-9._/-]+$/.test(branch)) {
      return { ok: false, code: 'bad_branch', message: 'unsupported PR branch name' };
    }
    const { data: run, error } = await supabase.from('se_runs').insert({
      site_id: project.siteId, project_id: project.projectId, kind: 'external_pr',
      instance_id: process.env.SE_INSTANCE_ID || 'default',
      repo_owner: owner, repo_name: name, issue_number: null, title: sanitizeTitle(pull.title) ?? `PR #${number}`,
      labeller: labeller ?? null, status: 'watching', current_phase: 'watch',
      branch_name: branch, pr_number: number, pr_url: pull.html_url, pr_state: 'open',
      blast_radius: 'needs_human',   // external PRs never auto-merge — belt + braces with the pr-monitor kind gate
    }).select('id').single();
    if (error || !run) {
      logger?.warn?.('se: connect PR failed', { project: project.projectId, error: String(error?.message ?? error) });
      return { ok: false, code: 'insert_failed', message: 'connect failed' };
    }
    await upsertRunPr(supabase, { id: run.id, site_id: project.siteId }, owner, name, {
      branch, pr_number: number, pr_url: pull.html_url, state: 'open',
    });
    // Reconcile immediately (start watching now); the pr-monitor cron then keeps it fresh.
    try { await enqueueJob?.('se', 'software-engineer:pr-monitor', { runId: run.id }, { jobId: `se-prmon-connect-${run.id}` }); }
    catch (e) { logger?.warn?.('se: connect enqueue pr-monitor failed', { error: String(e) }); }
    return { ok: true, runId: run.id };
  } catch (e) {
    logger?.warn?.('se: connect PR failed', { project: project.projectId, error: String((e as Error)?.message ?? e) });
    return { ok: false, code: 'connect_failed', message: 'connect failed' };
  }
}
