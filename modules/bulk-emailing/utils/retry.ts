/**
 * Calculate the next retry timestamp using exponential backoff.
 * Returns null if max attempts have been reached (permanently failed).
 *
 * Schedule: 2min, 8min, 32min
 */
export function calculateNextRetry(attempt: number, maxAttempts = 3): string | null {
  if (attempt >= maxAttempts) return null;
  const delayMinutes = Math.pow(4, attempt) * 0.5;
  return new Date(Date.now() + delayMinutes * 60_000).toISOString();
}

/**
 * Convert a UUID to a bigint for use as a PostgreSQL advisory lock key.
 * Uses a simple hash to avoid collisions while fitting in bigint range.
 */
export function jobIdToLockKey(jobId: string): number {
  let hash = 0;
  for (let i = 0; i < jobId.length; i++) {
    const char = jobId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}
