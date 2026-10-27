// @ts-nocheck
/**
 * pre-pr-review phase (§7). Runs AFTER implement has committed and pushed the run branch and
 * BEFORE verify/pr. The agent gets a WRITABLE clone of the run branch of every repo this run
 * changed, with enough history to diff against the repo's base branch, and runs THAT repo's own
 * pre-PR round: the review skills its working agreement (CLAUDE.md and/or AGENTS.md) names, its
 * readiness/preflight checks, and the fix commit those rules ask for. A repo whose agreement has no
 * pre-PR section gets a generic round instead (the repo's own checks plus a diff review).
 *
 * The rules and skills that steer the round are read from the BASE branch whenever the branch under
 * review changed them (worktree.GUARDRAIL_PATHS): the implement agent wrote that branch from issue
 * text, so the gate must not take its instructions from the thing it checks. A base that cannot be
 * fetched blocks the round. The checks those rules name (build, lint, tests) still run from the
 * branch's own tooling — there is no base substitute for a repo's scripts — so branch changes to
 * common tooling paths are named in the brief and on the gate, and the blast-radius classifier
 * keeps such a run from auto-merging; that residual risk is accepted.
 *
 * The worker then pushes whatever the agent committed (committing tracked edits it left behind as
 * the fix commit), re-classifies the blast radius from the real diff when anything was pushed,
 * records the `pre_pr_review` gate, and hands off to verify. A round the agent reports as incomplete
 * — a skill it could not load, a check it could not make pass — blocks the run for a human instead
 * of opening a pull request on a partial round. The verdict is parsed from the main agent's final
 * message only, never from a reviewer subagent's words.
 *
 * Why a separate phase: the LFX repos' agreements require the review round on the COMMITTED branch
 * and forbid any local review once the PR exists, so it can live neither inside implement (the tree
 * is uncommitted there) nor after pr. External-PR runs (Connect) already have a PR, so they skip it.
 */
import { createClient } from '@supabase/supabase-js';
import { join } from 'node:path';
import { getCodeRepos, getProject, resolveCommitIdentity, resolveRunCredentials } from '../lib/credentials.js';
import { enqueuePhase } from '../lib/enqueue.js';
import { githubClient } from '../lib/github.js';
import { makeMultiWorkspace, hasChanges, commitsAhead, pushBranch, commitTrackedAndPush, fetchBaseForReview, changedGuardrails, changedPaths, exportGuardrailsAtRef, TOOLING_PATHS } from '../lib/worktree.js';
import { runAgentSession } from '../lib/phase-runner.js';
import { redactToken } from '../lib/git.js';
import { recordPhaseStart, recordPhaseEnd, writeGate, blockRun, listRunPrs } from '../lib/run-state.js';
import { createOrSupersedeDecision } from '../lib/decisions.js';
import { repoLocalPluginName } from '../lib/skills.js';
import { classifyBlastRadius } from '../lib/blast-radius.js';
import { gitCompareCount } from './implement.js';

export const PHASE = 'pre-pr-review';
export const GATE = 'pre_pr_review';
export const FIX_COMMIT_SUBJECT = 'fix: address pre-PR review findings';
// Where the base branch's guardrails are written inside the workspace when the branch changed them.
const BASE_GUARDRAILS_DIR = '.se-base-guardrails';

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

/**
 * The agent's closing `RESULT:` line — the last line that STARTS with it. Fail-closed: no such
 * line, or anything but `ok`, is incomplete — the whole point of the phase is that a PR never opens
 * on a round that did not finish. Anchored to the line start so a quoted mention of the brief
 * ("the last line must be exactly `RESULT: ok`") cannot pass as a verdict.
 */
export function parseResult(text: string): { ok: boolean; reason: string } {
  const matches = [...String(text ?? '').matchAll(/^\s*RESULT:\s*(ok|incomplete)\b:?[ \t]*([^\n]*)/gim)];
  const m = matches.at(-1);
  if (!m) return { ok: false, reason: 'the agent did not report a RESULT line' };
  if (m[1].toLowerCase() === 'ok') return { ok: true, reason: '' };
  return { ok: false, reason: (m[2] || 'the agent reported the round incomplete').trim().slice(0, 500) };
}

export default async function prePrReview(job, ctx) {
  const supabase = sb(ctx);
  const { data: run } = await supabase.from('se_runs').select('*').eq('id', job?.data?.runId).maybeSingle();
  if (!run) return { skipped: 'no run' };
  if (run.status === 'cancelled') return { skipped: 'cancelled' };
  const project = await getProject(supabase, run.project_id);
  if (!project?.intakeEnabled) return blockRun(supabase, run, PHASE, 'kill_switch', 'intake disabled');
  const token = project.githubToken;

  // A resumed run (admin-routes.ts's /resume) passes an incremented attempt so this retry's row
  // doesn't clobber the earlier attempt's row — both stay visible on the run detail phase badges.
  const attempt = job?.data?.attempt ?? 1;
  await recordPhaseStart(supabase, run, PHASE, attempt);
  let ws;
  try {
    // A Connect run already has its pull request. The repos' rules forbid a local review once the
    // PR exists (iteration happens on the PR's own review threads), so hand straight on to verify.
    if (run.kind === 'external_pr') {
      await writeGate(supabase, run, GATE, 'pass', { skipped: 'external_pr' });
      await recordPhaseEnd(supabase, run, PHASE, 'passed', 'skipped: the pull request already exists');
      await supabase.from('se_runs').update({ current_phase: 'verify' }).eq('id', run.id);
      await enqueuePhase(ctx, run.id, 'verify');
      return { ok: true, skipped: 'external_pr' };
    }

    const changed = (await listRunPrs(supabase, run.id)).filter((p) => p.state !== 'error' && p.branch);
    if (changed.length === 0) {
      // implement counted a changed repo but every push failed. Resume `implement`, not this phase.
      await recordPhaseEnd(supabase, run, PHASE, 'failed', 'no pushed branches to review — implement pushed nothing; resume from implement');
      await supabase.from('se_runs').update({ status: 'failed', error: 'pre-pr-review: nothing to review (implement pushed nothing)' }).eq('id', run.id);
      return { failed: 'no branches' };
    }
    const configured = await getCodeRepos(supabase, run.project_id);
    const codeRepos = configured
      .filter((r) => changed.some((p) => p.repo_owner === r.repoOwner && p.repo_name === r.repoName))
      .map((r) => ({ ...r, checkoutRef: undefined, writeMode: 'writable' }));
    // Every pushed branch must be reviewable: a changed repo that has since been removed from the
    // project cannot be, and silently reviewing the rest would record a pass on a half-reviewed run.
    const missing = changed.filter((p) => !configured.some((r) => r.repoOwner === p.repo_owner && r.repoName === p.repo_name));
    if (missing.length) throw new Error(`changed repositories no longer configured on this project: ${missing.map((p) => `${p.repo_owner}/${p.repo_name}`).join(', ')}`);

    // Same credential model as implement (§12): the fix commit is authored and pushed as the
    // committing PAT (or the acting user's PAT in per-user mode), falling back to the default token.
    const cred = await resolveRunCredentials(supabase, project, run);
    const commitToken = cred.committingPat ?? token;
    const commitId = await resolveCommitIdentity(supabase, project, commitToken);
    ws = await makeMultiWorkspace(codeRepos, commitToken, run.branch_name, commitId, true);

    // The run-branch clone is shallow and single-branch. A branch review needs the base branch and
    // the merge base, so fetch them. Then check whether the branch changed the guardrails and, if
    // so, read the base branch's versions instead — against the merge base when history joined,
    // against origin/<base> itself when it did not (a diff needs no common ancestor). A base that
    // could not be fetched at all leaves nothing to check the branch's rules against, so the round
    // blocks for a human instead of running under rules the branch may have written.
    const gh = githubClient(token);
    const bases = [];
    const guardrailsChanged = {};
    const toolingChanged = {};
    const baseUnavailable = [];
    for (const r of ws.repos) {
      const base = r.baseBranch || (await gh.defaultBranch(r.repoOwner, r.repoName));
      const key = `${r.repoOwner}/${r.repoName}`;
      let mergeBase = null;
      let fetchError = '';
      try { mergeBase = await fetchBaseForReview(r.dir, base, run.branch_name); } catch (e) { fetchError = redactToken(e?.message || String(e), token).slice(0, 300); }
      const guardRef = mergeBase ?? (fetchError ? null : `origin/${base}`);
      let guardrails = [];
      let tooling = [];
      if (!guardRef) {
        baseUnavailable.push(`${key}: origin/${base} (${fetchError || 'ref rejected'})`);
      } else {
        guardrails = await changedGuardrails(r.dir, guardRef);
        if (guardrails.length) {
          const dest = join(ws.root, BASE_GUARDRAILS_DIR, r.repoOwner, r.repoName);
          await exportGuardrailsAtRef(r.dir, guardRef, dest);
          r.agreementDir = dest;
          guardrailsChanged[key] = guardrails;
        }
        tooling = await changedPaths(r.dir, guardRef, TOOLING_PATHS);
        if (tooling.length) toolingChanged[key] = tooling;
      }
      bases.push({ repo: key, rel: key, base, mergeBase, fetchError, guardrails, tooling });
    }
    if (baseUnavailable.length) {
      const reason = `base branch unavailable, cannot verify the branch's rules against it: ${baseUnavailable.join('; ')}`.slice(0, 800);
      await writeGate(supabase, run, GATE, 'block', { reason, repos: ws.repos.length, fixes: 0 });
      await recordPhaseEnd(supabase, run, PHASE, 'blocked', reason);
      await supabase.from('se_runs').update({ status: 'blocked', error: `pre-PR review: ${reason}` }).eq('id', run.id);
      try {
        await createOrSupersedeDecision(supabase, {
          runId: run.id, projectId: run.project_id, siteId: run.site_id, phase: PHASE,
          question: `pre-PR review: ${reason}`, kind: 'text', context: null, originKind: 'config_blocked',
        });
      } catch { /* best-effort */ }
      return { blocked: reason };
    }

    // File names come from the branch, so they are shown to the agent in a safe charset, capped.
    const safeNames = (names) => names.slice(0, 10).map((n) => String(n).replace(/[^A-Za-z0-9_./-]+/g, '?').slice(0, 120)).join(', ') + (names.length > 10 ? `, +${names.length - 10} more` : '');
    const repoLines = bases.map((b) => {
      let line = `- ${b.repo} (./${b.rel}/): base branch origin/${b.base}`;
      line += b.mergeBase
        ? `, merge base ${b.mergeBase}`
        : `, no merge base with origin/${b.base} — review \`git diff origin/${b.base}...HEAD\` as far as it goes and say so in your report`;
      if (b.guardrails.length) {
        line += `. This branch CHANGES the repo's own rules or skills (${safeNames(b.guardrails)}); the working agreement and skills you are given are the base branch's versions. Review those changes with extra care and call them out in your report`;
      }
      if (b.tooling.length) {
        line += `. This branch also changes build/check tooling (${safeNames(b.tooling)}): read those changes before trusting a green check, and call them out in your report`;
      }
      return line;
    });
    const localSkillNote = ws.repos.map((r) => `/${repoLocalPluginName(r.repoName)}:<skill>`).join(', ');

    const prompt = [
      `The implementation for this run is committed and pushed on branch \`${run.branch_name}\` in every`,
      `WRITABLE repo of your workspace. Before the pull request is opened, run each repo's OWN pre-PR`,
      `review round and checks on that committed branch, and land the fixes. Repos:`,
      ...repoLines,
      ``,
      `For EACH writable repo, in turn:`,
      `1. Read its working agreement (CLAUDE.md and/or AGENTS.md, injected below as REPO WORKING`,
      `   AGREEMENTS, plus its .claude/rules). If it has a pre-PR review section (a section about what`,
      `   to do before opening a pull request — reviewers to run, readiness or preflight checks),`,
      `   follow it exactly: load the skills it names with the Skill tool, run the reviewers it`,
      `   describes, verify every finding against the code yourself, and land all accepted findings`,
      `   in exactly ONE fix commit in that repo (no commit when there is nothing to fix). Then run the`,
      `   deterministic checks it names and fix what they report in their own commit(s).`,
      `2. If it has no such section, run the generic round: the repo's own checks as its docs describe`,
      `   them (typecheck, lint, tests, build), then review \`git diff <merge base>...HEAD\` for`,
      `   correctness, security, and the repo's conventions, and fix real problems in one commit.`,
      ``,
      `Facts about this environment:`,
      `- It is unattended. Nobody answers a question, so never stop to ask one.`,
      `- Subagents only run in the FOREGROUND here: launch each with run_in_background: false and`,
      `  wait for its result. Where a skill says to run reviewers in the background or in parallel,`,
      `  run them one after another in the foreground instead; everything else in the skill applies.`,
      `- There is no GPG key. Commit with \`git commit -s\` (DCO sign-off) and never pass -S.`,
      `- Never use --no-verify, --force, or rewrite history. Never push and never open a pull request:`,
      `  the system pushes what you commit. Commit every fix yourself; edits you leave uncommitted are`,
      `  committed for you only if they touch tracked files, and new files are dropped.`,
      `- Each repo's own skills (its .claude/skills) are loaded as a plugin: a skill the agreement`,
      `  names as /x is invoked as the plugin-qualified name (${localSkillNote}). Shared skills from`,
      `  the project's skill sources keep their own plugin prefix. A skill you cannot find is an`,
      `  incomplete round, not something to work around.`,
      `- Never weaken, skip, or disable a check to make it pass. A failing check you cannot fix is an`,
      `  incomplete round. Do not change unrelated code.`,
      ``,
      `Finish with a short report: per repo, the reviewers and checks you ran, the findings you`,
      `accepted and rejected (with the reason), and the fix commit sha or "no fix needed". Then the`,
      `LAST line of your final message must be exactly \`RESULT: ok\` when every repo's round completed, or`,
      `\`RESULT: incomplete: <why>\` when any part of it could not be completed (a named skill that`,
      `is missing, a reviewer that failed, a check you could not make pass).`,
    ].join('\n');

    const result = await runAgentSession(supabase, ctx, run, project, PHASE, {
      cwd: ws.root, prompt, repos: ws.repos, attempt, repoSkills: true,
      allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash', 'Skill', 'Agent'],
      systemAppend: 'Run each repo\'s own pre-PR review and checks on the committed branch; land fixes per its rules. Never use --no-verify or --force. Do not push or open PRs.',
    });
    const usage = { model: result?.modelUsed ?? project.model, engine: result?.engineUsed ?? 'claude', input: result?.tokensInput, output: result?.tokensOutput, cacheRead: result?.tokensCacheRead, cacheCreation: result?.tokensCacheCreation, cost: result?.costUSD, modelUsage: result?.modelUsage };
    if (result.error) {
      const msg = redactToken(result.error, token);
      if (result.costCeiling) return blockRun(supabase, run, PHASE, 'cost_ceiling', msg);
      await recordPhaseEnd(supabase, run, PHASE, 'failed', msg, usage);
      await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
      return { failed: msg };
    }

    // Push what the agent landed, repo by repo. Tracked edits it left uncommitted become the fix
    // commit (partial work is still worth keeping on the branch; untracked files are generated output
    // far more often than a forgotten fix, so they are dropped and listed); a clean tree that moved
    // past the clone point is pushed as-is. Both are signed off by the configured identity.
    let fixes = 0;
    const pushErrors = [];
    const untracked = {};
    for (const r of ws.repos.filter((x) => x.writable)) {
      const dirty = await hasChanges(r.dir);
      const ahead = dirty ? 0 : await commitsAhead(r.dir, r.startSha);
      if (!dirty && ahead === 0) continue;
      try {
        if (dirty) {
          const c = await commitTrackedAndPush(r.dir, run.branch_name, FIX_COMMIT_SUBJECT);
          if (c.untracked.length) untracked[`${r.repoOwner}/${r.repoName}`] = c.untracked.slice(0, 50);
          if (c.committed || (await commitsAhead(r.dir, r.startSha)) > 0) fixes++;
        } else {
          await pushBranch(r.dir, run.branch_name);
          fixes++;
        }
      } catch (e) {
        pushErrors.push(`${r.repoOwner}/${r.repoName}: ${redactToken(e?.message || String(e), token)}`);
      }
    }
    await supabase.from('se_runs').update({
      tokens_input: (run.tokens_input ?? 0) + (result.tokensInput ?? 0),
      tokens_output: (run.tokens_output ?? 0) + (result.tokensOutput ?? 0),
    }).eq('id', run.id);

    // New commits change the diff implement classified. Re-classify from the real branch diff (a
    // legitimately safe run stays safe; a fix that touched a sensitive path no longer auto-merges),
    // failing safe to needs_human when any compare is unavailable.
    if (fixes > 0) {
      const allFiles = [];
      let unknown = false;
      let files = 0, lines = 0;
      for (const r of ws.repos.filter((x) => x.writable)) {
        try {
          const cmp = await gitCompareCount(gh, r.repoOwner, r.repoName, r.baseBranch, run.branch_name);
          files += cmp.files; lines += cmp.lines; allFiles.push(...cmp.fileList);
        } catch { unknown = true; }
      }
      const blast = unknown
        ? { classification: 'needs_human', reasons: ['diff unavailable for one or more changed repos after the pre-PR fixes — cannot assess blast radius'] }
        : classifyBlastRadius(allFiles);
      await writeGate(supabase, run, 'blast_radius', blast.classification === 'safe' ? 'pass' : 'block', { files, lines, repos: ws.repos.length, after: PHASE });
      await supabase.from('se_runs').update({ blast_radius: blast.classification }).eq('id', run.id);
    }

    // The verdict comes from the main agent's final message. Only the codex runner, which has no
    // subagents, may fall back to the whole transcript; an in-process session whose main thread
    // never spoke has no verdict at all (fail-closed), rather than one borrowed from a reviewer.
    const verdictText = result.finalText ?? (result.engineUsed === 'codex' ? result.text : '');
    const verdict = parseResult(verdictText);
    const reasons = [];
    if (!verdict.ok) reasons.push(verdict.reason);
    if (pushErrors.length) reasons.push(`could not push the fixes: ${pushErrors.join('; ')}`);
    const detail = {
      repos: ws.repos.length, fixes,
      bases: Object.fromEntries(bases.map((b) => [b.repo, { base: b.base, merge_base: b.mergeBase, ...(b.fetchError ? { fetch_error: b.fetchError } : {}) }])),
      ...(Object.keys(guardrailsChanged).length ? { guardrails_changed: guardrailsChanged } : {}),
      ...(Object.keys(toolingChanged).length ? { tooling_changed: toolingChanged } : {}),
      ...(Object.keys(untracked).length ? { untracked_dropped: untracked } : {}),
    };
    if (reasons.length) {
      const reason = reasons.join('; ').slice(0, 800);
      await writeGate(supabase, run, GATE, 'block', { reason, ...detail });
      await recordPhaseEnd(supabase, run, PHASE, 'blocked', reason, usage);
      await supabase.from('se_runs').update({ status: 'blocked', error: `pre-PR review: ${reason}` }).eq('id', run.id);
      // A phase-verdict block (not kill_switch/authorization) bypasses blockRun(), so it emits its own
      // decision row the way verify does — the admin resumes the phase once the cause is fixed.
      try {
        await createOrSupersedeDecision(supabase, {
          runId: run.id, projectId: run.project_id, siteId: run.site_id, phase: PHASE,
          question: `pre-PR review: ${reason}`, kind: 'text', context: null, originKind: 'config_blocked',
        });
      } catch { /* best-effort — the Overview panel falls back to classifyDecision() if this row is missing */ }
      return { blocked: reason };
    }

    await writeGate(supabase, run, GATE, 'pass', detail);
    await recordPhaseEnd(supabase, run, PHASE, 'passed', fixes ? `review round complete; pushed fixes in ${fixes} repo(s)` : 'review round complete; no fixes needed', usage);
    await supabase.from('se_runs').update({ current_phase: 'verify' }).eq('id', run.id);
    await enqueuePhase(ctx, run.id, 'verify');
    return { ok: true, fixes };
  } catch (e) {
    const msg = redactToken(e?.message || String(e), token);
    await recordPhaseEnd(supabase, run, PHASE, 'failed', msg);
    await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
    return { failed: msg };
  } finally {
    try { await ws?.cleanup?.(); } catch { /* ignore */ }
  }
}
