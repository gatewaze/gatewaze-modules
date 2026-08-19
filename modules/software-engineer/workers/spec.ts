// @ts-nocheck
/**
 * spec phase (§7). Explores the project's code repos READ-ONLY in a workspace and drafts an
 * implementation spec for the issue (which lives in the issues repo). The spec is stored as a run
 * artifact — NOT committed to any code repo (§1a) — then adversarial review runs. On a review retry
 * (job.data.objections) it re-drafts resolving every objection.
 *
 * The agent writes the spec to ./specs/issue-<n>.md at the workspace root (outside every repo). The
 * worker reads that file back as the artifact — it does NOT trust the agent's closing chat message,
 * which is a conversational summary, not the spec (review/implement both read the artifact verbatim).
 * If the file is missing or too short, the phase fails loud rather than passing prose downstream.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { getProject, getCodeRepos } from '../lib/credentials.js';
import { enqueuePhase } from '../lib/enqueue.js';
import { githubClient } from '../lib/github.js';
import { makeMultiWorkspace } from '../lib/worktree.js';
import { runAgentSession } from '../lib/phase-runner.js';
import { redactToken } from '../lib/git.js';
import { recordPhaseStart, recordPhaseEnd, blockRun } from '../lib/run-state.js';
import { writeSpecMemory } from '../lib/memory.js';

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

export default async function spec(job, ctx) {
  const supabase = sb(ctx);
  const objections = job?.data?.objections;
  const attempt = job?.data?.attempt ?? 1;
  const { data: run } = await supabase.from('se_runs').select('*').eq('id', job?.data?.runId).maybeSingle();
  if (!run) return { skipped: 'no run' };
  if (run.status === 'cancelled') return { skipped: 'cancelled' };
  const project = await getProject(supabase, run.project_id);
  if (!project?.intakeEnabled) return blockRun(supabase, run, 'spec', 'kill_switch', 'intake disabled');
  if (!project.githubToken || !project.modelCred) return blockRun(supabase, run, 'spec', 'authorization', 'project credentials missing');
  const token = project.githubToken;

  const codeRepos = await getCodeRepos(supabase, run.project_id);
  if (codeRepos.length === 0) return blockRun(supabase, run, 'spec', 'authorization', 'project has no code repos');

  await recordPhaseStart(supabase, run, 'spec', attempt);
  const gh = githubClient(token);
  let ws;
  try {
    const issue = await gh.getIssue(run.repo_owner, run.repo_name, run.issue_number);
    const branch = run.branch_name || `agent/se-${run.issue_number}-${String(run.id).slice(0, 8)}`;
    // Read-only clone of every code repo (up to the cap) so the agent can explore + pick targets.
    const forSpec = codeRepos.slice(0, project.maxCodeReposPerRun).map((r) => ({ ...r, writeMode: 'read_only' }));
    const truncated = codeRepos.length > project.maxCodeReposPerRun;
    ws = await makeMultiWorkspace(forSpec, token, branch);

    const specRelPath = `specs/issue-${run.issue_number}.md`;
    const prompt = [
      `Draft an implementation SPEC for this GitHub issue. The issue lives in a separate issues repo;`,
      `the code lives in the repos in your workspace. Explore them read-only, decide which WRITABLE`,
      `repo(s) the change belongs in, and write a clear spec: goal, approach, the repo(s) + files to`,
      `change, test plan, risks. Do NOT implement. Follow each repo's CLAUDE.md/.claude rules.`,
      `FIRST: use the wiki_search tool to look for existing related specs in project memory (pages`,
      `under specs/ — every past run's spec is logged there). If a prior spec covers overlapping`,
      `ground, build on it and note the relationship; do not contradict it silently.`,
      `Write the finished spec to ./${specRelPath} at the workspace ROOT (NOT inside any repo`,
      `subdirectory) — create the specs/ directory if it doesn't exist. That file, not your chat`,
      `reply, is what gets reviewed and implemented, so it must be the complete, self-contained spec.`,
      truncated ? `NOTE: the project has more code repos than the ${project.maxCodeReposPerRun}-repo cap; only those in your workspace are available — do not spec against repos not present.` : '',
      ``,
      `Issue #${run.issue_number}: ${issue.title ?? ''}`,
      ``,
      String(issue.body ?? '').slice(0, 8000),
      objections?.length ? `\nA prior review BLOCKED the spec. Resolve EVERY objection:\n- ${objections.join('\n- ')}\n` : '',
    ].join('\n');

    const result = await runAgentSession(supabase, ctx, run, project, 'spec', {
      cwd: ws.root, prompt, repos: ws.repos, allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
      systemAppend: `Draft a spec, do not implement. All repos here are read-only reference. Write the complete spec to ./${specRelPath} at the workspace root (outside every repo) — that file is what gets reviewed and implemented, not your chat reply.`,
      attempt,
    });
    if (result.error) {
      const msg = redactToken(result.error, token);
      if (result.costCeiling) return blockRun(supabase, run, 'spec', 'cost_ceiling', msg);
      await recordPhaseEnd(supabase, run, 'spec', 'failed', msg, { model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude', input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead, cacheCreation: result.tokensCacheCreation, cost: result.costUSD, modelUsage: result.modelUsage });
      await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
      return { failed: msg };
    }

    const specPath = join(ws.root, specRelPath);
    const specText = (existsSync(specPath) ? readFileSync(specPath, 'utf8') : '').slice(0, 200000);
    if (specText.trim().length < 200) {
      const msg = 'agent did not write the spec file';
      await recordPhaseEnd(supabase, run, 'spec', 'failed', msg, { model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude', input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead, cacheCreation: result.tokensCacheCreation, cost: result.costUSD, modelUsage: result.modelUsage });
      await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
      return { failed: msg };
    }
    await supabase.from('se_artifacts').insert({ run_id: run.id, site_id: run.site_id, phase: 'spec', kind: 'spec', content: specText });
    // Best-effort transcript of the agent's closing chat message — never treated as the spec itself.
    try {
      const summary = String(result.text ?? '').trim();
      if (summary) {
        await supabase.from('se_artifacts').insert({ run_id: run.id, site_id: run.site_id, phase: 'spec', kind: 'spec_summary', content: summary.slice(0, 20000) });
      }
    } catch { /* best-effort */ }

    // Spec log (best-effort, never blocks the pipeline):
    // 1. Commit the spec to the ISSUES repo at specs/issue-<n>.md — one file per issue, updated in
    //    place on review-loop revisions, so the repo's commit history is the full revision log.
    // 2. Mirror it into project memory as specs/issue-<n> so future runs (and linked projects'
    //    runs) find prior specs via RAG recall + wiki_search.
    const specDoc = [
      `# Spec — issue #${run.issue_number}: ${issue.title ?? ''}`,
      ``,
      `> Issue: https://github.com/${run.repo_owner}/${run.repo_name}/issues/${run.issue_number}`,
      `> Run: ${run.id} · generated ${new Date().toISOString()}`,
      ``,
      specText,
    ].join('\n');
    try {
      await gh.putFile(
        run.repo_owner, run.repo_name, `specs/issue-${run.issue_number}.md`, specDoc,
        `spec: issue #${run.issue_number} — ${String(issue.title ?? '').slice(0, 60)}`,
      );
    } catch { /* best-effort — e.g. token lacks contents:write on the issues repo */ }
    try { await writeSpecMemory(supabase, run.project_id, project.name, run.issue_number, issue.title ?? '', specText); }
    catch { /* best-effort */ }
    await recordPhaseEnd(supabase, run, 'spec', 'passed', 'spec drafted', { model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude', input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead, cacheCreation: result.tokensCacheCreation, cost: result.costUSD, modelUsage: result.modelUsage });
    await supabase.from('se_runs').update({
      branch_name: branch, current_phase: 'review',
      tokens_input: (run.tokens_input ?? 0) + result.tokensInput,
      tokens_output: (run.tokens_output ?? 0) + result.tokensOutput,
    }).eq('id', run.id);
    await enqueuePhase(ctx, run.id, 'review');
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
