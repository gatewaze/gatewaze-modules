// @ts-nocheck
/**
 * intake phase. The run's repo_owner/repo_name is the project's ISSUES repo (§2). Authorize, mark the
 * issue in-progress + claimed by this instance (§2.1/§12.5), ack it, and enqueue spec. Code-repo
 * agent-contracts (CLAUDE.md) are checked implicitly by the agent reading them in the workspace.
 *
 * Locally-authored spec handoff: an issue labelled agent:spec:provided carries its own spec in the
 * body (lib/provided-spec.ts). Intake stores it as the run's kind='spec' artifact, records the spec
 * + self-review phases as skipped (never billed), and parks the run at the awaiting_spec human gate
 * regardless of the project's gates config; agent:spec:approved (with provided) skips the gate and
 * goes straight to architecture/implement. A spec label without an extractable spec FAILS the run.
 */
import { createClient } from '@supabase/supabase-js';
import { getProject } from '../lib/credentials.js';
import { enqueuePhase } from '../lib/enqueue.js';
import { githubClient } from '../lib/github.js';
import { notifyGate } from '../lib/notify.js';
import { writeSpecMemory } from '../lib/memory.js';
import { recordPhaseStart, recordPhaseEnd, writeGate, writeMessage, blockRun } from '../lib/run-state.js';
import { parseOverrideLabels } from '../lib/model-select.js';
import { isTrustedFeedbackAuthor } from '../lib/feedback-authz.js';
import { parseSpecLabels, extractProvidedSpec, SPEC_PROVIDED_LABEL, SPEC_APPROVED_LABEL } from '../lib/provided-spec.js';

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
  // One issue fetch feeds three consumers: reporter provenance (best-effort), per-run routing
  // overrides (best-effort), and the provided-spec handoff (fail-loud — see below).
  let issue = null;
  let issueLabels = [];
  try {
    issue = await gh.getIssue(run.repo_owner, run.repo_name, run.issue_number);
    issueLabels = (issue?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
  } catch { /* best-effort — overrides/provenance simply don't apply; provided-spec re-checks below */ }
  // Per-run routing overrides from issue labels (agent:model:<alias|id> / agent:engine:<claude|codex>),
  // parsed ONCE here so later phases read them off the run row (lib/model-select.ts precedence).
  // AUTHZ: an override redirects the project's model/OpenAI spend, so it is only honored when the
  // person who APPLIED the label is trusted — allowed_labellers or the run's own labeller — resolved
  // from issue events exactly like intake-poll resolves the trigger labeller (webhook sender parity).
  // GitHub label-write (triage role) is a much broader set than allowed_labellers; the label's mere
  // presence proves nothing. Unresolvable applier → that label is ignored (fail closed).
  try {
    if (!issue) throw new Error('no issue');
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
    const overrideLabels = issueLabels.filter((n) => n.startsWith('agent:model:') || n.startsWith('agent:engine:'));
    if (overrideLabels.length) {
      const trusted = (login) => isTrustedFeedbackAuthor(login, project, run);
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

  // Locally-authored spec handoff (lib/provided-spec.ts): agent:spec:provided means the issue body
  // carries the spec; agent:spec:approved (only valid alongside provided) additionally skips the
  // human gate. UNLIKE the override labels above, this path fails LOUD — a spec label with no
  // extractable spec must never silently fall through to the (billed) spec phase the author was
  // explicitly opting out of.
  const specLabels = parseSpecLabels(issueLabels);
  if (specLabels.provided || specLabels.approved) {
    // AUTHZ (same fail-closed rule as the override labels above — the label's mere presence proves
    // nothing): a spec label skips billed phases and, with :approved, the human gate itself, so it
    // is honored only when the person who APPLIED it is trusted — allowed_labellers or the run's
    // own labeller — resolved from issue events. Untrusted or unresolvable applier → that label is
    // ignored and the run takes the classic authored-spec path (never a silent gate skip).
    try {
      const rawFor = (canonical) => issueLabels.filter((n) => String(n).trim().toLowerCase() === canonical);
      const trusted = (login) => isTrustedFeedbackAuthor(login, project, run);
      const events = await gh.listIssueEvents(run.repo_owner, run.repo_name, run.issue_number);
      const applier = {};
      for (const ev of events ?? []) {
        if (ev?.event === 'labeled' && ev?.label?.name && ev?.actor?.login) applier[ev.label.name] = ev.actor.login; // last event wins
      }
      specLabels.provided = specLabels.provided && rawFor(SPEC_PROVIDED_LABEL).some((n) => trusted(applier[n]));
      specLabels.approved = specLabels.approved && rawFor(SPEC_APPROVED_LABEL).some((n) => trusted(applier[n]));
    } catch {
      specLabels.provided = false;
      specLabels.approved = false;
    }
  }
  let providedSpec = null;
  if (specLabels.provided || specLabels.approved) {
    const failIntake = async (msg) => {
      try {
        await gh.postComment(run.repo_owner, run.repo_name, run.issue_number,
          `Cannot start this run: ${msg}. Fix the issue body (or labels) and re-apply the trigger label to retry.`);
      } catch { /* best-effort */ }
      await recordPhaseEnd(supabase, run, 'intake', 'failed', msg);
      await supabase.from('se_runs').update({ status: 'failed', error: msg }).eq('id', run.id);
      return { failed: msg };
    };
    if (!issue) return failIntake(`the issue carries a ${SPEC_PROVIDED_LABEL}/${SPEC_APPROVED_LABEL} label but the issue body could not be fetched`);
    if (specLabels.approved && !specLabels.provided) {
      return failIntake(`${SPEC_APPROVED_LABEL} requires ${SPEC_PROVIDED_LABEL} — apply both labels and include the spec in the issue body`);
    }
    const extracted = extractProvidedSpec(issue.body);
    if (extracted.error) return failIntake(`${SPEC_PROVIDED_LABEL}: ${extracted.error}`);
    providedSpec = extracted;
  }

  // Reflect status on the issue + finalize the claim (§2.1, §12.5). run.repo_* is the issues repo.
  try { await gh.setStatusLabel(run.repo_owner, run.repo_name, run.issue_number, 'agent:in-progress'); } catch { /* best-effort */ }
  try {
    const inst = run.instance_id ? `agent:claimed@${run.instance_id}` : 'agent:claimed';
    await gh.addLabels(run.repo_owner, run.repo_name, run.issue_number, [inst]);
  } catch { /* best-effort */ }
  try {
    const doing = providedSpec
      ? (specLabels.approved
          ? 'Using the pre-approved spec provided in this issue — proceeding straight to implementation.'
          : 'Using the spec provided in this issue — parked for human review in the admin.')
      : 'Drafting a spec — watch it live in the admin.';
    await gh.postComment(run.repo_owner, run.repo_name, run.issue_number,
      `Picked up by a Software Engineer agent${run.engineer_name ? ` (${run.engineer_name})` : ''}. ${doing}`);
  } catch { /* best-effort */ }

  await recordPhaseEnd(supabase, run, 'intake', 'passed', 'authorized + claimed');

  if (providedSpec) {
    // Store the provided text as the run's spec artifact — same kind/shape the spec phase writes
    // (spec.ts:127) — so review/refine/implement downstream are none the wiser. The spec-authoring
    // and self-review phases are recorded 'skipped' (terminal rows, zero tokens — never billed).
    const branch = run.branch_name || `agent/se-${run.issue_number}-${String(run.id).slice(0, 8)}`;
    await supabase.from('se_artifacts').insert({ run_id: run.id, site_id: run.site_id, phase: 'spec', kind: 'spec', content: providedSpec.spec });
    await recordPhaseEnd(supabase, run, 'spec', 'skipped', `spec provided in the issue (${providedSpec.source}) — authoring skipped`);
    await recordPhaseEnd(supabase, run, 'review', 'skipped', 'spec provided by a human — automated self-review skipped');
    await writeGate(supabase, run, 'provided_spec', 'pass', { source: providedSpec.source, approved: specLabels.approved });
    // Spec-log parity with the spec phase (best-effort): commit to the issues repo + project memory.
    const specDoc = [
      `# Spec — issue #${run.issue_number}: ${issue.title ?? ''}`,
      ``,
      `> Issue: https://github.com/${run.repo_owner}/${run.repo_name}/issues/${run.issue_number}`,
      `> Run: ${run.id} · provided by the issue author (${providedSpec.source}) · ${new Date().toISOString()}`,
      ``,
      providedSpec.spec,
    ].join('\n');
    try {
      await gh.putFile(run.repo_owner, run.repo_name, `specs/issue-${run.issue_number}.md`, specDoc,
        `spec: issue #${run.issue_number} — ${String(issue.title ?? '').slice(0, 60)}`);
    } catch { /* best-effort */ }
    try { await writeSpecMemory(supabase, run.project_id, project.name, run.issue_number, issue.title ?? '', providedSpec.spec); }
    catch { /* best-effort */ }

    if (specLabels.approved) {
      // Pre-approved fast path: exactly what the admin's spec-approve route does (admin-routes.ts) —
      // architecture first when the project has an architecture gate, else straight to implement.
      const next = project.architectureRepo && run.kind !== 'external_pr' ? 'architecture' : 'implement';
      await supabase.from('se_runs').update({ status: 'running', current_phase: next, branch_name: branch }).eq('id', run.id);
      await enqueuePhase(ctx, run.id, next);
      return { ok: true, providedSpec: true, next };
    }
    // ALWAYS park at the human spec gate — even when the project's gates config has spec off. A
    // provided spec skipped the adversarial self-review, so the human gate is the safety catch;
    // only the explicit agent:spec:approved label (above) may skip it.
    try { await writeMessage(supabase, run, 'system', 'This run uses a spec provided in the issue body — the agent did not author or self-review it. Review it here, refine by chatting, then approve to proceed.'); } catch { /* */ }
    await supabase.from('se_runs').update({ status: 'awaiting_spec', current_phase: 'review', branch_name: branch }).eq('id', run.id);
    try { await notifyGate(project, run, 'Provided spec ready for review'); } catch { /* */ }
    return { ok: true, providedSpec: true, gated: 'spec' };
  }

  await supabase.from('se_runs').update({ status: 'running', current_phase: 'spec' }).eq('id', run.id);
  await enqueuePhase(ctx, run.id, 'spec');
  return { ok: true };
}
