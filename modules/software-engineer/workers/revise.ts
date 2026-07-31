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
      for (const r of reviews ?? []) if (['CHANGES_REQUESTED', 'COMMENTED'].includes(r.state) && (r.body ?? '').trim()) lines.push(`- (${r.state}) @${r.user?.login ?? '?'}: ${r.body.trim()}`);
      for (const c of inline ?? []) if ((c.body ?? '').trim()) lines.push(`- ${c.path}:${c.line ?? c.original_line ?? '?'} — ${c.body.trim()}`);
      if (lines.length) feedbackByRepo[p.repo_name] = lines.join('\n');
    }
    const feedback = Object.entries(feedbackByRepo).map(([repo, f]) => `### ${repo}\n${f}`).join('\n\n').slice(0, 12000);
    if (!feedback.trim()) {
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

    const prompt = [
      `A reviewer left feedback on your open pull request(s) for issue #${run.issue_number}. Address`,
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
      try { await commitAndPush(r.dir, run.branch_name, `fix: address review feedback on #${run.issue_number}`); pushed++; }
      catch { /* leave that PR as-is */ }
    }
    const round = (run.revise_count ?? 0) + 1;
    await recordPhaseEnd(supabase, run, 'revise', pushed ? 'passed' : 'skipped', pushed ? `addressed feedback (round ${round}, ${pushed} repo(s))` : 'no code change produced', { model: project.model, input: result.tokensInput, output: result.tokensOutput });
    await supabase.from('se_runs').update({ status: 'watching', current_phase: 'watch', revise_count: round, pr_state: 'open' }).eq('id', run.id);
    try { await gh.postComment(run.repo_owner, run.repo_name, run.issue_number, pushed ? `Pushed changes addressing the latest review feedback (${pushed} repo(s)).` : 'Reviewed the latest feedback; no code change was needed.'); } catch { /* best-effort */ }
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
