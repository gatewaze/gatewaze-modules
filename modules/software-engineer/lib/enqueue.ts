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
 * removeOnComplete frees the id so the same phase can be re-driven later if needed.
 */
export async function enqueuePhase(ctx: unknown, runId: string, phase: string, data: Record<string, unknown> = {}) {
  if (!runId || !phase) return { id: undefined };
  return (ctx as { enqueueJob?: (...a: unknown[]) => Promise<{ id?: string }> })?.enqueueJob?.(
    'jobs',
    `software-engineer:${phase}`,
    { runId, ...data },
    { jobId: `se-run-${runId}-${phase}`, removeOnComplete: true },
  ) ?? { id: undefined };
}

/** The agent phases the reconciler can re-drive (each is a long-running job that could be orphaned). */
export const RECOVERABLE_PHASES = ['intake', 'spec', 'review', 'implement', 'verify', 'pr', 'revise'];
