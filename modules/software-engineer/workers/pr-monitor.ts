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
import { getProject, getCodeRepos } from '../lib/credentials.js';
import { enqueuePhase } from '../lib/enqueue.js';
import { githubClient } from '../lib/github.js';
import { redactToken } from '../lib/git.js';
import { listRunPrs, upsertRunPr, recordPhaseStart, recordPhaseEnd, writeEvent } from '../lib/run-state.js';
import { dispatchProject, dispatchAll } from '../lib/dispatch.js';
import { isTrustedFeedbackAuthor } from '../lib/feedback-authz.js';
import { approveSpec, approveRunReviewLearnings } from '../lib/memory.js';
import { syncMemoryToRepo } from '../lib/memory-git.js';
import { summarizeChecks } from '../lib/pr-status.js';
import { classifyDeterministic } from '../lib/ci-classify.js';
import { InProcessRunner } from '../lib/agent-session.js';
import { resolvePhaseModel } from '../lib/model-select.js';
import { createOrSupersedeDecision } from '../lib/decisions.js';

const CHECK_FAILURE_CONCLUSIONS = ['failure', 'timed_out', 'cancelled', 'action_required'];

/**
 * Classify a red PR's failing checks BEFORE spending a bounded CI-fix pass (issue #54). Cheap
 * deterministic signals first (base-branch comparison, job step/log infra patterns) — free, no model
 * call. Only checks that survive both fall through to one no-tools model turn. Fail-SAFE: any
 * exception here returns 'addressable' (the pre-#54 behaviour), never 'external' — a broken
 * classifier must not be the reason a run starves in `watching` forever.
 */
async function classifyCiFailure(supabase, ctx, gh, project, run, failingChecks) {
  const FAIL_SAFE = { verdict: 'addressable', reasons: [], addressableSummary: null };
  if (!failingChecks.length) return { verdict: 'external', reasons: [], addressableSummary: null };
  try {
    // Resolve each failing check's Actions job (name match on the check's commit's workflow runs).
    const jobsBySha = new Map();
    async function jobsForSha(owner, name, sha) {
      const key = `${owner}/${name}@${sha}`;
      if (jobsBySha.has(key)) return jobsBySha.get(key);
      const jobs = [];
      try {
        const runsRes = await gh.listWorkflowRunsForCommit(owner, name, sha);
        for (const wr of runsRes?.workflow_runs ?? []) {
          const jobsRes = await gh.listWorkflowRunJobs(owner, name, wr.id).catch(() => null);
          for (const job of jobsRes?.jobs ?? []) jobs.push(job);
        }
      } catch { /* no deterministic job signal available — falls through to ambiguous */ }
      jobsBySha.set(key, jobs);
      return jobs;
    }

    const resolved = [];
    for (const c of failingChecks) {
      const jobs = await jobsForSha(c.repoOwner, c.repoName, c.sha);
      const match = jobs.find((j) => j.name === c.name) ?? null;
      resolved.push({
        name: c.name, repoOwner: c.repoOwner, repoName: c.repoName,
        jobId: match?.id ?? null,
        job: match ? { name: match.name, steps: match.steps ?? [], conclusion: match.conclusion ?? null } : null,
      });
    }

    // Base-branch red check names, once per distinct repo among the failing checks.
    const baseFailingCheckNames = new Set();
    const codeRepos = await getCodeRepos(supabase, run.project_id).catch(() => []);
    const seenRepos = new Set();
    for (const c of failingChecks) {
      const key = `${c.repoOwner}/${c.repoName}`;
      if (seenRepos.has(key)) continue;
      seenRepos.add(key);
      try {
        const repoCfg = codeRepos.find((r) => r.repoOwner === c.repoOwner && r.repoName === c.repoName);
        const base = repoCfg?.baseBranch || (await gh.defaultBranch(c.repoOwner, c.repoName).catch(() => null));
        if (!base) continue;
        const headSha = await gh.getBranchHeadSha(c.repoOwner, c.repoName, base);
        if (!headSha) continue;
        const baseChecks = await gh.listCheckRuns(c.repoOwner, c.repoName, headSha).catch(() => null);
        for (const bc of baseChecks?.check_runs ?? []) {
          if (bc?.status === 'completed' && CHECK_FAILURE_CONCLUSIONS.includes(String(bc?.conclusion))) {
            baseFailingCheckNames.add(bc.name);
          }
        }
      } catch { /* best-effort — a repo's base-branch comparison failing just leaves it ambiguous */ }
    }

    const det1 = classifyDeterministic({ failingChecks: resolved, baseFailingCheckNames });
    if (det1.verdict !== 'ambiguous') return { verdict: det1.verdict, reasons: det1.reasons, addressableSummary: null };

    // Fetch log tails for only the still-ambiguous checks, then re-run the (still free) deterministic
    // pass with logs attached — an infra log pattern can resolve a check without a model call.
    const ambiguous1 = new Set(det1.ambiguousChecks);
    const withLogs = [];
    for (const c of resolved) {
      if (!ambiguous1.has(c.name)) continue;
      let logTail;
      if (c.jobId != null) {
        const raw = await gh.getJobLogTail(c.repoOwner, c.repoName, c.jobId, 8192).catch(() => '');
        logTail = redactToken(raw, project.githubToken);
      }
      withLogs.push({ ...c, job: c.job ? { ...c.job, logTail } : c.job, logTail });
    }
    const det2 = classifyDeterministic({ failingChecks: withLogs, baseFailingCheckNames: new Set() });
    const reasons = [...det1.reasons, ...det2.reasons];
    if (det2.verdict !== 'ambiguous') return { verdict: det2.verdict, reasons, addressableSummary: null };

    // Still ambiguous — one no-tools model turn over just the unresolved checks' logs.
    const stillAmbiguous = withLogs.filter((c) => det2.ambiguousChecks.includes(c.name));
    if (!project?.modelCred) return FAIL_SAFE; // no credential to run the classifier turn — fail open
    await recordPhaseStart(supabase, run, 'ci-classify');
    const prompt = [
      `You are classifying CI failures on a pull request BEFORE a fix pass is attempted.`,
      `For EACH check below, decide whether it looks ADDRESSABLE by a code change on this branch,`,
      `or EXTERNAL (an infrastructure incident, flaky runner, or an unrelated upstream failure that no`,
      `in-repo change could fix).`,
      ``,
      `Respond with ONLY one JSON object: {"verdicts":[{"check":"<name>","addressable":true|false,"reason":"<short reason>"}]}`,
      ``,
      ...stillAmbiguous.flatMap((c) => [
        `--- CHECK: ${c.name} (${c.repoOwner}/${c.repoName}) ---`,
        c.logTail ? c.logTail.slice(-4000) : '(no log tail available)',
      ]),
    ].join('\n');
    const { model } = resolvePhaseModel(project, run, 'ci-classify');
    const runner = new InProcessRunner();
    const result = await runner.runPhase({
      cwd: '/tmp', prompt, model,
      credential: { kind: project.modelCredKind, value: project.modelCred },
      noTools: true,
    });
    await recordPhaseEnd(supabase, run, 'ci-classify', result?.error ? 'failed' : 'passed', result?.error, {
      model, engine: 'claude', input: result?.tokensInput, output: result?.tokensOutput,
      cacheRead: result?.tokensCacheRead, cacheCreation: result?.tokensCacheCreation, cost: result?.costUSD,
    });
    if (result?.error) return FAIL_SAFE;
    const m = /\{[\s\S]*\}/.exec(result?.text ?? '');
    if (!m) return FAIL_SAFE;
    let parsed;
    try { parsed = JSON.parse(m[0]); } catch { return FAIL_SAFE; }
    const verdicts = Array.isArray(parsed?.verdicts) ? parsed.verdicts : null;
    if (!verdicts) return FAIL_SAFE;
    const addressableOnes = verdicts.filter((v) => v?.addressable === true);
    if (addressableOnes.length > 0) {
      const summaryLines = verdicts.map((v) => `"${v.check}": ${v.addressable ? 'addressable' : 'external'} — ${v.reason ?? ''}`);
      return { verdict: 'addressable', reasons, addressableSummary: [`CI TRIAGE (deterministic + model):`, ...reasons.map((r) => `- ${r}`), ...summaryLines.map((s) => `- ${s}`)].join('\n') };
    }
    return { verdict: 'external', reasons: [...reasons, ...verdicts.map((v) => `"${v.check}": ${v.reason ?? 'classified external by the model'}`)], addressableSummary: null };
  } catch {
    return FAIL_SAFE;
  }
}

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
    let anyFailingCi = false;   // any open PR whose checks have SETTLED red (→ candidate for a CI-fix pass)
    const failingChecks = [];  // raw failing check-runs across all open PRs, for classifyCiFailure
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
          // Only feedback from a TRUSTED author is actionable. Anyone with a
          // GitHub account can review/comment a public PR; treating that as a
          // trigger would feed unauthenticated text into the revise agent.
          for (const r of reviews ?? []) if (r.state === 'CHANGES_REQUESTED' && r.submitted_at && isTrustedFeedbackAuthor(r.user?.login, project, run)) latestActionable = Math.max(latestActionable, new Date(r.submitted_at).getTime());
          for (const c of inline ?? []) if (c.created_at && isTrustedFeedbackAuthor(c.user?.login, project, run)) latestActionable = Math.max(latestActionable, new Date(c.created_at).getTime());
          // CI health — settled-red counts (still-running does not, to avoid churn).
          if (pr.head?.sha) {
            const checkRunsResult = await gh.listCheckRuns(p.repo_owner, p.repo_name, pr.head.sha).catch(() => null);
            const checks = summarizeChecks(checkRunsResult?.check_runs);
            if (checks.failing > 0 && checks.pending === 0) {
              anyFailingCi = true;
              for (const c of checkRunsResult?.check_runs ?? []) {
                if (c?.status === 'completed' && CHECK_FAILURE_CONCLUSIONS.includes(String(c?.conclusion))) {
                  failingChecks.push({ repoOwner: p.repo_owner, repoName: p.repo_name, name: c.name, sha: pr.head.sha });
                }
              }
            }
          }
        }
      } catch { allMerged = false; }
    }

    // External PRs (Connect) have no triggering issue — skip all issue-label / spec bookkeeping for
    // them; only the PR-state reconciliation + revise-on-feedback applies.
    const managesIssue = run.kind !== 'external_pr' && !!run.issue_number;
    // §1a terminal rules.
    if (allMerged) {
      if (managesIssue) {
        try { await gh.setStatusLabel(run.repo_owner, run.repo_name, run.issue_number, null); } catch { /* */ }
        try { await gh.closeIssue(run.repo_owner, run.repo_name, run.issue_number); } catch { /* */ }
        try { await gh.postComment(run.repo_owner, run.repo_name, run.issue_number, 'All PRs merged — done. ✅'); } catch { /* */ }
        // A human merging the PR IS the human judgment on this run's work — auto-promote its
        // pending spec into recallable memory (specs/issue-<n>). Runs that never merge leave
        // their spec pending for the manual review panel. Best-effort. (No spec for external PRs.)
        try { await approveSpec(supabase, run.project_id, project.name, run.issue_number); } catch { /* */ }
      }
      // Merge = the human's validation → promote this run's pending review-learnings (distilled from
      // its trusted review feedback) to the recallable review-kb/. Fires for issue AND external PRs.
      try { await approveRunReviewLearnings(supabase, run.project_id, project.name, run.id); } catch { /* */ }
      // Memory changed (spec and/or review-KB) → git-sync the project's memory repo (non-blocking).
      void syncMemoryToRepo(supabase, run.project_id, ctx?.logger).catch(() => {});
      await supabase.from('se_runs').update({ ...patch, status: 'merged', pr_state: 'merged', pr_url: firstUrl, archived_at: nowISO() }).eq('id', run.id);
      await dispatchProject(supabase, ctx, run.project_id);
      return { runId: run.id, action: 'merged' };
    }
    if (anyClosedUnmerged) {
      if (managesIssue) { try { await gh.setStatusLabel(run.repo_owner, run.repo_name, run.issue_number, 'agent:blocked'); } catch { /* */ } }
      await supabase.from('se_runs').update({ ...patch, status: 'blocked', pr_state: 'changes_requested', pr_url: firstUrl, error: 'a PR was closed unmerged — partial; needs a human decision' }).eq('id', run.id);
      try {
        await createOrSupersedeDecision(supabase, {
          runId: run.id, projectId: run.project_id, siteId: run.site_id, phase: run.current_phase,
          question: 'The pull request was closed unmerged, partway through. What should change?',
          kind: 'text', context: firstUrl,
        });
      } catch { /* best-effort — the Overview panel falls back to classifyDecision() if this row is missing */ }
      return { runId: run.id, action: 'blocked-partial' };
    }

    const seen = run.pr_seen_at ? new Date(run.pr_seen_at).getTime() : 0;
    if (latestActionable > seen) {
      await supabase.from('se_runs').update({ ...patch, status: 'changes_requested', pr_state: 'changes_requested', current_phase: 'revise', pr_seen_at: new Date(latestActionable).toISOString(), pr_url: firstUrl }).eq('id', run.id);
      await enqueuePhase(ctx, run.id, 'revise');
      return { runId: run.id, action: 'revise' };
    }

    // No new review feedback, but CI is settled-red → run a BOUNDED CI-fix pass: revise clones the
    // branch, runs the repo's checks, fixes what it can, and pushes. Capped by ci_fix_attempts so an
    // unfixable failure can't loop forever — after the cap a human takes over. (A fix that lands green
    // stops it naturally; each push that flips CI green removes the trigger.)
    // NEVER for external PRs (Connect): that branch is attacker-authored code and its CI result is
    // fully controlled by the untrusted PR author — letting a red check auto-invoke a Bash-capable
    // agent over their code (with the project token in-env, push access to their branch) would be an
    // unauthenticated code-execution trigger. A human drives any fix on external PRs. (Same kind-gate
    // as auto-merge below.)
    const CI_FIX_CAP = 3;
    if (run.kind !== 'external_pr' && anyFailingCi && (run.ci_fix_attempts ?? 0) < CI_FIX_CAP) {
      // Classify BEFORE spending a fix pass (issue #54): an infra incident or a repo-wide upstream
      // break (e.g. a new advisory failing an audit gate) burns a fix-pass attempt and model spend for
      // nothing no in-repo change can fix it. Cheap deterministic signals first; a model read only for
      // whatever's still ambiguous after that.
      const classification = await classifyCiFailure(supabase, ctx, gh, project, run, failingChecks);
      if (classification.verdict === 'external') {
        const note = `CI failure classified external: ${classification.reasons.join('; ') || 'no addressable signal found'} — waiting instead of spending a fix pass`;
        try {
          await writeEvent(supabase, run, 'pr-monitor', 0, 'status', {
            event: 'ci_classify', verdict: 'external', reasons: classification.reasons,
            checks: failingChecks.map((c) => c.name),
          });
        } catch { /* best-effort audit record */ }
        await supabase.from('se_runs').update({ ...patch, status: 'watching', pr_state: 'open', pr_url: firstUrl, error: note }).eq('id', run.id);
        return { runId: run.id, action: 'ci-external-skip' };
      }
      // Escalation ladder: the first CI-fix ran on the mapped model and CI is still red — latch the
      // run onto the project's escalation model (when configured) for the remaining code phases.
      const escalate = (run.ci_fix_attempts ?? 0) >= 1 && !run.model_escalated && !!project.escalationModel;
      await supabase.from('se_runs').update({ ...patch, status: 'changes_requested', pr_state: 'open', current_phase: 'revise', ci_fix_attempts: (run.ci_fix_attempts ?? 0) + 1, ...(escalate ? { model_escalated: true } : {}), pr_url: firstUrl }).eq('id', run.id);
      await enqueuePhase(ctx, run.id, 'revise', { reason: 'ci', classification: classification.addressableSummary ?? undefined });
      return { runId: run.id, action: 'ci-fix' };
    }

    // Still open, no new changes → watching; re-assert the single status label (§1a drift-correct).
    if (managesIssue) { try { await gh.setStatusLabel(run.repo_owner, run.repo_name, run.issue_number, 'agent:in-review'); } catch { /* */ } }
    await supabase.from('se_runs').update({ ...patch, status: 'watching', pr_state: 'open', pr_url: firstUrl }).eq('id', run.id);
    // Auto-merge safe changes without human review when the project allows it (merge.ts only merges
    // PRs GitHub reports mergeable_state=clean; idempotent, so re-enqueuing each tick is fine).
    // NEVER for external PRs (Connect) — the platform watches + revises them but a human always merges.
    if (run.kind !== 'external_pr' && project.autonomyMode === 'auto_merge_safe' && run.blast_radius === 'safe') {
      await ctx?.enqueueJob?.('se', 'software-engineer:merge', { runId: run.id });
    }
    return { runId: run.id, action: 'watch' };
  } catch (e) {
    await supabase.from('se_runs').update({ ...patch, error: redactToken(e?.message || String(e), token) }).eq('id', run.id);
    return { runId: run.id, error: true };
  }
}

// §7.6 note: the architecture-review gate no longer uses a PR, so pr-monitor does not watch it. A run
// parked at `awaiting_architecture` / `architecture_in_review` is driven only by explicit human actions
// in the admin (finalize, approve) and by workers/architecture-refine.ts — not by this reconciler.

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
  for (const run of runs) {
    results.push(await reconcile(supabase, ctx, run));
  }
  if (!single) { try { await dispatchAll(supabase, ctx); } catch { /* best-effort */ } }
  return { checked: runs.length, results };
}
