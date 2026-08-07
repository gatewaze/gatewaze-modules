// @ts-nocheck
/**
 * architecture-refine — applies the human's chat feedback to a run's architecture proposal while it is
 * parked at the gate (status 'awaiting_architecture' = draft, or 'architecture_in_review' = committed).
 *
 * It is a SHORT, re-runnable job, not a live session, so it survives pod restarts and holds no slot while
 * the external review takes days. The admin message route stores each admin message (delivered_at=null)
 * and enqueues this job. When it runs it drains the mailbox — every undelivered admin message for the run
 * — applies them together to the latest draft, saves the new draft as a fresh artifact, and posts the
 * agent's summary back. If the proposal is already committed to the arch repo's main
 * ('architecture_in_review'), it also re-commits the updated README to main so the reviewers see the change.
 *
 * No Bash: the agent only reads context and edits the one proposal file.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { getProject, getCodeRepos, resolveCommitIdentity } from '../lib/credentials.js';
import { githubClient } from '../lib/github.js';
import { makeMultiWorkspace } from '../lib/worktree.js';
import { runAgentSession } from '../lib/phase-runner.js';
import { redactToken } from '../lib/git.js';
import { writeMessage, touchRun, recordPhaseEnd, nextPhaseAttempt } from '../lib/run-state.js';

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const ARCH_STATES = ['awaiting_architecture', 'architecture_in_review'];
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function latestProposal(supabase, runId) {
  const { data } = await supabase.from('se_artifacts').select('content').eq('run_id', runId).eq('kind', 'architecture').order('created_at', { ascending: false }).limit(1).maybeSingle();
  return String(data?.content ?? '');
}

export default async function architectureRefine(job, ctx) {
  const supabase = sb(ctx);
  const { data: run } = await supabase.from('se_runs').select('*').eq('id', job?.data?.runId).maybeSingle();
  if (!run) return { skipped: 'no run' };
  if (run.archived_at || run.status === 'cancelled') return { skipped: 'inactive' };
  if (!ARCH_STATES.includes(run.status)) return { skipped: `status ${run.status}` };

  // Drain the mailbox: every admin message not yet applied. Nothing to do → exit (a duplicate/late enqueue).
  const { data: pending } = await supabase.from('se_messages')
    .select('id, content, created_at').eq('run_id', run.id).eq('role', 'admin').is('delivered_at', null)
    .order('created_at', { ascending: true });
  if (!pending || pending.length === 0) return { skipped: 'no pending feedback' };

  const project = await getProject(supabase, run.project_id);
  const token = project?.githubToken;
  if (!project?.intakeEnabled || !token || !project.modelCred) {
    try { await writeMessage(supabase, run, 'system', 'Cannot refine: the project is disabled or missing credentials.'); } catch { /* */ }
    return { skipped: 'not runnable' };
  }
  const current = await latestProposal(supabase, run.id);
  if (!current.trim()) {
    try { await writeMessage(supabase, run, 'system', 'Cannot refine: no draft proposal was found for this run.'); } catch { /* */ }
    return { skipped: 'no draft' };
  }

  const archRepo = String(run.architecture_repo ?? '').trim();
  const [archOwner, archName] = REPO_RE.test(archRepo) ? archRepo.split('/') : [null, null];
  const feedback = pending.map((m, i) => `${i + 1}. ${String(m.content ?? '').trim()}`).join('\n');

  await touchRun(supabase, run);
  let ws;
  try {
    const codeRepos = archOwner
      ? (await getCodeRepos(supabase, run.project_id)).slice(0, project.maxCodeReposPerRun)
      : [];
    const repos = [
      ...(archOwner ? [{ repoOwner: archOwner, repoName: archName, writeMode: 'read_only', baseBranch: String(project.architectureRef ?? '') || 'main' }] : []),
      ...codeRepos.map((r) => ({ ...r, writeMode: 'read_only' })),
    ];
    const commitId = await resolveCommitIdentity(supabase, project, token);
    ws = await makeMultiWorkspace(repos, token, run.branch_name || `arch/refine-${run.id.slice(0, 8)}`, commitId);
    // Seed the current draft so the agent edits in place.
    writeFileSync(join(ws.root, 'PROPOSAL.md'), current, 'utf8');

    const prompt = [
      `You are refining an architecture proposal that is under review. The current proposal is the file`,
      `./PROPOSAL.md at the workspace root. The reviewer has asked for the following change(s):`,
      ``,
      feedback,
      ``,
      `Apply the requested change(s) by EDITING ./PROPOSAL.md in place. Keep everything the reviewer did not`,
      `ask to change. Follow this project's process rules for the house writing style, keep the tracking-ticket`,
      `reference the way the process rules require, and never reference the internal issue/repo or mention an`,
      `agent. The repos in this workspace are read-only reference only. When done, reply with one or two plain`,
      `sentences describing what you changed.`,
    ].join('\n');

    const result = await runAgentSession(supabase, ctx, run, project, 'architecture', {
      cwd: ws.root, repos: ws.repos, prompt,
      allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'],
      attachments: false,
      systemAppend: 'Refining an architecture proposal under review. Edit only ./PROPOSAL.md at the workspace root; all repos are read-only reference. Follow the project process rules\' writing style.',
    });
    if (result.error) {
      const msg = redactToken(result.error, token);
      try { await writeMessage(supabase, run, 'system', `Could not apply the change: ${msg}`); } catch { /* */ }
      return { failed: msg };
    }

    // Attribute this refine's token spend (main + subagents, via modelUsage) as its own costed record.
    try {
      await recordPhaseEnd(supabase, run, 'architecture-refine', 'passed', 'refined proposal under review', {
        model: result.modelUsed ?? project.model, engine: result.engineUsed ?? 'claude',
        input: result.tokensInput, output: result.tokensOutput, cacheRead: result.tokensCacheRead,
        cacheCreation: result.tokensCacheCreation, cost: result.costUSD, modelUsage: result.modelUsage,
        attempt: await nextPhaseAttempt(supabase, run.id, 'architecture-refine'),
      });
    } catch { /* cost tracking is best-effort — never fail a refine over it */ }

    const updatedPath = join(ws.root, 'PROPOSAL.md');
    const updated = existsSync(updatedPath) ? readFileSync(updatedPath, 'utf8') : '';
    // No usable edit → leave the mailbox undelivered so a retry/next message can try again.
    if (updated.trim().length < 200) {
      try { await writeMessage(supabase, run, 'system', 'The refine step produced no usable change; the draft is unchanged.'); } catch { /* */ }
      return { skipped: 'no change produced' };
    }

    // Persist the new draft version.
    await supabase.from('se_artifacts').insert({
      run_id: run.id, site_id: run.site_id, phase: 'architecture', kind: 'architecture', content: updated,
    });
    // If already committed to the arch repo's main, re-commit the updated README so reviewers see it.
    let commitUrl = run.architecture_commit_url ?? null;
    if (run.status === 'architecture_in_review' && archOwner && run.architecture_path) {
      try {
        const res = await githubClient(token).putFile(archOwner, archName, run.architecture_path, updated, `Update architecture proposal: ${run.architecture_folder ?? run.architecture_path}`);
        commitUrl = res?.content?.html_url ?? commitUrl;
        await supabase.from('se_runs').update({ architecture_commit_url: commitUrl }).eq('id', run.id);
      } catch (e) {
        try { await writeMessage(supabase, run, 'system', `Saved the draft, but re-committing to the architecture repo failed: ${redactToken(e?.message || String(e), token)}`); } catch { /* */ }
      }
    }
    // Mark the applied messages delivered + post the agent's summary.
    await supabase.from('se_messages').update({ delivered_at: new Date().toISOString() }).in('id', pending.map((m) => m.id));
    const summary = String(result.text ?? '').trim() || 'Updated the proposal as requested.';
    try { await writeMessage(supabase, run, 'agent', run.status === 'architecture_in_review' && commitUrl ? `${summary}\n\nRe-committed to \`${archRepo}\`.` : summary); } catch { /* */ }
    await touchRun(supabase, run);
    return { ok: true, applied: pending.length, recommitted: run.status === 'architecture_in_review' };
  } catch (e) {
    const msg = redactToken(e?.message || String(e), token);
    try { await writeMessage(supabase, run, 'system', `Refine failed: ${msg}`); } catch { /* */ }
    return { failed: msg };
  } finally {
    try { await ws?.cleanup?.(); } catch { /* ignore */ }
  }
}
