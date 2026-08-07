// @ts-nocheck
/**
 * verify phase (§7). Runs a security review across the changed writable repos and records the
 * security gate, then enqueues pr. Reuses the read-only multi-repo workspace on the run branch.
 * NOTE: a deeper per-repo pragma validator pass is a follow-up; this does a focused security review
 * of the run's diff via the model and gates on its verdict.
 */
import { createClient } from '@supabase/supabase-js';
import { getProject, getCodeRepos } from '../lib/credentials.js';
import { enqueuePhase } from '../lib/enqueue.js';
import { makeMultiWorkspace } from '../lib/worktree.js';
import { runAgentSession } from '../lib/phase-runner.js';
import { githubClient } from '../lib/github.js';
import { redactToken } from '../lib/git.js';
import { recordPhaseStart, recordPhaseEnd, writeGate, blockRun, listRunPrs } from '../lib/run-state.js';

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

export default async function verify(job, ctx) {
  const supabase = sb(ctx);
  const { data: run } = await supabase.from('se_runs').select('*').eq('id', job?.data?.runId).maybeSingle();
  if (!run) return { skipped: 'no run' };
  if (run.status === 'cancelled') return { skipped: 'cancelled' };
  const project = await getProject(supabase, run.project_id);
  if (!project?.intakeEnabled) return blockRun(supabase, run, 'verify', 'kill_switch', 'intake disabled');
  const token = project.githubToken;

  // A resumed run (admin-routes.ts's /resume) passes an incremented attempt so this retry's row
  // doesn't clobber the FAILED attempt 1 row — both stay visible on the run detail phase badges.
  const attempt = job?.data?.attempt ?? 1;
  await recordPhaseStart(supabase, run, 'verify', attempt);
  let ws;
  try {
    // Clone the changed repos on the run branch (read-only) so the reviewer sees the actual diff.
    const prs = await listRunPrs(supabase, run.id);
    const changedRepos = prs.filter((p) => p.state !== 'error');
    const codeRepos = (await getCodeRepos(supabase, run.project_id))
      .filter((r) => changedRepos.some((p) => p.repo_owner === r.repoOwner && p.repo_name === r.repoName))
      .map((r) => ({ ...r, writeMode: 'read_only', baseBranch: run.branch_name }));
    ws = codeRepos.length ? await makeMultiWorkspace(codeRepos, token, run.branch_name) : { repos: [], root: '/tmp', cleanup: async () => {} };

    // Compute the ACTUAL diff (base...run-branch) per changed repo and hand it to the reviewer. The
    // reviewer only has Read/Grep/Glob (no git), so without this it greps the whole checked-out repo
    // and blocks on PRE-EXISTING codebase debt unrelated to this run. Scope the review to the diff.
    const gh = githubClient(token);
    const rawRepos = await getCodeRepos(supabase, run.project_id);
    let diffContext = '';
    for (const r of rawRepos.filter((r) => changedRepos.some((p) => p.repo_owner === r.repoOwner && p.repo_name === r.repoName))) {
      try {
        const base = r.baseBranch || (await gh.defaultBranch(r.repoOwner, r.repoName));
        const cmp = await gh.compare(r.repoOwner, r.repoName, base, run.branch_name);
        const files = cmp?.files ?? [];
        diffContext += `\n\n### ${r.repoOwner}/${r.repoName} — ${files.length} changed file(s) vs ${base}:`;
        for (const f of files.slice(0, 40)) {
          diffContext += `\n\n--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions}) ---\n${(f.patch ?? '(binary or too large — Read it in the workspace)').slice(0, 4000)}`;
        }
      } catch { /* skip repo; reviewer falls back to conservative workspace review */ }
    }

    const prompt = [
      `Security-review ONLY the changes THIS run introduced on branch ${run.branch_name}. The exact diff`,
      `is below. Judge the ADDED/CHANGED lines against each repo's .claude/rules/security-boundaries:`,
      `injection into PostgREST .or()/SQL/ICS/URLs, mass assignment via req.body, missing enum`,
      `validation, service-role null-guards, unsafe shell, hardcoded secrets, missing rate limits.`,
      ``,
      `CRITICAL SCOPING: flag a problem ONLY if THIS DIFF introduces or worsens it. Pre-existing issues`,
      `in code this branch did NOT change are OUT OF SCOPE — do NOT block on them (you may Read the`,
      `workspace for context, but the verdict is about the diff below, not the wider codebase).`,
      ``,
      `--- DIFF ---${diffContext || '\n(no diff computed — review the workspace conservatively)'}`,
      ``,
      `Final line EXACTLY "VERDICT: PASS" if the diff is clean, or "VERDICT: BLOCK: <reasons>" if the`,
      `diff introduces a real vulnerability.`,
    ].join('\n');
    const result = await runAgentSession(supabase, ctx, run, project, 'verify', {
      cwd: ws.root, prompt, repos: ws.repos, attempt, allowedTools: ['Read', 'Grep', 'Glob'],
    });
    if (result.error) {
      const msg = redactToken(result.error, token);
      await recordPhaseEnd(supabase, run, 'verify', 'failed', msg, { model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude', input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead, cacheCreation: result.tokensCacheCreation, cost: result.costUSD, modelUsage: result.modelUsage });
      await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
      return { failed: msg };
    }

    const text = String(result.text ?? '');
    const blocked = /VERDICT:\s*BLOCK/i.test(text);
    if (blocked) {
      const reason = (text.match(/VERDICT:\s*BLOCK:?\s*(.*)/i)?.[1] ?? 'security review blocked').slice(0, 500);
      await writeGate(supabase, run, 'security', 'block', { reason });
      await recordPhaseEnd(supabase, run, 'verify', 'blocked', reason, { model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude', input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead, cacheCreation: result.tokensCacheCreation, cost: result.costUSD, modelUsage: result.modelUsage });
      await supabase.from('se_runs').update({ status: 'blocked', error: `security: ${reason}` }).eq('id', run.id);
      return { blocked: reason };
    }
    await writeGate(supabase, run, 'security', 'pass', {});
    await recordPhaseEnd(supabase, run, 'verify', 'passed', 'security review clean', { model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude', input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead, cacheCreation: result.tokensCacheCreation, cost: result.costUSD, modelUsage: result.modelUsage });
    await supabase.from('se_runs').update({ current_phase: 'pr' }).eq('id', run.id);
    await enqueuePhase(ctx, run.id, 'pr');
    return { ok: true };
  } catch (e) {
    const msg = redactToken(e?.message || String(e), token);
    await recordPhaseEnd(supabase, run, 'verify', 'failed', msg);
    await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
    return { failed: msg };
  } finally {
    try { await ws?.cleanup?.(); } catch { /* ignore */ }
  }
}
