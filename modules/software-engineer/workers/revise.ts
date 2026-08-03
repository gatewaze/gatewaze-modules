// @ts-nocheck
/**
 * revise phase (§7/§8, multi-repo). Triggered by the pr-monitor when a reviewer requests changes on
 * any of the run's PRs. Gathers the feedback across all open PRs, clones the run branch of the
 * affected code repos, has the agent address every point, re-pushes each changed repo (the PRs
 * update in place), and returns the run to watching. Auto-address, unlimited rounds. A failed/empty
 * revise leaves the PRs open for a human rather than failing the run.
 */
import { createClient } from '@supabase/supabase-js';
import { getProject, getCodeRepos, resolveCommitIdentity } from '../lib/credentials.js';
import { githubClient } from '../lib/github.js';
import { makeMultiWorkspace, hasChanges, commitAndPush } from '../lib/worktree.js';
import { runAgentSession } from '../lib/phase-runner.js';
import { redactToken } from '../lib/git.js';
import { recordPhaseStart, recordPhaseEnd, listRunPrs } from '../lib/run-state.js';
import { isTrustedFeedbackAuthor } from '../lib/feedback-authz.js';
import { distillReviewLearnings } from '../lib/review-kb.js';

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

export default async function revise(job, ctx) {
  const supabase = sb(ctx);
  const { data: run } = await supabase.from('se_runs').select('*').eq('id', job?.data?.runId).maybeSingle();
  if (!run) return { skipped: 'no run' };
  if (run.status === 'cancelled' || run.archived_at) return { skipped: 'inactive' };
  const project = await getProject(supabase, run.project_id);
  if (!project?.intakeEnabled) return { skipped: 'intake disabled' };
  const token = project.githubToken;
  if (!token || !project.modelCred) return { skipped: 'no creds' };

  // 'ci' = pr-monitor triggered a bounded CI-fix pass (no new review feedback, CI settled-red).
  const reason = job?.data?.reason;
  const openPrs = (await listRunPrs(supabase, run.id)).filter((p) => p.pr_number && p.state === 'open');
  if (openPrs.length === 0) { await supabase.from('se_runs').update({ status: 'watching', current_phase: 'watch' }).eq('id', run.id); return { skipped: 'no open prs' }; }

  await recordPhaseStart(supabase, run, 'revise');
  const gh = githubClient(token);
  let ws;
  try {
    // Gather feedback across all open PRs (per repo).
    const feedbackByRepo = {};
    for (const p of openPrs) {
      const [reviews, inline] = await Promise.all([
        gh.listReviews(p.repo_owner, p.repo_name, p.pr_number).catch(() => []),
        gh.listReviewComments(p.repo_owner, p.repo_name, p.pr_number).catch(() => []),
      ]);
      const lines = [];
      // Only fold in feedback from a TRUSTED author (allow-listed labeller or the
      // run initiator). This text goes verbatim into a Bash-capable agent's
      // prompt and drives a push, so untrusted PR reviews/comments must not reach
      // it — on a public repo anyone can submit them.
      for (const r of reviews ?? []) if (['CHANGES_REQUESTED', 'COMMENTED'].includes(r.state) && (r.body ?? '').trim() && isTrustedFeedbackAuthor(r.user?.login, project, run)) lines.push(`- (${r.state}) @${r.user?.login ?? '?'}: ${r.body.trim()}`);
      for (const c of inline ?? []) if ((c.body ?? '').trim() && isTrustedFeedbackAuthor(c.user?.login, project, run)) lines.push(`- ${c.path}:${c.line ?? c.original_line ?? '?'} — ${c.body.trim()}`);
      if (lines.length) feedbackByRepo[p.repo_name] = lines.join('\n');
    }
    const feedback = Object.entries(feedbackByRepo).map(([repo, f]) => `### ${repo}\n${f}`).join('\n\n').slice(0, 12000);
    // No trusted review feedback normally means nothing to do — EXCEPT a CI-fix pass, where the
    // trigger is failing CI, not a comment. In ci mode we proceed with a CI-repair prompt instead.
    const ciMode = reason === 'ci' && !feedback.trim();
    if (!feedback.trim() && !ciMode) {
      await recordPhaseEnd(supabase, run, 'revise', 'skipped', 'no actionable feedback');
      await supabase.from('se_runs').update({ status: 'watching', current_phase: 'watch' }).eq('id', run.id);
      return { skipped: 'no feedback' };
    }

    // Clone the affected repos' RUN BRANCH (writable), so pushes update the existing PRs.
    const affected = new Set(openPrs.map((p) => `${p.repo_owner}/${p.repo_name}`));
    const codeRepos = (await getCodeRepos(supabase, run.project_id))
      .filter((r) => affected.has(`${r.repoOwner}/${r.repoName}`))
      .map((r) => ({ ...r, writeMode: 'writable' }));
    const commitId = await resolveCommitIdentity(supabase, project, token);
    ws = await makeMultiWorkspace(codeRepos, token, run.branch_name, commitId, true);

    const prompt = ciMode
      ? [
          `The CI checks on your open pull request(s)${run.issue_number ? ` for issue #${run.issue_number}` : ''} are FAILING.`,
          `Reproduce and fix them by editing the code in the relevant WRITABLE repo(s) in your workspace.`,
          `Run the repo's own checks (typecheck, lint, tests, security review) exactly as its CLAUDE.md`,
          `and .claude rules describe, find why they fail, and fix the root cause — do not disable, skip,`,
          `or weaken a check to make it pass. If a failure is genuinely unrelated to this branch's changes`,
          `and cannot be fixed here, make no change. Do NOT push, merge, or open PRs — the system does that.`,
        ].join('\n')
      : [
          `A reviewer left feedback on your open pull request(s)${run.issue_number ? ` for issue #${run.issue_number}` : ''}. Address`,
          `EVERY point below by editing the code in the relevant WRITABLE repo(s) in your workspace. Follow`,
          `each repo's CLAUDE.md/.claude rules. Do NOT push, merge, or open PRs — the system handles that.`,
          ``, `--- REVIEW FEEDBACK (per repo) ---`, feedback, `--- END FEEDBACK ---`,
        ].join('\n');
    const result = await runAgentSession(supabase, ctx, run, project, 'revise', {
      cwd: ws.root, prompt, repos: ws.repos, allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
      systemAppend: 'Address the review feedback per each repo\'s rules. Never use --no-verify or --force.',
    });
    if (result.error) {
      const msg = redactToken(result.error, token);
      await recordPhaseEnd(supabase, run, 'revise', 'failed', msg);
      await supabase.from('se_runs').update({ status: 'watching', current_phase: 'watch', error: msg }).eq('id', run.id);
      return { failed: msg };
    }

    let pushed = 0;
    for (const r of ws.repos.filter((x) => x.writable)) {
      if (!(await hasChanges(r.dir))) continue;
      const subject = ciMode
        ? `fix(ci): repair failing checks${run.issue_number ? ` on #${run.issue_number}` : ''}`
        : `fix: address review feedback${run.issue_number ? ` on #${run.issue_number}` : ''}`;
      try { await commitAndPush(r.dir, run.branch_name, subject); pushed++; }
      catch { /* leave that PR as-is */ }
    }
    const round = (run.revise_count ?? 0) + 1;
    await recordPhaseEnd(supabase, run, 'revise', pushed ? 'passed' : 'skipped', pushed ? `addressed feedback (round ${round}, ${pushed} repo(s))` : 'no code change produced', { model: project.model, input: result.tokensInput, output: result.tokensOutput });
    // If revise pushed new code, the blast_radius computed back in `implement`
    // no longer describes what's on the branch. Downgrade to 'needs_human' so
    // pr-monitor's auto-merge (which gates on blast_radius === 'safe') can't
    // merge the revised, unclassified diff without a human — the feedback author
    // is already engaged and can approve/merge deliberately.
    await supabase.from('se_runs').update({
      status: 'watching', current_phase: 'watch', revise_count: round, pr_state: 'open',
      ...(pushed ? { blast_radius: 'needs_human' } : {}),
    }).eq('id', run.id);
    const comment = ciMode
      ? (pushed ? `Pushed changes to repair failing CI (${pushed} repo(s)).` : 'Investigated the failing CI; no code change was produced.')
      : (pushed ? `Pushed changes addressing the latest review feedback (${pushed} repo(s)).` : 'Reviewed the latest feedback; no code change was needed.');
    try { await gh.postComment(run.repo_owner, run.repo_name, run.issue_number ?? run.pr_number, comment); } catch { /* best-effort */ }
    // Fold this round's TRUSTED feedback into the review-learnings KB (pending until the PR merges).
    try { await distillReviewLearnings(supabase, project, run, feedback, ctx?.logger); } catch { /* best-effort, never blocks revise */ }
    return { ok: true, round, pushed };
  } catch (e) {
    const msg = redactToken(e?.message || String(e), token);
    await recordPhaseEnd(supabase, run, 'revise', 'failed', msg);
    await supabase.from('se_runs').update({ status: 'watching', current_phase: 'watch', error: msg }).eq('id', run.id);
    return { failed: msg };
  } finally {
    try { await ws?.cleanup?.(); } catch { /* ignore */ }
  }
}
