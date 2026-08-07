// @ts-nocheck
/**
 * Enqueue a software-engineer phase job with a DETERMINISTIC jobId so re-enqueue is idempotent.
 *
 * Why: the run's phase lives in the DB (se_runs.current_phase) — the durable source of truth — but
 * the in-flight BullMQ job lives in Redis, which is ephemeral. If the worker/pod/machine (or Redis)
 * dies, the recovery reconciler (workers/recover.ts) re-drives a run's current phase by calling this
 * with the same (runId, phase). Because the jobId is deterministic (`se-run-<id>-<phase>`):
 *   - if the job is still queued/active, BullMQ dedups → no duplicate agent session;
 *   - if it was lost, the job is recreated → the run resumes from its saved phase.
 *
 * removeOnComplete AND removeOnFail both free the deterministic id on a terminal outcome so the phase
 * can be re-driven later. removeOnFail is not optional: a TERMINAL BullMQ failure — a stall (the
 * runner was killed mid-phase by a deploy/OOM, so BullMQ marks the job "stalled more than allowable
 * limit") or an uncaught crash — otherwise leaves the failed job holding the id FOREVER. Every
 * subsequent recover re-enqueue with the same id is then silently deduped, so the reconciler logs
 * "re-drove" but nothing runs and the run wedges in its phase indefinitely (observed: a run stuck a
 * full day in `implement` after a staging redeploy). The DB (se_phases / se_runs) is the durable
 * failure record, so dropping the dead Redis job loses nothing diagnostic.
 */
/** The deterministic BullMQ jobId for a run's phase — shared with recover.ts so it can look up an
 * existing job's state before deciding whether to re-enqueue. */
export function phaseJobId(runId: string, phase: string): string {
  return `se-run-${runId}-${phase}`;
}

export async function enqueuePhase(ctx: unknown, runId: string, phase: string, data: Record<string, unknown> = {}) {
  if (!runId || !phase) return { id: undefined };
  return (ctx as { enqueueJob?: (...a: unknown[]) => Promise<{ id?: string }> })?.enqueueJob?.(
    'se',
    `software-engineer:${phase}`,
    { runId, ...data },
    { jobId: phaseJobId(runId, phase), removeOnComplete: true, removeOnFail: true },
  ) ?? { id: undefined };
}

/** The agent phases the reconciler can re-drive (each is a long-running job that could be orphaned). */
export const RECOVERABLE_PHASES = ['intake', 'spec', 'review', 'architecture', 'implement', 'verify', 'pr', 'revise'];
