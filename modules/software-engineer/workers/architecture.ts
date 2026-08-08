// @ts-nocheck
/**
 * architecture phase (§7.6) — the architecture-review GATE. Runs after the spec is skeptic-approved,
 * but only for projects that configure `architecture_repo` (e.g. LFX → linuxfoundation/lfx-architecture-scratch).
 *
 * The agent reads this project's DEVELOPMENT PROCESS rules (injected by phase-runner) + the approved
 * spec, then decides whether the work is architecture-impacting per those rules. It has the ARCH repo
 * and the code repos read-only for context, and writes the proposal to a scratch file:
 *   - NOT architectural  → it writes nothing → we proceed straight to implement.
 *   - architectural      → it writes a proposal to ./PROPOSAL.md at the workspace root. We save that as a
 *                          DRAFT artifact (kind='architecture') and BLOCK the run at 'awaiting_architecture'.
 *                          Nothing is committed or PR'd here. A human reviews the draft in the admin, chats
 *                          with the agent to refine it (workers/architecture-refine.ts), then FINALIZES —
 *                          which commits the folder to the arch repo's main (admin-routes) — waits for the
 *                          external architectural review, and APPROVES to resume implementation.
 *
 * No Bash: the agent only reads context and writes a markdown proposal file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { getProject, getCodeRepos, resolveCommitIdentity } from '../lib/credentials.js';
import { enqueuePhase } from '../lib/enqueue.js';
import { githubClient } from '../lib/github.js';
import { makeMultiWorkspace } from '../lib/worktree.js';
import { runAgentSession } from '../lib/phase-runner.js';
import { redactToken } from '../lib/git.js';
import { recordPhaseStart, recordPhaseEnd, blockRun } from '../lib/run-state.js';
import { notifyGate } from '../lib/notify.js';
import { createOrSupersedeDecision, ARCHITECTURE_DECISION_OPTIONS } from '../lib/decisions.js';

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A dated, hyphenated proposal folder that matches the arch repo's convention, e.g.
 *  `2026-08-Sendgrid-Batched-Personalizations`. Derived deterministically from the run title (with any
 *  leading `[LFXV2-1234]` tracker prefix stripped) so the format is guaranteed, never left to the agent. */
function proposalFolder(run) {
  const d = new Date();
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const rawTitle = String(run.title ?? '').replace(/^\s*\[[A-Za-z]+-\d+\]\s*/, '').trim();
  const base = rawTitle || `Issue ${run.issue_number ?? run.id.slice(0, 8)}`;
  const slug = base
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-')
    .slice(0, 80)
    .replace(/-+$/, '');
  return `${ym}-${slug || 'Proposal'}`;
}

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
    // Arch repo + code repos BOTH read-only (reference only). The proposal is written to a scratch file at
    // the workspace root, not into any repo — the human commits it to the arch repo later on finalize.
    const repos = [
      { repoOwner: archOwner, repoName: archName, writeMode: 'read_only', baseBranch: archRef },
      ...codeRepos.map((r) => ({ ...r, writeMode: 'read_only' })),
    ];
    const branch = run.branch_name || `arch/issue-${run.issue_number ?? run.id.slice(0, 8)}`;
    const commitId = await resolveCommitIdentity(supabase, project, token);
    ws = await makeMultiWorkspace(repos, token, branch, commitId);

    const prompt = [
      `You are at the ARCHITECTURE-REVIEW gate for the work described in the approved spec below.`,
      `Read this project's DEVELOPMENT PROCESS rules (in your system prompt) and the approved spec.`,
      `Decide whether delivering this work requires a change to the ARCHITECTURE, using the criteria the`,
      `process rules define (typically: a new service/component, a new data store or schema, a new or`,
      `changed cross-service contract/API, a new external dependency, or an auth/tenancy/security-boundary`,
      `change). When unsure, treat it AS architectural — the review is cheap, an unreviewed arch change is not.`,
      ``,
      `- If it is NOT architectural: write NO files. Do nothing else.`,
      `- If it IS architectural: write ONE file, ./PROPOSAL.md at the workspace ROOT (NOT inside any repo`,
      `  subdirectory). The repos in this workspace are read-only reference only; look at sibling folders in`,
      `  the ./${archName}/ repo to match its house structure for a proposal README. Write a clear proposal:`,
      `  problem/context, the proposed architecture + alternatives considered, data-model/API/contract`,
      `  changes, and security & tenancy impact.`,
      ``,
      `WRITING RULES for the proposal (it is read by an external architecture team):`,
      `  1. Follow this project's process rules for HOW TO WRITE (the house writing style) exactly.`,
      `  2. Reference the tracking ticket the way the process rules require (e.g. a Jira link). Do NOT`,
      `     reference this internal GitHub issue or its repository anywhere in the proposal, and do NOT`,
      `     mention that an agent wrote it.`,
      `  3. Write the proposal content only. Do not include a decision line, front-matter, or meta commentary`,
      `     about being an agent or about this gate.`,
      ``,
      `--- APPROVED SPEC ---`,
      String(art?.content ?? '').slice(0, 20000),
      `--- END SPEC ---`,
    ].join('\n');

    const result = await runAgentSession(supabase, ctx, run, project, 'architecture', {
      cwd: ws.root, repos: ws.repos, prompt,
      allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
      attachments: false,
      systemAppend: 'You are gating on architecture, not implementing. All repos here are read-only reference. If the work is architectural, write your proposal to the single file ./PROPOSAL.md at the workspace root (this is outside every repo and is expected). Follow the project process rules\' writing style. Never reference the internal issue/repo or mention an agent in the proposal.',
    });
    if (result.error) {
      const msg = redactToken(result.error, token);
      await recordPhaseEnd(supabase, run, 'architecture', 'failed', msg, { model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude', input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead, cacheCreation: result.tokensCacheCreation, cost: result.costUSD, modelUsage: result.modelUsage });
      await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
      return { failed: msg };
    }

    // No proposal written → the agent judged the work non-architectural → proceed to implement.
    const proposalPath = join(ws.root, 'PROPOSAL.md');
    const proposal = existsSync(proposalPath) ? readFileSync(proposalPath, 'utf8') : '';
    if (proposal.trim().length < 200) {
      await recordPhaseEnd(supabase, run, 'architecture', 'passed', 'no architecture change required', { model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude', input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead, cacheCreation: result.tokensCacheCreation, cost: result.costUSD, modelUsage: result.modelUsage });
      await supabase.from('se_runs').update({ current_phase: 'implement' }).eq('id', run.id);
      await enqueuePhase(ctx, run.id, 'implement');
      return { ok: true, gated: false };
    }

    // Architectural → save the proposal as a DRAFT artifact and BLOCK for human review. Nothing is
    // committed or PR'd; the human refines it (chat) and later finalizes it onto the arch repo's main.
    const folder = proposalFolder(run);
    const path = `${folder}/README.md`;
    await supabase.from('se_artifacts').insert({
      run_id: run.id, site_id: run.site_id, phase: 'architecture', kind: 'architecture', content: proposal,
    });
    await supabase.from('se_runs').update({
      status: 'awaiting_architecture', current_phase: 'architecture',
      architecture_repo: archRepo, architecture_folder: folder, architecture_path: path,
      architecture_commit_url: null,
    }).eq('id', run.id);
    // Surface it on the triggering (internal) issue so the run is easy to find. This issue lives in the
    // project's private roadmap repo, so it is fine to describe the gate here — it is NOT LFX-visible.
    if (run.issue_number) {
      try { await gh.setStatusLabel(run.repo_owner, run.repo_name, run.issue_number, 'agent:in-review'); } catch { /* */ }
      try { await gh.postComment(run.repo_owner, run.repo_name, run.issue_number, `Architecture review required — a draft proposal is ready in the Software Engineer admin. Review and refine it there, then finalize to commit it to \`${archRepo}\` and approve to resume implementation.`); } catch { /* */ }
    }
    try { await notifyGate(project, run, 'Architecture proposal ready for review'); } catch { /* */ }
    try {
      await createOrSupersedeDecision(supabase, {
        runId: run.id, projectId: run.project_id, siteId: run.site_id, phase: 'architecture',
        question: 'An architecture proposal is ready for review. What should happen next?',
        kind: 'choice', options: ARCHITECTURE_DECISION_OPTIONS,
        // No commit URL yet at this point (draft, not finalized) — /architecture/finalize refreshes
        // this decision's context with the real commit URL once the human commits it.
        context: null,
      });
    } catch { /* best-effort — the Overview panel falls back to classifyDecision() if this row is missing */ }
    await recordPhaseEnd(supabase, run, 'architecture', 'blocked', 'awaiting architecture review (draft)', { model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude', input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead, cacheCreation: result.tokensCacheCreation, cost: result.costUSD, modelUsage: result.modelUsage });
    return { ok: true, gated: true, folder };
  } catch (e) {
    const msg = redactToken(e?.message || String(e), token);
    await recordPhaseEnd(supabase, run, 'architecture', 'failed', msg);
    await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
    return { failed: msg };
  } finally {
    try { await ws?.cleanup?.(); } catch { /* ignore */ }
  }
}
