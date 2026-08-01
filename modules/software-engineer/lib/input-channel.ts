// @ts-nocheck
/**
 * Cross-process admin → agent input bridge (§14.1). The API pod publishes admin chat /
 * override messages to a Redis channel keyed by run id; the SE runner pod subscribes and
 * feeds them into the live Agent SDK session via streamInput()/interrupt().
 *
 * Message shape: { kind: 'chat' | 'interrupt' | 'close', content?: string, images?: string[], author?: string }
 *
 * `close` is used only by interactive (pair-programming) sessions: it ends the persistent streaming
 * session gracefully (the input generator returns → the Agent SDK session completes → the worker
 * cleans up its workspace). Issue-pipeline runs never see it.
 */

export interface InputMessage {
  kind: 'chat' | 'interrupt' | 'close';
  content?: string;
  /** Chat-pasted screenshot URLs (already uploaded to the public `media` bucket, host-allowlisted by
   *  the API). The runner downloads these into the phase workspace so the agent can Read them. */
  images?: string[];
  author?: string;
}

const channel = (runId: string) => `se:input:${runId}`;

/** API side: publish one admin message for a run. */
export async function publishInput(redis: unknown, runId: string, msg: InputMessage): Promise<void> {
  if (!redis) return;
  await redis.publish(channel(runId), JSON.stringify(msg));
}

/**
 * Runner side: subscribe to a run's input channel and expose it as an async iterator plus a
 * close(). Uses a dedicated (duplicated) connection because a Redis connection in subscriber
 * mode can't issue other commands.
 */
export function subscribeInput(redis: unknown, runId: string) {
  const sub = redis.duplicate();
  const pending: InputMessage[] = [];
  let waiter: ((m: InputMessage | null) => void) | null = null;
  let closed = false;

  sub.on('message', (_ch: string, raw: string) => {
    let msg: InputMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (waiter) {
      waiter(msg);
      waiter = null;
    } else {
      pending.push(msg);
    }
  });
  const ready = sub.subscribe(channel(runId));

  return {
    ready,
    async *[Symbol.asyncIterator](): AsyncGenerator<InputMessage> {
      while (!closed) {
        if (pending.length) {
          yield pending.shift() as InputMessage;
          continue;
        }
        const msg = await new Promise<InputMessage | null>((resolve) => {
          waiter = resolve;
        });
        if (msg === null) return;
        yield msg;
      }
    },
    close() {
      closed = true;
      if (waiter) {
        waiter(null);
        waiter = null;
      }
      sub.unsubscribe().catch(() => {});
      sub.quit().catch(() => {});
    },
  };
}
