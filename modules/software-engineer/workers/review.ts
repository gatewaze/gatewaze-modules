// @ts-nocheck
/**
 * review phase (§7). A FIXED, stateless adversarial skeptic — separate session from the author
 * (actor ≠ judge) — that can only PASS or BLOCK, never rewrite the spec. Reads the project's code
 * repos READ-ONLY to check the spec's claims. On block it loops back to spec (bounded) with
 * objections; retries exhausted → blocked (human).
 */
import { createClient } from '@supabase/supabase-js';
import { getProject, getCodeRepos } from '../lib/credentials.js';
import { enqueuePhase } from '../lib/enqueue.js';
import { githubClient } from '../lib/github.js';
import { makeMultiWorkspace } from '../lib/worktree.js';
import { runAgentSession } from '../lib/phase-runner.js';
import { redactToken } from '../lib/git.js';
import { recordPhaseStart, recordPhaseEnd, writeGate, blockRun } from '../lib/run-state.js';

const MAX_REVIEW_RETRIES = 2;

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

function parseVerdict(text) {
  const m = /VERDICT:\s*(pass|block)/i.exec(text || '');
  const verdict = m ? m[1].toLowerCase() : 'block'; // fail-closed
  const objections = [];
  if (verdict === 'block') {
    for (const line of (text || '').split('\n')) {
      const t = line.trim();
      if (/^[-*]\s+/.test(t)) objections.push(t.replace(/^[-*]\s+/, '').slice(0, 300));
    }
  }
  return { verdict, objections: objections.slice(0, 20), clear: Boolean(m) };
}

export default async function review(job, ctx) {
  const supabase = sb(ctx);
  const { data: run } = await supabase.from('se_runs').select('*').eq('id', job?.data?.runId).maybeSingle();
  if (!run) return { skipped: 'no run' };
  if (run.status === 'cancelled') return { skipped: 'cancelled' };
  const project = await getProject(supabase, run.project_id);
  if (!project?.intakeEnabled) return blockRun(supabase, run, 'review', 'kill_switch', 'intake disabled');
  const token = project.githubToken;

  await recordPhaseStart(supabase, run, 'review');
  const gh = githubClient(token);
  let ws;
  try {
    const { data: art } = await supabase.from('se_artifacts').select('content').eq('run_id', run.id).eq('kind', 'spec').order('created_at', { ascending: false }).limit(1).maybeSingle();
    const specText = art?.content ?? '';
    const codeRepos = (await getCodeRepos(supabase, run.project_id)).slice(0, project.maxCodeReposPerRun).map((r) => ({ ...r, writeMode: 'read_only' }));
    ws = await makeMultiWorkspace(codeRepos, token, run.branch_name || `agent/se-${run.issue_number}`);

    const prompt = [
      `You are a FIXED, ADVERSARIAL SPEC REVIEWER (a skeptic). You do NOT rewrite the spec.`,
      `Judge the SPEC below against the repos in your workspace (each repo's CLAUDE.md/.claude rules).`,
      `Try hard to REFUTE it: gaps, security holes, rule violations, unhandled edge cases, a wrong repo`,
      `target NAMED IN THE SPEC, risky assumptions. Read the repos (read-only) to check its claims.`,
      ``,
      `SCOPE — block ONLY on a defect IN THE SPEC ITSELF. This review workspace is READ-ONLY by design`,
      `(you are reviewing, not implementing); the absence of a writable checkout, read-only mounts, or`,
      `any other harness/environment detail is NOT a spec defect — never block on those. A minor note`,
      `or "would be nice" is NOT grounds to block. If the spec is correct, complete, rule-compliant and`,
      `implementable, you MUST PASS.`,
      ``, `--- SPEC ---`, specText.slice(0, 20000), `--- END SPEC ---`, ``,
      `Output your verdict on the LAST line: \`VERDICT: pass\` if the spec is sound to implement, else`,
      `\`VERDICT: block\`. If blocking, list each SPEC defect as a "- " bullet ABOVE the verdict line.`,
    ].join('\n');

    const result = await runAgentSession(supabase, ctx, run, project, 'review', {
      cwd: ws.root, prompt, repos: ws.repos, allowedTools: ['Read', 'Grep', 'Glob'],
      systemAppend: 'You are a skeptic. You can only PASS or BLOCK; never rewrite the spec.',
    });
    if (result.error) {
      const msg = redactToken(result.error, token);
      await recordPhaseEnd(supabase, run, 'review', 'failed', msg);
      await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
      return { failed: msg };
    }

    const { verdict, objections, clear } = parseVerdict(result.text);
    await writeGate(supabase, run, 'adversarial_review', verdict === 'pass' ? 'pass' : 'block', { objections, clear, retry: run.retry_count });
    await supabase.from('se_runs').update({
      tokens_input: (run.tokens_input ?? 0) + result.tokensInput,
      tokens_output: (run.tokens_output ?? 0) + result.tokensOutput,
    }).eq('id', run.id);

    if (verdict === 'pass') {
      await recordPhaseEnd(supabase, run, 'review', 'passed', 'spec approved by skeptic', { model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude', input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead, cacheCreation: result.tokensCacheCreation, cost: result.costUSD });
      // §7.6: if this project has an architecture-review gate, route through the `architecture` phase
      // first (it decides arch-impact and, if impacting, opens a proposal PR + blocks). External-PR
      // runs (Connect) have no spec to gate — they skip straight to implement. Otherwise → implement.
      const next = project.architectureRepo && run.kind !== 'external_pr' ? 'architecture' : 'implement';
      await supabase.from('se_runs').update({ current_phase: next }).eq('id', run.id);
      await enqueuePhase(ctx, run.id, next);
      return { ok: true, verdict, next };
    }

    await recordPhaseEnd(supabase, run, 'review', 'blocked', `skeptic blocked: ${objections.slice(0, 3).join('; ')}`);
    if ((run.retry_count ?? 0) < MAX_REVIEW_RETRIES) {
      await supabase.from('se_runs').update({ retry_count: (run.retry_count ?? 0) + 1, current_phase: 'spec' }).eq('id', run.id);
      await enqueuePhase(ctx, run.id, 'spec', { objections });
      return { ok: true, verdict, retry: true };
    }
    try { await gh.setStatusLabel(run.repo_owner, run.repo_name, run.issue_number, 'agent:blocked'); } catch { /* best-effort */ }
    try { await gh.postComment(run.repo_owner, run.repo_name, run.issue_number, `Spec still blocked after ${MAX_REVIEW_RETRIES} revisions — needs human input. Objections:\n${objections.map((o) => `- ${o}`).join('\n')}`); } catch { /* best-effort */ }
    await supabase.from('se_runs').update({ status: 'blocked', error: 'adversarial review blocked (retries exhausted)' }).eq('id', run.id);
    return { blocked: true };
  } catch (e) {
    const msg = redactToken(e?.message || String(e), token);
    await recordPhaseEnd(supabase, run, 'review', 'failed', msg);
    await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
    return { failed: msg };
  } finally {
    try { await ws?.cleanup?.(); } catch { /* ignore */ }
  }
}
