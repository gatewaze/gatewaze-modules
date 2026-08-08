// @ts-nocheck
/**
 * intake-poll — PULL fallback for issue intake (§2 / cross-instance §2.2).
 *
 * The webhook is the primary trigger path, but it only works where GitHub can reach the instance.
 * A NAT'd deployment (localhost, the staging box) never receives webhooks — and in the
 * cross-instance flow (prod files feedback issues → STAGING runs the agents) the owning instance
 * must discover trigger-labelled issues on its own. This cron polls each OWNED project's issues
 * repo for open, trigger-labelled, unclaimed issues and dispatches runs for them.
 *
 * Ownership: a project is polled only when its primary_instance_id is unset or equals THIS
 * instance's SE_INSTANCE_ID — the exact rule the webhook path applies. Because this cron runs on
 * the 'se' queue, it executes only where a runner exists at all.
 *
 * Idempotence/dedup (safe alongside the webhook — either may see an issue first):
 *   - skip issues carrying agent:claimed* or any agent: status label (in-progress/in-review/blocked);
 *   - skip issues that already have a live (non-cancelled, non-archived) se_runs row;
 *   - dispatchProject enforces the concurrency cap + name uniqueness as always.
 *
 * AUTHORIZATION PARITY with the webhook (§2.1): the trusted identity is the LABEL-APPLIER (the
 * actor GitHub gated on triage/write — the webhook's `sender`), resolved from the issue's events,
 * NEVER the issue author (anyone can open an issue). allowed_labellers is enforced identically;
 * an issue whose applier can't be resolved is skipped (fail closed). run.labeller feeds the
 * feedback-authz trust chain downstream, so this attribution must not be widenable.
 */
import { createClient } from '@supabase/supabase-js';
import { getProject } from '../lib/credentials.js';
import { githubClient } from '../lib/github.js';
import { parseDependencies, unmetDependencies, ensureWaitingMarker, clearWaitingMarker, WAITING_LABEL } from '../lib/dependencies.js';
import { dispatchProject } from '../lib/dispatch.js';

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const SKIP_LABELS = ['agent:in-progress', 'agent:in-review', 'agent:blocked'];

export default async function intakePoll(job, ctx) {
  const supabase = sb(ctx);
  const inst = process.env.SE_INSTANCE_ID || 'default';
  const { data: projects } = await supabase
    .from('se_projects')
    .select('id, site_id, issues_repo_owner, issues_repo_name, trigger_label, primary_instance_id, intake_enabled')
    .eq('intake_enabled', true);

  let discovered = 0;
  for (const p of projects ?? []) {
    if (!p.issues_repo_owner || !p.issues_repo_name) continue;
    // Ownership rule — identical to the webhook path: act only when this instance owns the label.
    if (p.primary_instance_id && p.primary_instance_id !== inst) continue;
    const proj = await getProject(supabase, p.id);
    if (!proj?.githubToken) continue;
    const trigger = p.trigger_label || 'agent:build';

    const gh = githubClient(proj.githubToken);
    let issues = [];
    try {
      issues = await gh.listIssues(p.issues_repo_owner, p.issues_repo_name, 'open', [trigger]);
    } catch { continue; /* repo unreachable this tick — next tick retries */ }

    const allowed = Array.isArray(proj.allowedLabellers) ? proj.allowedLabellers : [];
    let inserted = 0;
    for (const issue of issues ?? []) {
      if (issue.pull_request) continue; // the issues API returns PRs too
      const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
      if (labels.some((n) => n.startsWith('agent:claimed') || SKIP_LABELS.includes(n))) continue;

      const { data: existing } = await supabase
        .from('se_runs').select('id')
        .eq('repo_owner', p.issues_repo_owner).eq('repo_name', p.issues_repo_name).eq('issue_number', issue.number)
        .neq('status', 'cancelled').is('archived_at', null)
        .limit(1).maybeSingle();
      if (existing) continue;

      // Resolve the LABEL-APPLIER (webhook `sender` equivalent) from issue events — the newest
      // 'labeled' event for the trigger label wins. No resolvable applier → fail closed (skip).
      let labeller = null;
      try {
        const events = await gh.listIssueEvents(p.issues_repo_owner, p.issues_repo_name, issue.number);
        for (const ev of events ?? []) {
          if (ev?.event === 'labeled' && ev?.label?.name === trigger && ev?.actor?.login) labeller = ev.actor.login;
        }
      } catch { /* events unreadable → labeller stays null → skipped below */ }
      if (!labeller) continue;
      if (allowed.length && !allowed.includes(labeller)) continue; // same policy as the webhook path

      // Dependency sequencing: defer (visibly) until every declared dep issue is closed. Fresh
      // issues are checked immediately; issues ALREADY marked waiting re-check on a ~10-minute
      // cadence, not every tick — bounds the steady-state GitHub API fan-out (security review
      // 2026-08-08) at the cost of up to ~10min extra latency after the last dep lands.
      const isWaiting = labels.includes(WAITING_LABEL);
      if (isWaiting && Math.floor(Date.now() / 60000) % 10 >= 2) continue;
      const deps = parseDependencies(String(issue.body ?? ''), issue.number);
      if (deps.length) {
        const unmet = await unmetDependencies(gh, p.issues_repo_owner, p.issues_repo_name, deps);
        if (unmet.length) {
          await ensureWaitingMarker(gh, p.issues_repo_owner, p.issues_repo_name, issue.number, labels, unmet, deps);
          continue;
        }
        await clearWaitingMarker(gh, p.issues_repo_owner, p.issues_repo_name, issue.number, labels);
      }

      const { error } = await supabase.from('se_runs').insert({
        site_id: p.site_id, project_id: p.id, instance_id: inst,
        repo_owner: p.issues_repo_owner, repo_name: p.issues_repo_name, issue_number: issue.number,
        title: String(issue.title ?? '').slice(0, 500),
        labeller,
        status: 'queued', current_phase: 'intake',
      });
      if (!error) { inserted += 1; discovered += 1; }
    }
    if (inserted > 0) {
      try { await dispatchProject(supabase, ctx, p.id); } catch { /* next cron/dispatch reconciles */ }
    }
  }
  return { ok: true, discovered };
}
