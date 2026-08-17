// @ts-nocheck
/**
 * implement phase (§7). Clones the project's code repos into a workspace (writable repos on a fresh
 * branch), has the agent implement the approved spec across them, then commits + pushes ONLY the
 * writable repos that actually changed — recording one se_run_prs row per changed repo. Enqueues
 * verify. If nothing changed, fails.
 */
import { createClient } from '@supabase/supabase-js';
import { getProject, getCodeRepos, resolveCommitIdentity, resolveRunCredentials } from '../lib/credentials.js';
import { enqueuePhase } from '../lib/enqueue.js';
import { githubClient } from '../lib/github.js';
import { makeMultiWorkspace, hasChanges, commitAndPush, commitsAhead, pushBranch } from '../lib/worktree.js';
import { runAgentSession } from '../lib/phase-runner.js';
import { classifyBlastRadius } from '../lib/blast-radius.js';
import { redactToken } from '../lib/git.js';
import { recordPhaseStart, recordPhaseEnd, writeGate, blockRun, upsertRunPr } from '../lib/run-state.js';

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

export default async function implement(job, ctx) {
  const supabase = sb(ctx);
  const { data: run } = await supabase.from('se_runs').select('*').eq('id', job?.data?.runId).maybeSingle();
  if (!run) return { skipped: 'no run' };
  if (run.status === 'cancelled') return { skipped: 'cancelled' };
  const project = await getProject(supabase, run.project_id);
  if (!project?.intakeEnabled) return blockRun(supabase, run, 'implement', 'kill_switch', 'intake disabled');
  const token = project.githubToken;

  const codeRepos = (await getCodeRepos(supabase, run.project_id)).slice(0, project.maxCodeReposPerRun);
  // A resumed run (admin-routes.ts's /resume) passes an incremented attempt so this retry's row
  // doesn't clobber the FAILED attempt 1 row — both stay visible on the run detail phase badges.
  const attempt = job?.data?.attempt ?? 1;
  await recordPhaseStart(supabase, run, 'implement', attempt);
  let ws;
  try {
    const { data: art } = await supabase.from('se_artifacts').select('content').eq('run_id', run.id).eq('kind', 'spec').order('created_at', { ascending: false }).limit(1).maybeSingle();
    const branch = run.branch_name;
    // Credential model (§12): author + push the commits as the committing PAT (or the acting user's PAT
    // in per-user mode). Falls back to the default token, so an unconfigured project is unchanged.
    const cred = await resolveRunCredentials(supabase, project, run);
    const commitToken = cred.committingPat ?? token;
    const commitId = await resolveCommitIdentity(supabase, project, commitToken);
    ws = await makeMultiWorkspace(codeRepos, commitToken, branch, commitId);

    const prompt = [
      `Implement the approved spec below across the WRITABLE repos in your workspace. Change only the`,
      `repos and files the spec calls for; follow each repo's CLAUDE.md/.claude rules exactly. Make the`,
      `code changes and any tests. Do NOT push, tag, or open PRs — the system handles that. Do NOT run`,
      `git commit yourself; leave the working tree as edited/untracked files for the system to commit.`,
      ``,
      `--- APPROVED SPEC ---`,
      String(art?.content ?? '').slice(0, 20000),
      `--- END SPEC ---`,
    ].join('\n');

    const result = await runAgentSession(supabase, ctx, run, project, 'implement', {
      cwd: ws.root, prompt, repos: ws.repos, attempt,
      allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
      systemAppend: 'Implement per the spec + each repo\'s rules. Never use --no-verify or --force. Do not open PRs.',
    });
    if (result.error) {
      const msg = redactToken(result.error, token);
      if (result.costCeiling) return blockRun(supabase, run, 'implement', 'cost_ceiling', msg);
      await recordPhaseEnd(supabase, run, 'implement', 'failed', msg, { model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude', input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead, cacheCreation: result.tokensCacheCreation, cost: result.costUSD, modelUsage: result.modelUsage });
      await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
      return { failed: msg };
    }

    // Commit + push each WRITABLE repo that changed → one se_run_prs row (state=open) per repo.
    let changed = 0, files = 0, lines = 0;
    const allFiles = []; // real changed-file objects across every writable repo (for blast-radius)
    let compareUnknown = false; // a diff fetch failed → we cannot assess blast radius → fail safe
    for (const r of ws.repos.filter((x) => x.writable)) {
      const dirty = await hasChanges(r.dir);
      const ahead = dirty ? 0 : await commitsAhead(r.dir, r.startSha);
      if (!dirty && ahead === 0) continue;
      changed++;
      try {
        if (dirty) {
          await commitAndPush(r.dir, branch, `feat: implement issue #${run.issue_number}`);
        } else {
          // Agent already committed (tree is clean but HEAD moved) — nothing to add, just push.
          await pushBranch(r.dir, branch);
        }
        await upsertRunPr(supabase, run, r.repoOwner, r.repoName, { branch, state: 'open' });
        try {
          const cmp = await gitCompareCount(githubClient(token), r.repoOwner, r.repoName, r.baseBranch, branch);
          files += cmp.files; lines += cmp.lines; allFiles.push(...cmp.fileList);
        } catch { compareUnknown = true; /* can't diff this repo → don't let it pass as 'safe' */ }
      } catch (e) {
        await upsertRunPr(supabase, run, r.repoOwner, r.repoName, { branch, state: 'error', error: redactToken(e?.message || String(e), token) });
      }
    }
    if (changed === 0) {
      await recordPhaseEnd(supabase, run, 'implement', 'failed', 'agent produced no changes in any writable repo', { model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude', input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead, cacheCreation: result.tokensCacheCreation, cost: result.costUSD, modelUsage: result.modelUsage });
      await supabase.from('se_runs').update({ status: 'failed', error: 'implement produced no changes' }).eq('id', run.id);
      return { failed: 'no changes' };
    }

    // Classify the REAL changed files (path, line-delta, status). Passing a
    // count-only placeholder made the sensitive-path regex, line-count, and
    // deletion checks all dead — so a run touching CI, migrations, auth, or the
    // module's own guardrails across <=15 files was still scored 'safe', which
    // is exactly what gates auto-merge under autonomy_mode 'auto_merge_safe'.
    const blast = compareUnknown
      ? { classification: 'needs_human', reasons: ['diff unavailable for one or more changed repos — cannot assess blast radius'] }
      : classifyBlastRadius(allFiles);
    await writeGate(supabase, run, 'blast_radius', blast.classification === 'safe' ? 'pass' : 'block', { files, lines, repos: changed });
    await recordPhaseEnd(supabase, run, 'implement', 'passed', `implemented across ${changed} repo(s)`, { model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude', input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead, cacheCreation: result.tokensCacheCreation, cost: result.costUSD, modelUsage: result.modelUsage });
    await supabase.from('se_runs').update({
      blast_radius: blast.classification, current_phase: 'verify',
      tokens_input: (run.tokens_input ?? 0) + result.tokensInput,
      tokens_output: (run.tokens_output ?? 0) + result.tokensOutput,
    }).eq('id', run.id);
    await enqueuePhase(ctx, run.id, 'verify');
    return { ok: true, changedRepos: changed };
  } catch (e) {
    const msg = redactToken(e?.message || String(e), token);
    await recordPhaseEnd(supabase, run, 'implement', 'failed', msg);
    await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
    return { failed: msg };
  } finally {
    try { await ws?.cleanup?.(); } catch { /* ignore */ }
  }
}

async function gitCompareCount(gh, owner, name, base, head) {
  const b = base || (await gh.defaultBranch(owner, name));
  const cmp = await gh.compare(owner, name, b, head);
  const fs = cmp?.files ?? [];
  // fileList carries the REAL per-file objects ({ filename, status, additions,
  // deletions }) — the blast-radius classifier needs these, not just counts.
  return { files: fs.length, lines: fs.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0), fileList: fs };
}
