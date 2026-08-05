// @ts-nocheck
/**
 * pr phase (§7). Opens one PR per changed writable repo (branch already pushed by implement),
 * records pr_number/pr_url in se_run_prs, comments all the PR links back on the ISSUE, sets the
 * issue status to agent:in-review, and hands off to the monitor. No agent session — pure GitHub API.
 */
import { createClient } from '@supabase/supabase-js';
import { getProject, getCodeRepos, resolveRunCredentials } from '../lib/credentials.js';
import { githubClient } from '../lib/github.js';
import { redactToken } from '../lib/git.js';
import { recordPhaseStart, recordPhaseEnd, blockRun, listRunPrs, upsertRunPr } from '../lib/run-state.js';

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

export default async function pr(job, ctx) {
  const supabase = sb(ctx);
  const { data: run } = await supabase.from('se_runs').select('*').eq('id', job?.data?.runId).maybeSingle();
  if (!run) return { skipped: 'no run' };
  if (run.status === 'cancelled') return { skipped: 'cancelled' };
  const project = await getProject(supabase, run.project_id);
  if (!project?.intakeEnabled) return blockRun(supabase, run, 'pr', 'kill_switch', 'intake disabled');
  const token = project.githubToken;

  await recordPhaseStart(supabase, run, 'pr');
  const gh = githubClient(token);
  // Credential model (§12): open the PUBLIC pull request as the project's pull-request PAT (or the acting
  // user's PAT in per-user mode). Falls back to the default token, so an unconfigured project is unchanged.
  const cred = await resolveRunCredentials(supabase, project, run);
  const ghPr = githubClient(cred.pullRequestPat ?? token);
  try {
    const { data: gateRows } = await supabase.from('se_gates').select('gate, verdict').eq('run_id', run.id);
    const gate = {};
    for (const g of gateRows ?? []) gate[g.gate] = g.verdict;
    const { data: art } = await supabase.from('se_artifacts').select('content').eq('run_id', run.id).eq('kind', 'spec').order('created_at', { ascending: false }).limit(1).maybeSingle();
    const codeRepos = await getCodeRepos(supabase, run.project_id);
    const baseOf = (o, n) => codeRepos.find((r) => r.repoOwner === o && r.repoName === n)?.baseBranch || null;

    const prs = (await listRunPrs(supabase, run.id)).filter((p) => p.state === 'open' && p.branch);
    if (prs.length === 0) {
      await recordPhaseEnd(supabase, run, 'pr', 'failed', 'no pushed branches to PR');
      await supabase.from('se_runs').update({ status: 'failed', error: 'no PRs to open' }).eq('id', run.id);
      return { failed: 'no prs' };
    }

    // Human-gated submission (§ pr_submit_mode). When the project requires manual submission, the code is
    // complete and the branch is pushed, but we do NOT open the pull request. Stop at ready_to_submit and
    // wait for a person to submit it from the dashboard. A submit action re-enqueues this phase with
    // submitApproved=true, which falls through to the normal PR creation below.
    if (project.prSubmitMode === 'manual' && !job?.data?.submitApproved) {
      await recordPhaseEnd(supabase, run, 'pr', 'blocked', 'code complete; pull request ready to submit (awaiting a human)');
      await supabase.from('se_runs').update({ status: 'ready_to_submit', current_phase: 'pr' }).eq('id', run.id);
      try { await gh.setStatusLabel(run.repo_owner, run.repo_name, run.issue_number, 'agent:needs-submit'); } catch { /* */ }
      try { await gh.postComment(run.repo_owner, run.repo_name, run.issue_number, 'Code is complete and the branch is pushed. The pull request is ready to submit and is waiting for a person to submit it from the dashboard.'); } catch { /* */ }
      return { ok: true, readyToSubmit: true, prs: prs.length };
    }

    // Title the PR by the real GitHub issue, not run.title (which can be a placeholder from the
    // triggering webhook payload). Falls back to run.title if the fetch fails.
    let issueTitle = run.title;
    try { issueTitle = (await gh.getIssue(run.repo_owner, run.repo_name, run.issue_number))?.title || run.title; } catch { /* keep run.title */ }

    const links = [];
    for (const p of prs) {
      if (p.pr_number) { links.push(`- ${p.repo_owner}/${p.repo_name}: ${p.pr_url}`); continue; }
      const base = baseOf(p.repo_owner, p.repo_name) || (await gh.defaultBranch(p.repo_owner, p.repo_name));
      // A PR whose repo differs from the issue's repo is CROSS-REPO: the triggering issue lives in a
      // separate (often private) tracker/roadmap repo, and this PR is on a public code repo. Never
      // reference that internal issue/repo here and never dump the spec/transcript — cite the real
      // tracking ticket (e.g. Jira) by link, in the house writing style. The roadmap issue is still
      // closed by pr-monitor when every PR merges, so no "Resolves" line is needed.
      const external = p.repo_owner !== run.repo_owner || p.repo_name !== run.repo_name;
      let body;
      if (external) {
        const key = String(issueTitle || run.title || '').match(/\b([A-Z][A-Z0-9]+-\d+)\b/)?.[1] || null;
        const tpl = project.trackerUrlTemplate;
        const trackerLine = key
          ? (tpl && tpl.includes('{key}') ? `**Tracking:** [${key}](${tpl.replace('{key}', key)})` : `**Tracking:** ${key}`)
          : null;
        const cleanTitle = String(issueTitle || run.title || '').replace(/^\s*\[[A-Za-z][A-Za-z0-9]*-\d+\]\s*/, '').trim();
        body = [trackerLine, trackerLine ? '' : null, `Implements ${cleanTitle || 'the tracked work'}.`].filter((l) => l !== null).join('\n');
      } else {
        // Internal same-repo PR (e.g. gatewaze): link + auto-close the issue, and include the gates + spec.
        body = [
          `Resolves ${run.repo_owner}/${run.repo_name}#${run.issue_number}`,
          ``, `### Gates`,
          `- adversarial review: ${gate['adversarial_review'] ?? 'n/a'}`,
          `- security: ${gate['security'] ?? 'n/a'}`,
          `- blast radius: ${run.blast_radius}`,
          ``, `### Spec`, (art?.content ?? '_(spec unavailable)_').slice(0, 18000),
        ].join('\n');
      }
      try {
        const prData = await ghPr.createPullRequest(p.repo_owner, p.repo_name, { title: issueTitle || `Resolve #${run.issue_number}`, head: p.branch, base, body });
        await upsertRunPr(supabase, run, p.repo_owner, p.repo_name, { pr_number: prData.number, pr_url: prData.html_url, state: 'open' });
        links.push(`- ${p.repo_owner}/${p.repo_name}: ${prData.html_url}`);
      } catch (e) {
        await upsertRunPr(supabase, run, p.repo_owner, p.repo_name, { state: 'error', error: redactToken(e?.message || String(e), token) });
      }
    }

    // Link all PRs back on the issue + set status in-review.
    try { await gh.postComment(run.repo_owner, run.repo_name, run.issue_number, `Opened pull request(s):\n${links.join('\n')}`); } catch { /* best-effort */ }
    try { await gh.setStatusLabel(run.repo_owner, run.repo_name, run.issue_number, 'agent:in-review'); } catch { /* best-effort */ }

    await recordPhaseEnd(supabase, run, 'pr', 'passed', `opened ${links.length} PR(s); watching for review`);
    await supabase.from('se_runs').update({ status: 'watching', current_phase: 'watch', pr_state: 'open' }).eq('id', run.id);
    // Fold what this run learned into the project's memory (§9). reflect proposes to a PENDING slug;
    // an admin approves it before it reaches any future run. Best-effort, non-fatal — a dropped
    // reflect never blocks the PR. Idempotent jobId so a re-drive can't double-propose.
    await ctx?.enqueueJob?.('se', 'software-engineer:reflect', { runId: run.id }, { jobId: `se-run-${run.id}-reflect`, removeOnComplete: true });
    await ctx?.enqueueJob?.('se', 'software-engineer:pr-monitor', { runId: run.id });
    return { ok: true, prs: links.length };
  } catch (e) {
    const msg = redactToken(e?.message || String(e), token);
    await recordPhaseEnd(supabase, run, 'pr', 'failed', msg);
    await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
    return { failed: msg };
  }
}
