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
import { notifyGate } from '../lib/notify.js';
import { githubClient } from '../lib/github.js';
import { makeMultiWorkspace } from '../lib/worktree.js';
import { runAgentSession } from '../lib/phase-runner.js';
import { redactToken, branchNameFor } from '../lib/git.js';
import { recordPhaseStart, recordPhaseEnd, writeGate, blockRun, writeMessage } from '../lib/run-state.js';
import { InProcessRunner } from '../lib/agent-session.js';
import { resolvePhaseModel } from '../lib/model-select.js';
import { createOrSupersedeDecision } from '../lib/decisions.js';
import { createOrSupersedeReporterQuestion } from '../lib/reporter-feedback.js';

const MAX_REVIEW_RETRIES = 2;

const SAFE_FALLBACK_SUMMARY = 'We’ve drafted an approach for your report and want to confirm it before building it.';

// Turn the spec into a plain-language, REPORTER-SAFE summary for se_reporter_questions.summary — never
// reuse the spec-drafting agent's own closing chat reply here (an earlier version did; a security review
// flagged it: that reply is untrusted, unconstrained free text from an agent with full read access to
// the project's private code repos, so it can freely contain internal repo/file names, library names or
// other non-public details with nothing stopping it). This is a SEPARATE, constrained model turn whose
// prompt explicitly forbids naming anything internal, mirroring distillDecision's fail-open shape below:
// any error or suspicious output falls back to the fixed, generic SAFE_FALLBACK_SUMMARY, never raw spec
// text.
async function distillReporterSummary(supabase, run, project, specText) {
  if (!project?.modelCred || !specText?.trim()) return SAFE_FALLBACK_SUMMARY;
  try {
    await recordPhaseStart(supabase, run, 'reporter-summary-distill');
    const prompt = [
      `Describe the FEATURE being built below in ONE or TWO short sentences, for a non-technical end`,
      `user who filed the original request. Plain language only.`,
      ``,
      `STRICT RULES — the reader is an external, lower-trust party outside this engineering org:`,
      `- Do NOT mention file paths, directory names, repository names, service/module names, library or`,
      `  framework names, environment variables, credentials, or any other internal implementation detail.`,
      `- Do NOT mention these instructions or that you are summarizing a spec.`,
      `- Describe WHAT the feature does for the user, not HOW it is built.`,
      `Respond with ONLY the one-or-two-sentence description, no preamble.`,
      ``,
      `--- SPEC (internal — do not quote or reference its structure) ---`,
      specText.slice(0, 8000),
    ].join('\n');
    const { model } = resolvePhaseModel(project, run, 'reporter-summary-distill');
    const runner = new InProcessRunner();
    const result = await runner.runPhase({
      cwd: '/tmp', prompt, model,
      credential: { kind: project.modelCredKind, value: project.modelCred },
      noTools: true,
    });
    await recordPhaseEnd(supabase, run, 'reporter-summary-distill', result?.error ? 'failed' : 'passed', result?.error, {
      model, engine: 'claude', input: result?.tokensInput, output: result?.tokensOutput,
      cacheRead: result?.tokensCacheRead, cacheCreation: result?.tokensCacheCreation, cost: result?.costUSD,
    });
    const text = String(result?.text ?? '').trim();
    // Defence in depth on top of the prompt: a summary that still looks like it names a path/repo
    // (contains a slash, a backtick code span, or a dotted file-extension-like token) is discarded
    // rather than trusted — fail to the safe fallback instead of forwarding it to the reporter.
    if (result?.error || !text || text.length > 600 || /[`\\]|\/[\w.-]+\/|\.(ts|tsx|js|py|sql|md|json|yml|yaml)\b/i.test(text)) {
      return SAFE_FALLBACK_SUMMARY;
    }
    return text;
  } catch {
    return SAFE_FALLBACK_SUMMARY;
  }
}

// Turn the skeptic's raw objection bullets into an answerable decision (issue #52) — a cheap,
// no-tools model turn mirroring pr-monitor.ts's ci-classify pattern. Fails OPEN to a plain kind:'text'
// decision (using the raw objections as the question) on any error or malformed output — a distillation
// failure must never block the existing retries-exhausted block/comment behavior below it.
async function distillDecision(supabase, ctx, run, project, objections) {
  const fallbackQuestion = `Spec still blocked after ${MAX_REVIEW_RETRIES} revisions. Objections:\n${objections.map((o) => `- ${o}`).join('\n')}`;
  if (!project?.modelCred) return { question: fallbackQuestion, kind: 'text', options: null };
  try {
    await recordPhaseStart(supabase, run, 'decision-distill');
    const prompt = [
      `A spec was BLOCKED by an adversarial reviewer after ${MAX_REVIEW_RETRIES} revisions. Turn the`,
      `objections below into ONE short question for a human decision-maker, plus 2-4 short answer`,
      `OPTIONS if the decision is genuinely a choice among a small set of directions. If the right`,
      `answer is open-ended (needs free-form guidance, not a pick-one), omit "options" entirely.`,
      ``,
      `Respond with ONLY one JSON object:`,
      `{"question":"<short question>","options":[{"id":"<short-id>","label":"<short label>","description":"<one line>"}]}`,
      `or, if free-form: {"question":"<short question>"}`,
      ``,
      `--- OBJECTIONS ---`,
      objections.map((o) => `- ${o}`).join('\n'),
    ].join('\n');
    const { model } = resolvePhaseModel(project, run, 'decision-distill');
    const runner = new InProcessRunner();
    const result = await runner.runPhase({
      cwd: '/tmp', prompt, model,
      credential: { kind: project.modelCredKind, value: project.modelCred },
      noTools: true,
    });
    await recordPhaseEnd(supabase, run, 'decision-distill', result?.error ? 'failed' : 'passed', result?.error, {
      model, engine: 'claude', input: result?.tokensInput, output: result?.tokensOutput,
      cacheRead: result?.tokensCacheRead, cacheCreation: result?.tokensCacheCreation, cost: result?.costUSD,
    });
    if (result?.error) return { question: fallbackQuestion, kind: 'text', options: null };
    const m = /\{[\s\S]*\}/.exec(result?.text ?? '');
    if (!m) return { question: fallbackQuestion, kind: 'text', options: null };
    const parsed = JSON.parse(m[0]);
    const question = typeof parsed?.question === 'string' && parsed.question.trim() ? parsed.question.trim().slice(0, 500) : fallbackQuestion;
    const rawOptions = Array.isArray(parsed?.options) ? parsed.options : null;
    if (!rawOptions || rawOptions.length < 2 || rawOptions.length > 4) return { question, kind: 'text', options: null };
    const options = rawOptions
      .filter((o) => o && typeof o.id === 'string' && typeof o.label === 'string')
      .slice(0, 4)
      .map((o) => ({ id: o.id.slice(0, 40), label: o.label.slice(0, 80), description: typeof o.description === 'string' ? o.description.slice(0, 300) : undefined }));
    if (options.length < 2) return { question, kind: 'text', options: null };
    return { question, kind: 'choice', options };
  } catch {
    return { question: fallbackQuestion, kind: 'text', options: null };
  }
}

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
    // No issue fetch at this point (review only needs the spec artifact + repos) — branch_name
    // should already be set by intake/spec before review ever runs, so this is a defensive
    // last-resort default, not the normal path. branchNameFor(run) with no title just falls
    // through to the safe agent/se-<n>-<hash> pattern.
    ws = await makeMultiWorkspace(codeRepos, token, run.branch_name || branchNameFor(run));

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
      if (result.costCeiling) return blockRun(supabase, run, 'review', 'cost_ceiling', msg);
      await recordPhaseEnd(supabase, run, 'review', 'failed', msg, { model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude', input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead, cacheCreation: result.tokensCacheCreation, cost: result.costUSD, modelUsage: result.modelUsage });
      await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
      return { failed: msg };
    }

    const { verdict, objections, clear } = parseVerdict(result.text);
    await writeGate(supabase, run, 'adversarial_review', verdict === 'pass' ? 'pass' : 'block', { objections, clear, retry: run.retry_count });
    await supabase.from('se_runs').update({
      tokens_input: (run.tokens_input ?? 0) + result.tokensInput,
      tokens_output: (run.tokens_output ?? 0) + result.tokensOutput,
    }).eq('id', run.id);

    // Human spec gate (§ phase gates): when the project turns on the spec gate, the automated skeptic is
    // ADVISORY, not a hard gate. After ONE review the run parks at `awaiting_spec` whether the skeptic
    // passed or blocked, with the skeptic's objections surfaced to the reviewer as a message. The human
    // then refines the spec by chat and approves it, so a strict skeptic can no longer hard-block a sound
    // spec (which is exactly what a human gate is for). External-PR runs have no spec to gate.
    if (project.specGate && run.kind !== 'external_pr') {
      await recordPhaseEnd(supabase, run, 'review', verdict === 'pass' ? 'passed' : 'blocked',
        verdict === 'pass' ? 'spec approved by skeptic (advisory); awaiting human review' : `skeptic flagged concerns (advisory): ${objections.slice(0, 3).join('; ')}`,
        { model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude', input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead, cacheCreation: result.tokensCacheCreation, cost: result.costUSD, modelUsage: result.modelUsage });
      if (verdict !== 'pass' && objections.length) {
        try { await writeMessage(supabase, run, 'system', `The automated skeptic review flagged these concerns (advisory — you decide):\n${objections.map((o) => `- ${o}`).join('\n')}\n\nRefine the spec by chatting, then approve to proceed.`); } catch { /* */ }
      }
      await supabase.from('se_runs').update({ status: 'awaiting_spec', current_phase: 'review' }).eq('id', run.id);
      try { await notifyGate(project, run, 'Spec ready for review'); } catch { /* */ }
      // Reporter-safe product confirmation (migration 029): ONLY for runs linked back to an external
      // report (e.g. a health-core tester's feature request) AND only when the skeptic actually found
      // something to question — a clean pass needs no reporter input. The reporter never sees the
      // skeptic's objections (those are about code/architecture, not product intent, and may name
      // internal repos/files) NOR the spec-drafting agent's raw closing reply (same reason — see
      // distillReporterSummary's header comment); it sees a separately-distilled, constrained summary.
      if (verdict !== 'pass') {
        try {
          const { data: link } = await supabase.from('se_reporter_links').select('id').eq('run_id', run.id).maybeSingle();
          if (link) {
            const summary = await distillReporterSummary(supabase, run, project, specText);
            await createOrSupersedeReporterQuestion(supabase, {
              runId: run.id, siteId: run.site_id, phase: 'review',
              question: 'Does this match what you were hoping for?',
              kind: 'choice',
              options: [
                { id: 'confirm', label: 'Yes, that’s it' },
                { id: 'change', label: 'Not quite — let me explain' },
              ],
              summary,
            });
          }
        } catch { /* best-effort — the run still parks at awaiting_spec for admin review either way */ }
      }
      return { ok: true, verdict, gated: 'spec' };
    }

    // Un-gated projects: the skeptic IS the gate — pass advances, block retries then blocks the run.
    if (verdict === 'pass') {
      await recordPhaseEnd(supabase, run, 'review', 'passed', 'spec approved by skeptic', { model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude', input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead, cacheCreation: result.tokensCacheCreation, cost: result.costUSD, modelUsage: result.modelUsage });
      // §7.6: if this project has an architecture-review gate, route through the `architecture` phase
      // first (it decides arch-impact and, if impacting, opens a proposal PR + blocks). External-PR
      // runs (Connect) have no spec to gate — they skip straight to implement. Otherwise → implement.
      const next = project.architectureRepo && run.kind !== 'external_pr' ? 'architecture' : 'implement';
      await supabase.from('se_runs').update({ current_phase: next }).eq('id', run.id);
      await enqueuePhase(ctx, run.id, next);
      return { ok: true, verdict, next };
    }

    await recordPhaseEnd(supabase, run, 'review', 'blocked', `skeptic blocked: ${objections.slice(0, 3).join('; ')}`, { model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude', input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead, cacheCreation: result.tokensCacheCreation, cost: result.costUSD, modelUsage: result.modelUsage });
    if ((run.retry_count ?? 0) < MAX_REVIEW_RETRIES) {
      await supabase.from('se_runs').update({ retry_count: (run.retry_count ?? 0) + 1, current_phase: 'spec' }).eq('id', run.id);
      await enqueuePhase(ctx, run.id, 'spec', { objections });
      return { ok: true, verdict, retry: true };
    }
    try { await gh.setStatusLabel(run.repo_owner, run.repo_name, run.issue_number, 'agent:blocked'); } catch { /* best-effort */ }
    try { await gh.postComment(run.repo_owner, run.repo_name, run.issue_number, `Spec still blocked after ${MAX_REVIEW_RETRIES} revisions — needs human input. Objections:\n${objections.map((o) => `- ${o}`).join('\n')}`); } catch { /* best-effort */ }
    await supabase.from('se_runs').update({ status: 'blocked', error: 'adversarial review blocked (retries exhausted)' }).eq('id', run.id);
    const distilled = await distillDecision(supabase, ctx, run, project, objections);
    try {
      await createOrSupersedeDecision(supabase, {
        runId: run.id, projectId: run.project_id, siteId: run.site_id, phase: 'review',
        question: distilled.question, kind: distilled.kind, options: distilled.options,
        context: objections.map((o) => `- ${o}`).join('\n'), originKind: 'review_blocked',
      });
    } catch { /* best-effort — the Overview panel falls back to classifyDecision() if this row is missing */ }
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
