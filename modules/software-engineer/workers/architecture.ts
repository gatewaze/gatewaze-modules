// @ts-nocheck
/**
 * architecture phase (§7.6) — the architecture-review GATE. Runs after the spec is skeptic-approved,
 * but only for projects that configure `architecture_repo` (e.g. LFX → linuxfoundation/lfx-architecture-scratch).
 *
 * The agent reads this project's DEVELOPMENT PROCESS rules (injected by phase-runner) + the approved
 * spec, then decides whether the work is architecture-impacting per those rules. It has the ARCH repo
 * writable and the code repos read-only for context:
 *   - NOT architectural  → it writes nothing → we proceed straight to implement.
 *   - architectural      → it writes a proposal (a dated folder + README following the repo's own
 *                          convention) into the arch repo → we open a PR there and BLOCK the run
 *                          ('awaiting_architecture'). pr-monitor resumes it to implement when a human
 *                          merges the proposal (architecture approved), or blocks it if it's closed.
 *
 * No Bash: the agent only reads context and writes a markdown proposal.
 */
import { createClient } from '@supabase/supabase-js';
import { getProject, getCodeRepos, resolveCommitIdentity } from '../lib/credentials.js';
import { enqueuePhase } from '../lib/enqueue.js';
import { githubClient } from '../lib/github.js';
import { makeMultiWorkspace, hasChanges, commitAndPush } from '../lib/worktree.js';
import { runAgentSession } from '../lib/phase-runner.js';
import { redactToken } from '../lib/git.js';
import { recordPhaseStart, recordPhaseEnd, blockRun } from '../lib/run-state.js';

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export default async function architecture(job, ctx) {
  const supabase = sb(ctx);
  const { data: run } = await supabase.from('se_runs').select('*').eq('id', job?.data?.runId).maybeSingle();
  if (!run) return { skipped: 'no run' };
  if (run.status === 'cancelled' || run.archived_at) return { skipped: 'inactive' };
  const project = await getProject(supabase, run.project_id);
  if (!project?.intakeEnabled) return blockRun(supabase, run, 'architecture', 'kill_switch', 'intake disabled');
  const token = project.githubToken;
  if (!token || !project.modelCred) return blockRun(supabase, run, 'architecture', 'authorization', 'project credentials missing');

  const archRepo = String(project.architectureRepo ?? '').trim();
  // Gate off / misconfigured → don't stall the run; go straight to implement (behaviour without the gate).
  if (!archRepo || !REPO_RE.test(archRepo)) {
    await supabase.from('se_runs').update({ current_phase: 'implement' }).eq('id', run.id);
    await enqueuePhase(ctx, run.id, 'implement');
    return { skipped: 'no architecture repo', next: 'implement' };
  }
  const [archOwner, archName] = archRepo.split('/');
  const archRef = String(project.architectureRef ?? '').trim() || 'main';

  await recordPhaseStart(supabase, run, 'architecture');
  const gh = githubClient(token);
  let ws;
  try {
    const { data: art } = await supabase.from('se_artifacts').select('content').eq('run_id', run.id).eq('kind', 'spec').order('created_at', { ascending: false }).limit(1).maybeSingle();
    const codeRepos = (await getCodeRepos(supabase, run.project_id)).slice(0, project.maxCodeReposPerRun);
    // Arch repo WRITABLE (proposal target) + code repos READ-ONLY (context).
    const repos = [
      { repoOwner: archOwner, repoName: archName, writeMode: 'writable', baseBranch: archRef },
      ...codeRepos.map((r) => ({ ...r, writeMode: 'read_only' })),
    ];
    const branch = run.branch_name || `arch/issue-${run.issue_number ?? run.id.slice(0, 8)}`;
    const commitId = await resolveCommitIdentity(supabase, project, token);
    ws = await makeMultiWorkspace(repos, token, branch, commitId);
    const archDir = ws.repos.find((r) => r.repoOwner === archOwner && r.repoName === archName)?.dir;

    const prompt = [
      `You are at the ARCHITECTURE-REVIEW gate for issue #${run.issue_number ?? '?'}${run.title ? ` — ${run.title}` : ''}.`,
      `Read this project's DEVELOPMENT PROCESS rules (in your system prompt) and the approved spec below.`,
      `Decide whether delivering this work requires a change to the ARCHITECTURE, using the criteria the`,
      `process rules define (typically: a new service/component, a new data store or schema, a new or`,
      `changed cross-service contract/API, a new external dependency, or an auth/tenancy/security-boundary`,
      `change). When unsure, treat it AS architectural — the review is cheap, an unreviewed arch change is not.`,
      ``,
      `- If it is NOT architectural: make NO changes to any repo. Do nothing else.`,
      `- If it IS architectural: write a proposal into the WRITABLE ./${archName}/ repo ONLY, following`,
      `  that repo's existing convention (look at sibling folders — they use a dated "YYYY-MM <Short Title>/"`,
      `  directory with a README.md). Create ONE such folder for this work and write a clear README.md:`,
      `  problem/context, the proposed architecture + alternatives considered, data-model/API/contract`,
      `  changes, security & tenancy impact, and a link to issue #${run.issue_number ?? '?'}. Do not touch`,
      `  the code repos — they are read-only context. Do not push or open PRs; the system does that.`,
      ``,
      `--- APPROVED SPEC ---`,
      String(art?.content ?? '').slice(0, 20000),
      `--- END SPEC ---`,
    ].join('\n');

    const result = await runAgentSession(supabase, ctx, run, project, 'architecture', {
      cwd: ws.root, repos: ws.repos, prompt,
      allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
      attachments: false,
      systemAppend: 'You are gating on architecture, not implementing. Only ever write inside the writable architecture repo, and only when the work is genuinely architectural.',
    });
    if (result.error) {
      const msg = redactToken(result.error, token);
      await recordPhaseEnd(supabase, run, 'architecture', 'failed', msg);
      await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
      return { failed: msg };
    }

    // No proposal written → the agent judged the work non-architectural → proceed to implement.
    if (!archDir || !(await hasChanges(archDir))) {
      await recordPhaseEnd(supabase, run, 'architecture', 'passed', 'no architecture change required');
      await supabase.from('se_runs').update({ current_phase: 'implement' }).eq('id', run.id);
      await enqueuePhase(ctx, run.id, 'implement');
      return { ok: true, gated: false };
    }

    // Architectural → open the proposal PR against the scratch repo and BLOCK for human review.
    const title = `Architecture proposal — ${run.title ? run.title : `issue #${run.issue_number}`}`.slice(0, 240);
    await commitAndPush(archDir, branch, title);
    const prBody = [
      `Architecture proposal generated by the Software Engineer agent for a piece of work that requires`,
      `architectural changes, per the project's development-process rules.`,
      ``,
      run.issue_url ? `Triggering issue: ${run.issue_url}` : `Triggering issue: #${run.issue_number}`,
      ``,
      `Review and **merge** this proposal to approve the architecture — the coding run then resumes to`,
      `implementation automatically. Close it without merging to send the work back for a human decision.`,
    ].join('\n');
    const pr = await gh.createPullRequest(archOwner, archName, { title, head: branch, base: archRef, body: prBody });

    await supabase.from('se_runs').update({
      status: 'awaiting_architecture', current_phase: 'architecture',
      architecture_repo: archRepo, architecture_pr_number: pr.number, architecture_pr_url: pr.html_url,
    }).eq('id', run.id);
    // Surface it on the triggering issue (best-effort).
    if (run.issue_number) {
      try { await gh.setStatusLabel(run.repo_owner, run.repo_name, run.issue_number, 'agent:in-review'); } catch { /* */ }
      try { await gh.postComment(run.repo_owner, run.repo_name, run.issue_number, `Architecture review required — proposal opened: ${pr.html_url}\n\nImplementation will resume automatically when it is merged.`); } catch { /* */ }
    }
    await recordPhaseEnd(supabase, run, 'architecture', 'blocked', 'awaiting architecture review');
    return { ok: true, gated: true, prUrl: pr.html_url };
  } catch (e) {
    const msg = redactToken(e?.message || String(e), token);
    await recordPhaseEnd(supabase, run, 'architecture', 'failed', msg);
    await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
    return { failed: msg };
  } finally {
    try { await ws?.cleanup?.(); } catch { /* ignore */ }
  }
}
