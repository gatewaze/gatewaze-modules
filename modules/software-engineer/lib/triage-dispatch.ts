// @ts-nocheck
/**
 * Triage dispatch (§10.5 structural fix): the API enqueues a triage turn onto the dedicated
 * `se-triage` queue and awaits the job's return value, so the model turn executes in a worker/
 * runner process — never in the API pod (whose tight memory limits OOMKilled the in-process CLI
 * spawn on prod). BullMQ Queue + QueueEvents are constructed lazily against the platform Redis
 * (same brand prefix as the registry) and cached for the process lifetime.
 *
 * SE_TRIAGE_INLINE=1 forces the old in-process path (dev escape hatch when no consumer runs).
 * bullmq/ioredis resolve from the platform's node_modules (same provided-dep pattern as
 * @supabase/supabase-js).
 */

const PREFIX = `bull:${process.env.BRAND ?? 'default'}`;
const QUEUE = 'se-triage';

let cached: { queue: any; events: any } | null = null;

async function getDispatch() {
  if (cached) return cached;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL not configured');
  // Lazy-import: bullmq/ioredis are platform-provided at runtime (node_modules walk-up) but not
  // resolvable inside the module's own vitest sandbox — a top-level import broke every suite that
  // transitively loads the admin routes.
  const [{ Queue, QueueEvents }, { default: IORedis }] = await Promise.all([import('bullmq'), import('ioredis')]);
  const queue = new Queue(QUEUE, { connection: new IORedis(url, { maxRetriesPerRequest: null }), prefix: PREFIX });
  const events = new QueueEvents(QUEUE, { connection: new IORedis(url, { maxRetriesPerRequest: null }), prefix: PREFIX });
  cached = { queue, events };
  return cached;
}

/** Enqueue one triage turn and await its result. Throws on timeout/queue failure — the route maps
 *  that to a clear operator-facing error (e.g. "no triage consumer running"). */
export async function dispatchTriageTurn(
  payload: { projectId: string; messages: unknown; pageContext?: unknown },
  timeoutMs = 85_000,
): Promise<unknown> {
  const { queue, events } = await getDispatch();
  await events.waitUntilReady();
  const job = await queue.add('software-engineer:triage-turn', payload, {
    removeOnComplete: true,
    removeOnFail: true,
    attempts: 1,
  });
  return job.waitUntilFinished(events, timeoutMs);
}
