/**
 * Three-channel cancellation primitive — pub/sub broadcast, DB row poll
 * (via the worker's existing supabase handle), and BullMQ job.remove()
 * (caller's responsibility).
 *
 * Spec: spec-ai-job-runner §4.3.
 *
 * Threading: the worker creates a CancelToken at the top of the handler,
 * passes it to the executor, and unsubscribes in `finally`. The API
 * process calls `broadcastCancel()` to fire the pub/sub side.
 */

import { getRedisClient, getRedisSubscriber } from './redis-client.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisLike = any;

export interface CancelToken {
  /** True once any of the three channels has fired. */
  cancelled: boolean;
  /** The channel that fired first (for logging). */
  source: 'pubsub' | 'db_poll' | null;
  /** The reason supplied with the cancel (defaults to 'user'). */
  reason: 'user' | 'timeout' | 'admin';
  /** Worker calls this in `finally` to release the pub/sub subscription. */
  unsubscribe(): Promise<void>;
  /** Allows external code (the DB-poll backstop) to flip the flag. */
  markCancelled(source: 'pubsub' | 'db_poll', reason?: 'user' | 'timeout' | 'admin'): void;
}

/**
 * Subscribe to a cancel channel. Returns a CancelToken whose `cancelled`
 * flag flips to true the moment a PUBLISH lands on the channel.
 *
 * The subscriber is dedicated to this run (one channel) so the unsubscribe
 * cleanly disconnects it without affecting other in-flight runs.
 */
export async function subscribeCancel(channel: string): Promise<CancelToken> {
  const sub = await getRedisSubscriber();
  const token: CancelToken = {
    cancelled: false,
    source: null,
    reason: 'user',
    async unsubscribe(): Promise<void> {
      try {
        await sub.unsubscribe(channel);
      } catch {
        // Connection may already be torn down — non-fatal.
      }
    },
    markCancelled(source, reason) {
      if (token.cancelled) return;
      token.cancelled = true;
      token.source = source;
      if (reason) token.reason = reason;
    },
  };

  // The 'message' handler runs once per PUBLISH. We only need a single
  // signal, so further messages are ignored after the first.
  sub.on('message', (ch: string, payload: string) => {
    if (ch !== channel) return;
    let reason: 'user' | 'timeout' | 'admin' = 'user';
    try {
      const parsed = JSON.parse(payload) as { reason?: string };
      if (parsed.reason === 'timeout' || parsed.reason === 'admin' || parsed.reason === 'user') {
        reason = parsed.reason;
      }
    } catch {
      // Bare-string payload → treat as default reason.
    }
    token.markCancelled('pubsub', reason);
  });

  await sub.subscribe(channel);
  return token;
}

/**
 * Broadcast a cancel on the given channel. Called by the API process
 * when an operator/user clicks Cancel. The payload is a JSON object
 * `{ reason }` so subscribers can record why.
 */
export async function broadcastCancel(
  channel: string,
  reason: 'user' | 'timeout' | 'admin' = 'user',
): Promise<number> {
  const client = await getRedisClient();
  return (await client.publish(channel, JSON.stringify({ reason }))) as number;
}

export class RunCancelled extends Error {
  readonly reason: 'user' | 'timeout' | 'admin';
  readonly source: 'pubsub' | 'db_poll';
  constructor(source: 'pubsub' | 'db_poll', reason: 'user' | 'timeout' | 'admin' = 'user') {
    super(`run cancelled via ${source}`);
    this.name = 'RunCancelled';
    this.reason = reason;
    this.source = source;
  }
}
