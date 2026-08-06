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
import { parseOverrideLabels } from '../lib/model-select.js';

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
  // Per-run routing overrides from issue labels (agent:model:<alias|id> / agent:engine:<claude|codex>),
  // parsed ONCE here so later phases read them off the run row (lib/model-select.ts precedence).
  // AUTHZ: an override redirects the project's model/OpenAI spend, so it is only honored when the
  // person who APPLIED the label is trusted — allowed_labellers or the run's own labeller — resolved
  // from issue events exactly like intake-poll resolves the trigger labeller (webhook sender parity).
  // GitHub label-write (triage role) is a much broader set than allowed_labellers; the label's mere
  // presence proves nothing. Unresolvable applier → that label is ignored (fail closed).
  try {
    const issue = await gh.getIssue(run.repo_owner, run.repo_name, run.issue_number);
    // Reporter provenance (§7): the GitHub issue author reported this work. Match them to a gatewaze user
    // via the identity map (by GitHub login) so a later gate event can notify them. Best-effort.
    try {
      const login = issue?.user?.login ? String(issue.user.login) : null;
      if (login) {
        let reporterUserId = null;
        try {
          const { data: idm } = await supabase.from('se_identity_map').select('user_id').eq('github_login', login).limit(1).maybeSingle();
          reporterUserId = idm?.user_id ?? null;
        } catch { /* no identity map row */ }
        await supabase.from('se_runs').update({
          reporter_source: 'github', reporter_identity: login, reporter_display_name: login, reporter_user_id: reporterUserId,
        }).eq('id', run.id);
      }
    } catch { /* best-effort — reporter provenance is non-critical */ }
    const labels = (issue?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
    const overrideLabels = labels.filter((n) => n.startsWith('agent:model:') || n.startsWith('agent:engine:'));
    if (overrideLabels.length) {
      const trusted = (login) => !!login && (project.allowedLabellers.includes(login) || login === run.labeller);
      const events = await gh.listIssueEvents(run.repo_owner, run.repo_name, run.issue_number);
      const applier = {};
      for (const ev of events ?? []) {
        if (ev?.event === 'labeled' && ev?.label?.name && ev?.actor?.login) applier[ev.label.name] = ev.actor.login; // last event wins
      }
      const ov = parseOverrideLabels(overrideLabels.filter((n) => trusted(applier[n])));
      if (ov.model || ov.engine) {
        await supabase.from('se_runs').update({ model_override: ov.model ?? null, engine_override: ov.engine ?? null }).eq('id', run.id);
      }
    }
  } catch { /* best-effort — no overrides is the default */ }
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
