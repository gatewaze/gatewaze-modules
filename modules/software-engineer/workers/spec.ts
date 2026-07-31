// @ts-nocheck
/**
 * spec phase (§7). Explores the project's code repos READ-ONLY in a workspace and drafts an
 * implementation spec for the issue (which lives in the issues repo). The spec is stored as a run
 * artifact — NOT committed to any code repo (§1a) — then adversarial review runs. On a review retry
 * (job.data.objections) it re-drafts resolving every objection.
 */
import { createClient } from '@supabase/supabase-js';
import { getProject, getCodeRepos } from '../lib/credentials.js';
import { githubClient } from '../lib/github.js';
import { makeMultiWorkspace } from '../lib/worktree.js';
import { runAgentSession } from '../lib/phase-runner.js';
import { redactToken } from '../lib/git.js';
import { recordPhaseStart, recordPhaseEnd, blockRun } from '../lib/run-state.js';

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

export default async function spec(job, ctx) {
  const supabase = sb(ctx);
  const objections = job?.data?.objections;
  const { data: run } = await supabase.from('se_runs').select('*').eq('id', job?.data?.runId).maybeSingle();
  if (!run) return { skipped: 'no run' };
  if (run.status === 'cancelled') return { skipped: 'cancelled' };
  const project = await getProject(supabase, run.project_id);
  if (!project?.intakeEnabled) return blockRun(supabase, run, 'spec', 'kill_switch', 'intake disabled');
  if (!project.githubToken || !project.modelCred) return blockRun(supabase, run, 'spec', 'authorization', 'project credentials missing');
  const token = project.githubToken;

  const codeRepos = await getCodeRepos(supabase, run.project_id);
  if (codeRepos.length === 0) return blockRun(supabase, run, 'spec', 'authorization', 'project has no code repos');

  await recordPhaseStart(supabase, run, 'spec');
  const gh = githubClient(token);
  let ws;
  try {
    const issue = await gh.getIssue(run.repo_owner, run.repo_name, run.issue_number);
    const branch = run.branch_name || `agent/se-${run.issue_number}-${String(run.id).slice(0, 8)}`;
    // Read-only clone of every code repo (up to the cap) so the agent can explore + pick targets.
    const forSpec = codeRepos.slice(0, project.maxCodeReposPerRun).map((r) => ({ ...r, writeMode: 'read_only' }));
    const truncated = codeRepos.length > project.maxCodeReposPerRun;
    ws = await makeMultiWorkspace(forSpec, token, branch);

    const prompt = [
      `Draft an implementation SPEC for this GitHub issue. The issue lives in a separate issues repo;`,
      `the code lives in the repos in your workspace. Explore them read-only, decide which WRITABLE`,
      `repo(s) the change belongs in, and write a clear spec: goal, approach, the repo(s) + files to`,
      `change, test plan, risks. Do NOT implement. Follow each repo's CLAUDE.md/.claude rules.`,
      truncated ? `NOTE: the project has more code repos than the ${project.maxCodeReposPerRun}-repo cap; only those in your workspace are available — do not spec against repos not present.` : '',
      ``,
      `Issue #${run.issue_number}: ${issue.title ?? ''}`,
      ``,
      String(issue.body ?? '').slice(0, 8000),
      objections?.length ? `\nA prior review BLOCKED the spec. Resolve EVERY objection:\n- ${objections.join('\n- ')}\n` : '',
    ].join('\n');

    const result = await runAgentSession(supabase, ctx, run, project, 'spec', {
      cwd: ws.root, prompt, repos: ws.repos, allowedTools: ['Read', 'Grep', 'Glob'],
    });
    if (result.error) {
      const msg = redactToken(result.error, token);
      await recordPhaseEnd(supabase, run, 'spec', 'failed', msg);
      await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
      return { failed: msg };
    }

    await supabase.from('se_artifacts').insert({ run_id: run.id, site_id: run.site_id, phase: 'spec', kind: 'spec', content: (result.text ?? '').slice(0, 200000) });
    await recordPhaseEnd(supabase, run, 'spec', 'passed', 'spec drafted', { model: project.model, input: result.tokensInput, output: result.tokensOutput });
    await supabase.from('se_runs').update({
      branch_name: branch, current_phase: 'review',
      tokens_input: (run.tokens_input ?? 0) + result.tokensInput,
      tokens_output: (run.tokens_output ?? 0) + result.tokensOutput,
    }).eq('id', run.id);
    await ctx?.enqueueJob?.('jobs', 'software-engineer:review', { runId: run.id });
    return { ok: true, branch };
  } catch (e) {
    const msg = redactToken(e?.message || String(e), token);
    await recordPhaseEnd(supabase, run, 'spec', 'failed', msg);
    await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
    return { failed: msg };
  } finally {
    try { await ws?.cleanup?.(); } catch { /* ignore */ }
  }
}
