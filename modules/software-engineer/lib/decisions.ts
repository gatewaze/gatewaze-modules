// @ts-nocheck
/**
 * Persisted decisions (issue #52). se_decisions gives a blocked/awaiting run a durable question +
 * answer instead of the Overview panel re-deriving a plain-language label from live state on every
 * GET (issue #49's classifyDecision). Three things live here:
 *
 * - createOrSupersedeDecision: emit (or replace) the pending decision for a run.
 * - resumeRunForDecision / approveArchitecture: the CAS-guarded state transitions shared between the
 *   existing admin routes (/runs/:id/resume, /runs/:id/architecture/approve) and the new
 *   /decisions/:id/answer route, so an answer resolves a run exactly the way the equivalent manual
 *   admin action already does.
 */
import { enqueuePhase } from './enqueue.js';
import { getProject } from './credentials.js';
import { githubClient } from './github.js';

// The fixed 3-option decision surfaced for every architecture proposal (issue #52) — shared between
// workers/architecture.ts (initial emission, context=null) and admin-routes.ts's finalize route
// (re-emission once committed, context=commit URL) so the option set can't drift between the two.
export const ARCHITECTURE_DECISION_OPTIONS = [
  { id: 'approve', label: 'Approve', description: 'Commit the proposal and resume implementation.' },
  { id: 'request_changes', label: 'Request changes', description: 'Send the proposal back for revision.' },
  { id: 'reject', label: 'Reject', description: 'Stop this run — the proposal will not proceed.' },
];

// Two sequential statements, not a stored procedure/transaction: supersede whatever pending row
// exists for this run, then insert the new one. A rare race between two concurrent emissions for the
// same run could in theory leave two 'pending' rows for an instant, but se_decisions_one_pending_per_run
// (migration 023) makes the second insert fail the unique constraint rather than corrupt state, and
// emission call sites are themselves sequential per run (a run only reaches one blocking point at a
// time), so the race is not reachable in practice.
export async function createOrSupersedeDecision(supabase, params) {
  const { runId, projectId, siteId, phase, question, kind, options = null, context = null } = params;
  await supabase.from('se_decisions').update({ status: 'superseded' }).eq('run_id', runId).eq('status', 'pending');
  const { data, error } = await supabase.from('se_decisions')
    .insert({ run_id: runId, project_id: projectId, site_id: siteId, phase, question, kind, options, context, status: 'pending' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Shared core of POST /runs/:id/resume's blocked-branch and POST /decisions/:id/answer's resume
// branch: CAS the run into `running` at resumePhase, drop an admin-note system message, re-enqueue.
// Returns {resumed,phase,attempt} on success or {status,error} on failure so callers can translate
// directly to an HTTP response.
export async function resumeRunForDecision(supabase, ctx, run, resumePhase, opts = {}) {
  const { extraJobData = {}, note = null, actorId = null, enqueueJob } = opts;
  if (!resumePhase) return { status: 409, error: { code: 'no_phase', message: 'Could not determine which phase to resume.' } };
  const { count: attemptCount } = await supabase.from('se_phases')
    .select('id', { count: 'exact', head: true }).eq('run_id', run.id).eq('phase', resumePhase);
  const nextAttempt = (attemptCount ?? 0) + 1;

  const { data: raced, error } = await supabase.from('se_runs')
    .update({ status: 'running', current_phase: resumePhase, error: null, acting_user_id: actorId })
    .eq('id', run.id).eq('status', run.status)   // atomic guard against a double-resume race
    .select('id');
  if (error) return { status: 500, error: { code: 'update_failed', message: 'update failed' } };
  if (!raced || raced.length === 0) {
    return { status: 409, error: { code: 'state_changed', message: 'Run state changed — refresh and retry if still needed.' } };
  }
  const noteText = typeof note === 'function' ? note(nextAttempt) : note;
  if (noteText) {
    try { await supabase.from('se_messages').insert({ run_id: run.id, site_id: run.site_id, role: 'system', author: actorId, content: noteText }); }
    catch { /* best-effort — the phase badges still show the resume via attempt tracking */ }
  }
  const enqCtx = enqueueJob ? { enqueueJob } : ctx;
  try { await enqueuePhase(enqCtx, run.id, resumePhase, { attempt: nextAttempt, ...extraJobData }); }
  catch { /* best-effort — an enqueue failure surfaces as the run staying stuck, visible on the board */ }
  return { resumed: true, phase: resumePhase, attempt: nextAttempt };
}

// Shared core of POST /runs/:id/architecture/approve and POST /decisions/:id/answer's 'approve'
// branch: CAS the run out of architecture_in_review into implement, re-enqueue, note it, and post a
// best-effort audit comment on the internal issue.
export async function approveArchitecture(supabase, ctx, run, opts = {}) {
  const { actorId = null, note = 'Architecture approved — resuming implementation.', enqueueJob } = opts;
  const { data: raced, error } = await supabase.from('se_runs')
    .update({ status: 'running', current_phase: 'implement', acting_user_id: actorId })
    .eq('id', run.id).eq('status', 'architecture_in_review')
    .select('id');
  if (error) return { status: 500, error: { code: 'update_failed', message: 'update failed' } };
  if (!raced || raced.length === 0) {
    return { status: 409, error: { code: 'state_changed', message: 'Run state changed — refresh and retry if still needed.' } };
  }
  const enqCtx = enqueueJob ? { enqueueJob } : ctx;
  try { await enqueuePhase(enqCtx, run.id, 'implement'); } catch { /* best-effort */ }
  try { await supabase.from('se_messages').insert({ run_id: run.id, site_id: run.site_id, role: 'system', author: actorId, content: note }); } catch { /* */ }
  if (run.issue_number) {
    try {
      const project = await getProject(supabase, run.project_id);
      if (project?.githubToken) {
        await githubClient(project.githubToken).postComment(run.repo_owner, run.repo_name, run.issue_number, note);
      }
    } catch { /* best-effort */ }
  }
  return { approved: true, resuming: true };
}
