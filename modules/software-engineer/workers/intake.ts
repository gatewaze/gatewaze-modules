// @ts-nocheck
/**
 * intake phase. The run's repo_owner/repo_name is the project's ISSUES repo (§2). Authorize, mark the
 * issue in-progress + claimed by this instance (§2.1/§12.5), ack it, and enqueue spec. Code-repo
 * agent-contracts (CLAUDE.md) are checked implicitly by the agent reading them in the workspace.
 */
import { createClient } from '@supabase/supabase-js';
import { getProject } from '../lib/credentials.js';
import { enqueuePhase } from '../lib/enqueue.js';
import { githubClient } from '../lib/github.js';
import { recordPhaseStart, recordPhaseEnd, writeGate, blockRun } from '../lib/run-state.js';

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

export default async function intake(job, ctx) {
  const supabase = sb(ctx);
  const { data: run } = await supabase.from('se_runs').select('*').eq('id', job?.data?.runId).maybeSingle();
  if (!run) return { skipped: 'no run' };
  if (run.status === 'cancelled') return { skipped: 'cancelled' };

  const project = await getProject(supabase, run.project_id);
  if (!project?.intakeEnabled) return blockRun(supabase, run, 'intake', 'kill_switch', 'intake disabled');
  if (!project.githubToken) return blockRun(supabase, run, 'intake', 'authorization', 'project GitHub credential missing');

  await recordPhaseStart(supabase, run, 'intake');
  await writeGate(supabase, run, 'authorization', 'pass', { labeller: run.labeller, instance: run.instance_id });

  const gh = githubClient(project.githubToken);
  // Reflect status on the issue + finalize the claim (§2.1, §12.5). run.repo_* is the issues repo.
  try { await gh.setStatusLabel(run.repo_owner, run.repo_name, run.issue_number, 'agent:in-progress'); } catch { /* best-effort */ }
  try {
    const inst = run.instance_id ? `agent:claimed@${run.instance_id}` : 'agent:claimed';
    await gh.addLabels(run.repo_owner, run.repo_name, run.issue_number, [inst]);
  } catch { /* best-effort */ }
  try {
    await gh.postComment(run.repo_owner, run.repo_name, run.issue_number,
      `Picked up by a Software Engineer agent${run.engineer_name ? ` (${run.engineer_name})` : ''}. Drafting a spec — watch it live in the admin.`);
  } catch { /* best-effort */ }

  await recordPhaseEnd(supabase, run, 'intake', 'passed', 'authorized + claimed');
  await supabase.from('se_runs').update({ status: 'running', current_phase: 'spec' }).eq('id', run.id);
  await enqueuePhase(ctx, run.id, 'spec');
  return { ok: true };
}
