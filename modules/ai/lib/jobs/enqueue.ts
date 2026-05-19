/**
 * Helpers for enqueuing ai:* jobs via the platform's ctx.enqueueJob.
 *
 * Wraps the per-use-case semaphore + the canonical job-name constants
 * so route handlers don't have to repeat the bookkeeping.
 *
 * Spec: spec-ai-job-runner §4.1.
 */

import { recordEnqueued } from './metrics.js';
import { getRedisClient } from './redis-client.js';
import { useCaseSemaphoreKey, SEMAPHORE_TTL_SECONDS } from './stream-keys.js';

export const JOBS_QUEUE = 'jobs';
export const JOB_RUN_RECIPE = 'ai:run-recipe';
export const JOB_RUN_CHAT = 'ai:run-chat';

const USE_CASE_BACKOFF_MS = Number(process.env.AI_USE_CASE_BACKOFF_MS ?? 1000);
const DEFAULT_USE_CASE_CAP = Number(process.env.AI_USE_CASE_DEFAULT_CAP ?? 4);

// Caller-supplied enqueue function from ModuleRuntimeContext.
export type EnqueueFn = (
  queueName: string,
  jobName: string,
  data: Record<string, unknown>,
) => Promise<{ id: string | undefined }>;

export interface EnqueueOptions {
  /** Per-use-case concurrency cap. Defaults to AI_USE_CASE_DEFAULT_CAP=4. */
  useCaseConcurrencyCap?: number;
}

export interface EnqueueResult {
  jobId: string | undefined;
  /** True when the per-use-case cap was hit; job was enqueued with a delay. */
  delayed: boolean;
}

/**
 * Enqueue a recipe-run job. Returns the BullMQ job ID + whether the
 * job was delayed because the per-use-case cap was hit.
 */
export async function enqueueRecipeRunJob(
  enqueue: EnqueueFn,
  payload: {
    runId: string;
    useCase: string;
    recipeId?: string;
    userId?: string | null;
  },
  opts: EnqueueOptions = {},
): Promise<EnqueueResult> {
  return enqueueWithSemaphore(enqueue, JOB_RUN_RECIPE, payload, opts);
}

/**
 * Enqueue a chat-run job.
 */
export async function enqueueChatRunJob(
  enqueue: EnqueueFn,
  payload: {
    threadId: string;
    assistantMessageId: string;
    useCase: string;
    userId?: string | null;
  },
  opts: EnqueueOptions = {},
): Promise<EnqueueResult> {
  return enqueueWithSemaphore(enqueue, JOB_RUN_CHAT, payload, opts);
}

/**
 * Common shape: INCR the semaphore counter, refresh its TTL (leak
 * guard), and either enqueue immediately or enqueue with a delay if
 * the cap is exceeded.
 */
async function enqueueWithSemaphore(
  enqueue: EnqueueFn,
  jobName: string,
  payload: { useCase: string } & Record<string, unknown>,
  opts: EnqueueOptions,
): Promise<EnqueueResult> {
  const cap = opts.useCaseConcurrencyCap ?? DEFAULT_USE_CASE_CAP;
  const semKey = useCaseSemaphoreKey(payload.useCase);
  let delayed = false;
  try {
    const client = await getRedisClient();
    const count = (await client.incr(semKey)) as number;
    // Always re-set the TTL so leaks self-heal.
    await client.expire(semKey, SEMAPHORE_TTL_SECONDS);
    if (count > cap) {
      delayed = true;
    }
  } catch {
    // Redis hiccup → enqueue without the semaphore guard rather than
    // fail the request. The platform's BullMQ Queue is over a separate
    // ioredis connection so this fallback path can still succeed.
  }
  const data: Record<string, unknown> = { ...payload, enqueuedAt: new Date().toISOString() };
  if (delayed) {
    data._delayHintMs = USE_CASE_BACKOFF_MS;
  }
  const r = await enqueue(JOBS_QUEUE, jobName, data);
  void recordEnqueued(jobName, payload.useCase);
  return { jobId: r.id, delayed };
}

/**
 * Worker calls this when finishing a job (success/fail/cancel) so the
 * semaphore counter goes back down. Idempotent — DECR from 0 stays at
 * 0 thanks to the bounded floor.
 */
export async function releaseUseCaseSemaphore(useCase: string): Promise<void> {
  const semKey = useCaseSemaphoreKey(useCase);
  try {
    const client = await getRedisClient();
    const count = (await client.decr(semKey)) as number;
    if (count < 0) {
      // Underflow recovery — shouldn't happen but be defensive.
      await client.set(semKey, 0, 'EX', SEMAPHORE_TTL_SECONDS);
    } else {
      // Refresh TTL on every successful DECR.
      await client.expire(semKey, SEMAPHORE_TTL_SECONDS);
    }
  } catch {
    // Best-effort.
  }
}
