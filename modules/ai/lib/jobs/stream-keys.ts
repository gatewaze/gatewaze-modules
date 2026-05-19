/**
 * Redis key naming conventions for the AI job runner.
 *
 * All keys are BRAND-prefixed so multi-tenant Redis deployments stay
 * isolated. The BRAND env var is set by the platform per-deployment;
 * an undefined BRAND falls back to 'default' (dev environments).
 *
 * Spec: spec-ai-job-runner §4.2.
 */

const BRAND = process.env.BRAND || 'default';

/** TTL applied to streams after the terminal event. Default 1 hour. */
export const STREAM_TTL_SECONDS = Number(process.env.AI_STREAM_TTL_SECONDS ?? 3600);

/** XADD MAXLEN cap per stream. Default 10000. */
export const STREAM_MAXLEN = Number(process.env.AI_STREAM_MAXLEN ?? 10000);

/** Redis Stream key for a recipe run's event log. */
export function recipeRunStreamKey(runId: string): string {
  return `${BRAND}:ai:run:${runId}`;
}

/** Redis Stream key for a chat thread's event log. */
export function threadStreamKey(threadId: string): string {
  return `${BRAND}:ai:thread:${threadId}`;
}

/** Pub/Sub channel for a recipe run's cancellation broadcast. */
export function recipeRunCancelChannel(runId: string): string {
  return `${BRAND}:ai:cancel:run:${runId}`;
}

/** Pub/Sub channel for a chat message's cancellation broadcast. */
export function messageCancelChannel(messageId: string): string {
  return `${BRAND}:ai:cancel:msg:${messageId}`;
}

/** Per-use-case semaphore counter key (auto-resets via TTL). */
export function useCaseSemaphoreKey(useCase: string): string {
  return `${BRAND}:ai:semaphore:use_case:${useCase}`;
}

/** TTL applied to the semaphore counter — guards against leaks if a
 *  worker dies between INCR and DECR. Default 1 hour. */
export const SEMAPHORE_TTL_SECONDS = 3600;
