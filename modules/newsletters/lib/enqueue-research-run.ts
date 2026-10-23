/**
 * Enqueue one research run on the platform `jobs` queue.
 *
 * Two runtimes reach this, and each supports a different path:
 *   - the platform's enqueueJob, passed to worker handlers by the queue
 *     registry worker and to module routes by the API. The legacy job
 *     worker (scripts/workers/job-worker.js, still in the k8s image) calls
 *     handlers without a context, so it is not always there.
 *   - a direct BullMQ queue. That needs `bullmq` resolvable from this
 *     module's directory, which holds in the k8s images (/node_modules links
 *     to /app/node_modules) but not on a bind-mounted dev stack.
 * enqueueJob is preferred; the queue is the fallback.
 */
import { redisConnection } from './redis-connection.js';

export type EnqueueJob = (queue: string, name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ id: string | undefined }>;

const JOB = 'newsletters:research-run';
const jobOpts = (runId: string) => ({
  jobId: `newsletters-research-run-${runId}`,
  attempts: 2,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 500 },
});

export async function enqueueResearchRun(runId: string, enqueueJob?: EnqueueJob): Promise<void> {
  const data = { kind: JOB, runId };
  if (typeof enqueueJob === 'function') {
    const { id } = await enqueueJob('jobs', JOB, data, jobOpts(runId));
    if (id) return;
    // A missing queue resolves with no id; fall through to the direct queue.
  }
  const { Queue } = await import('bullmq');
  const queue = new Queue('jobs', { connection: redisConnection(), prefix: `bull:${process.env.BRAND || 'default'}` });
  try {
    await queue.add(JOB, data, jobOpts(runId));
  } finally {
    await queue.close().catch(() => {});
  }
}
