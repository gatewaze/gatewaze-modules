// @ts-nocheck
/**
 * Concurrency dispatcher for the ephemeral engineer pool. A project runs at most
 * max_concurrent_engineers at once; extra issues stay 'queued'. dispatchProject() promotes queued
 * runs to 'running' (assigning a friendly ephemeral engineer name) whenever a slot is free — called
 * on new-issue intake, on run terminal transitions, and by the pr-monitor cron as a safety net.
 */
import { getProject } from './credentials.js';

// A concurrency slot is occupied ONLY while an engineer is actively working — executing a phase
// ('running') or addressing PR feedback ('changes_requested', i.e. the revise loop). Runs that are
// merely waiting — 'watching' a PR that's in review, 'blocked' on a human decision, or 'pr_open' —
// are idle: no worker/model is running for them, so they must NOT count against the cap or they'd
// starve the queue (a project's blocked/in-review runs would permanently hold engineer slots).
const WORKING = ['running', 'changes_requested'];
// All non-terminal states — used only to keep ephemeral engineer names distinct across visible runs.
const LIVE = ['running', 'watching', 'changes_requested', 'blocked', 'pr_open'];

// Friendly names for ephemeral engineers (UI only — never written to git). Enough that a project's
// concurrent pool rarely collides; falls back to a numbered name if all are taken.
const NAME_POOL = [
  'Ada', 'Max', 'Iris', 'Reed', 'Nova', 'Cleo', 'Rex', 'Milo', 'Juno', 'Otto',
  'Vera', 'Kai', 'Luca', 'Nell', 'Ivo', 'Remy', 'Sage', 'Dara', 'Enzo', 'Wren',
];

function pickName(used: Set<string>, seed: string): string {
  for (const n of NAME_POOL) if (!used.has(n)) return n;
  return `Eng-${String(seed).slice(0, 4)}`;
}

/**
 * Promote queued runs for a project to running while slots are free. Idempotent + safe to call
 * often. The queued→running update is guarded on status='queued' so concurrent dispatchers can't
 * double-start the same run (last-writer bounded; minor over-dispatch beyond max is self-corrected
 * next tick).
 */
export async function dispatchProject(sb: unknown, ctx: unknown, projectId: string): Promise<number> {
  if (!projectId) return 0;
  const project = await getProject(sb, projectId);
  if (!project?.intakeEnabled) return 0;
  const max = Math.max(1, project.maxConcurrentEngineers ?? 2);
  let started = 0;

  // Bounded loop — never more iterations than the cap.
  for (let i = 0; i < max; i++) {
    const { data: live } = await sb
      .from('se_runs').select('status, engineer_name')
      .eq('project_id', projectId).is('archived_at', null).in('status', LIVE);
    const working = (live ?? []).filter((r) => WORKING.includes(r.status)).length;
    if (working >= max) break;   // cap counts only actively-working engineers, not idle/blocked runs

    const { data: next } = await sb
      .from('se_runs').select('id')
      .eq('project_id', projectId).eq('status', 'queued').is('archived_at', null)
      .order('created_at', { ascending: true }).limit(1).maybeSingle();
    if (!next) break;

    const used = new Set((live ?? []).map((a) => a.engineer_name).filter(Boolean));
    const name = pickName(used, next.id);

    const { data: won } = await sb
      .from('se_runs')
      .update({ status: 'running', current_phase: 'intake', engineer_name: name })
      .eq('id', next.id).eq('status', 'queued')   // atomic guard against a race
      .select('id');
    if (!won || won.length === 0) continue;        // another dispatcher took it; re-evaluate

    await ctx?.enqueueJob?.('jobs', 'software-engineer:intake', { runId: next.id });
    started++;
  }
  return started;
}

/** Dispatch every project that currently has a queued run (pr-monitor cron safety net). */
export async function dispatchAll(sb: unknown, ctx: unknown): Promise<void> {
  const { data } = await sb
    .from('se_runs').select('project_id')
    .eq('status', 'queued').is('archived_at', null);
  const projectIds = [...new Set((data ?? []).map((r) => r.project_id).filter(Boolean))];
  for (const pid of projectIds) await dispatchProject(sb, ctx, pid);
}
