// @ts-nocheck
/**
 * PR monitor (§8 + §1a). Reconciles the SET of a run's PRs (se_run_prs) against GitHub, and keeps the
 * issue's status label current (single-valued, re-asserted). Terminal rules (§1a):
 *   - ALL PRs merged            → Done: close the issue, archive the run, free a slot.
 *   - ANY PR closed_unmerged    → agent:blocked, issue stays OPEN for a human (partial).
 *   - new CHANGES_REQUESTED     → enqueue revise (auto-address).
 *   - otherwise                 → watching, re-assert agent:in-review.
 * Runs on a cron (scan all) or for a single run (webhook nudge).
 */
import { createClient } from '@supabase/supabase-js';
import { getProject } from '../lib/credentials.js';
import { githubClient } from '../lib/github.js';
import { redactToken } from '../lib/git.js';
import { listRunPrs, upsertRunPr } from '../lib/run-state.js';
import { dispatchProject, dispatchAll } from '../lib/dispatch.js';

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });
const nowISO = () => new Date().toISOString();

async function reconcile(supabase, ctx, run) {
  if (run.archived_at || run.status === 'cancelled') return { runId: run.id, skipped: 'inactive' };
  const project = await getProject(supabase, run.project_id);
  const token = project?.githubToken;
  if (!token) return { runId: run.id, skipped: 'no token' };
  const gh = githubClient(token);
  const patch = { pr_checked_at: nowISO() };
  try {
    const prs = (await listRunPrs(supabase, run.id)).filter((p) => p.pr_number);
    if (prs.length === 0) { await supabase.from('se_runs').update(patch).eq('id', run.id); return { runId: run.id, skipped: 'no prs' }; }

    // Refresh each PR's terminal/open state + collect reviews on open PRs.
    let allMerged = true, anyClosedUnmerged = false, firstUrl = null;
    let latestActionable = 0;
    for (const p of prs) {
      firstUrl = firstUrl || p.pr_url;
      try {
        const pr = await gh.getPullRequest(p.repo_owner, p.repo_name, p.pr_number);
        let state = 'open';
        if (pr.merged || pr.merged_at) state = 'merged';
        else if (pr.state === 'closed') state = 'closed_unmerged';
        if (state !== p.state) await upsertRunPr(supabase, run, p.repo_owner, p.repo_name, { state });
        if (state !== 'merged') allMerged = false;
        if (state === 'closed_unmerged') anyClosedUnmerged = true;
        if (state === 'open') {
          const [reviews, inline] = await Promise.all([
            gh.listReviews(p.repo_owner, p.repo_name, p.pr_number).catch(() => []),
            gh.listReviewComments(p.repo_owner, p.repo_name, p.pr_number).catch(() => []),
          ]);
          for (const r of reviews ?? []) if (r.state === 'CHANGES_REQUESTED' && r.submitted_at) latestActionable = Math.max(latestActionable, new Date(r.submitted_at).getTime());
          for (const c of inline ?? []) if (c.created_at) latestActionable = Math.max(latestActionable, new Date(c.created_at).getTime());
        }
      } catch { allMerged = false; }
    }

    // §1a terminal rules.
    if (allMerged) {
      try { await gh.setStatusLabel(run.repo_owner, run.repo_name, run.issue_number, null); } catch { /* */ }
      try { await gh.closeIssue(run.repo_owner, run.repo_name, run.issue_number); } catch { /* */ }
      try { await gh.postComment(run.repo_owner, run.repo_name, run.issue_number, 'All PRs merged — done. ✅'); } catch { /* */ }
      await supabase.from('se_runs').update({ ...patch, status: 'merged', pr_state: 'merged', pr_url: firstUrl, archived_at: nowISO() }).eq('id', run.id);
      await dispatchProject(supabase, ctx, run.project_id);
      return { runId: run.id, action: 'merged' };
    }
    if (anyClosedUnmerged) {
      try { await gh.setStatusLabel(run.repo_owner, run.repo_name, run.issue_number, 'agent:blocked'); } catch { /* */ }
      await supabase.from('se_runs').update({ ...patch, status: 'blocked', pr_state: 'changes_requested', pr_url: firstUrl, error: 'a PR was closed unmerged — partial; needs a human decision' }).eq('id', run.id);
      return { runId: run.id, action: 'blocked-partial' };
    }

    const seen = run.pr_seen_at ? new Date(run.pr_seen_at).getTime() : 0;
    if (latestActionable > seen) {
      await supabase.from('se_runs').update({ ...patch, status: 'changes_requested', pr_state: 'changes_requested', current_phase: 'revise', pr_seen_at: new Date(latestActionable).toISOString(), pr_url: firstUrl }).eq('id', run.id);
      await ctx?.enqueueJob?.('jobs', 'software-engineer:revise', { runId: run.id });
      return { runId: run.id, action: 'revise' };
    }

    // Still open, no new changes → watching; re-assert the single status label (§1a drift-correct).
    try { await gh.setStatusLabel(run.repo_owner, run.repo_name, run.issue_number, 'agent:in-review'); } catch { /* */ }
    await supabase.from('se_runs').update({ ...patch, status: 'watching', pr_state: 'open', pr_url: firstUrl }).eq('id', run.id);
    // Auto-merge safe changes without human review when the project allows it (merge.ts only merges
    // PRs GitHub reports mergeable_state=clean; idempotent, so re-enqueuing each tick is fine).
    if (project.autonomyMode === 'auto_merge_safe' && run.blast_radius === 'safe') {
      await ctx?.enqueueJob?.('jobs', 'software-engineer:merge', { runId: run.id });
    }
    return { runId: run.id, action: 'watch' };
  } catch (e) {
    await supabase.from('se_runs').update({ ...patch, error: redactToken(e?.message || String(e), token) }).eq('id', run.id);
    return { runId: run.id, error: true };
  }
}

export default async function prMonitor(job, ctx) {
  const supabase = sb(ctx);
  const single = job?.data?.runId;
  let runs;
  if (single) {
    const { data } = await supabase.from('se_runs').select('*').eq('id', single).maybeSingle();
    runs = data ? [data] : [];
  } else {
    const { data } = await supabase.from('se_runs').select('*').is('archived_at', null).in('status', ['pr_open', 'watching']);
    runs = data ?? [];
  }
  const results = [];
  for (const run of runs) results.push(await reconcile(supabase, ctx, run));
  if (!single) { try { await dispatchAll(supabase, ctx); } catch { /* best-effort */ } }
  return { checked: runs.length, results };
}
