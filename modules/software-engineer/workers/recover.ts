// @ts-nocheck
/**
 * Recovery reconciler (crash resilience). The DB is the durable source of truth — se_runs holds each
 * run's status + current_phase. The in-flight BullMQ job that advances it lives in Redis, which is
 * ephemeral. If the worker, pod, machine, or Redis dies mid-phase, a run can be left in an
 * actively-working status with no job to advance it.
 *
 * This cron finds such orphaned runs — an active status but NO recent progress (no events, no phase
 * update, for SE_RECOVER_STUCK_MS) — and re-drives their current phase. The re-drive uses the
 * deterministic per-phase jobId (see lib/enqueue.ts), so it is idempotent: a no-op if the job is
 * somehow still queued/active, a fresh re-creation if it was lost. Result: a run resumes from its
 * saved phase after any infrastructure death, with no duplicate agent session.
 *
 * BullMQ's own stalled-job detection (lockDuration, ~5 min) already recovers most worker/pod deaths;
 * this backstops the cases it can't see — Redis loss, or a run whose job vanished without re-enqueue.
 */
import { createClient } from '@supabase/supabase-js';
import { enqueuePhase, phaseJobId, RECOVERABLE_PHASES } from '../lib/enqueue.js';
import { writeEvent } from '../lib/run-state.js';

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

// A run silent for this long, while still "working", is treated as orphaned. Generous by default so
// a genuinely long (but healthy, event-producing) phase is never re-driven; BullMQ handles the fast
// worker-death path well under this.
const STUCK_MS = Number(process.env.SE_RECOVER_STUCK_MS || 15 * 60 * 1000);

// BullMQ states for a job that's genuinely still progressing (or about to). enqueuePhase's dedup is
// silent, so without checking the actual job state, a job that's live but simply slow (a long agent
// turn with no se_events row yet) would look identical to one that never got created — re-driving it
// would either silently no-op (fine) or, worse, race the live job if we ever removed it first.
const LIVE_JOB_STATES = new Set(['active', 'waiting', 'delayed', 'waiting-children', 'prioritized']);

export default async function recover(job, ctx) {
  const supabase = sb(ctx);
  const cutoff = new Date(Date.now() - STUCK_MS).toISOString();

  // Actively-working runs, in a recoverable agent phase, whose row hasn't been touched in a while.
  const { data: candidates } = await supabase
    .from('se_runs')
    .select('id, site_id, current_phase, updated_at, engineer_name')
    .eq('kind', 'issue')   // interactive sessions are live REPLs with no resumable step — never re-drive
    .in('status', ['running', 'changes_requested'])
    .is('archived_at', null)
    .in('current_phase', RECOVERABLE_PHASES)
    .lt('updated_at', cutoff);

  let recovered = 0;
  for (const run of candidates ?? []) {
    // A healthy long phase still streams events — if the run produced any recently, it's alive. Check
    // this before touching Redis at all — it's the cheap DB-only signal and covers most healthy runs.
    const { data: lastEv } = await supabase
      .from('se_events').select('created_at')
      .eq('run_id', run.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (lastEv?.created_at && lastEv.created_at > cutoff) continue;

    // Look up the deterministic-id job before re-driving. If ctx doesn't expose getQueue (e.g. an
    // older worker runtime), fall back to the original unconditional re-drive — enqueuePhase's own
    // dedup on the deterministic jobId still protects against a duplicate agent session.
    const queue = ctx?.getQueue?.();
    if (queue) {
      const existing = await queue.getJob(phaseJobId(run.id, run.current_phase));
      if (existing) {
        const state = await existing.getState();
        if (LIVE_JOB_STATES.has(state)) {
          console.log(
            `[software-engineer:recover] run ${run.id} phase '${run.current_phase}' has a live job (${state}) — skipping`,
          );
          continue;
        }
        // Orphaned: the job hash is still in Redis (e.g. stuck 'completed'/'failed' that never
        // cleared, or an 'unknown' state) but nothing is actually driving it. Remove it first so the
        // re-add below isn't deduped into a silent no-op.
        await existing.remove();
        await writeEvent(supabase, run, run.current_phase, 0, 'status', {
          recover: 'removed_orphaned_job',
          job_state: state,
        });
      }
    }

    // Re-drive the saved phase (idempotent via deterministic jobId).
    await enqueuePhase(ctx, run.id, run.current_phase);
    // Touch the row so we don't hammer the same run every tick before the re-driven job starts.
    await supabase.from('se_runs').update({ updated_at: new Date().toISOString() }).eq('id', run.id);
    await writeEvent(supabase, run, run.current_phase, 0, 'status', { recover: 're_drove' });
    recovered++;
    console.log(`[software-engineer:recover] re-drove run ${run.id} (${run.engineer_name ?? '?'}) at phase '${run.current_phase}'`);
  }
  if (recovered > 0) console.log(`[software-engineer:recover] re-drove ${recovered} orphaned run(s)`);
  return { recovered };
}
