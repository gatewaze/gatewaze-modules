/**
 * XREAD → SSE forwarder. Mounted on every /stream endpoint.
 *
 * Long-polls the given Redis Stream with `XREAD BLOCK 5000 COUNT 100`
 * and writes each entry as an SSE message. Honours an `AbortSignal` so
 * the route handler can cancel the loop when the client disconnects.
 *
 * Each XREAD ties up its connection for up to 5s — so the SSE bridge
 * uses a **dedicated** Redis client per active response. The cap on
 * concurrent responses (`AI_SSE_POOL_MAX`, default 256) is enforced by
 * the caller (route handler) since this helper doesn't manage pool state.
 *
 * Spec: spec-ai-job-runner §4.2.
 */

import type { ServerResponse } from 'node:http';
import { hashFieldsToEvent } from './events.js';
import { adjustStreamConsumers } from './metrics.js';
import { createDedicatedRedisClient } from './redis-client.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisLike = any;

export interface BridgeOptions {
  /** Resume from offset; `$` means "tail only". Defaults to `$`. */
  fromOffset?: string;
  /** Heartbeat interval — SSE comment to keep proxies happy. Default 5s. */
  heartbeatMs?: number;
  /** Optional dedicated client; defaults to creating a new one. */
  redis?: RedisLike;
}

/**
 * Pipe XREAD output to an SSE response. Resolves when:
 *   - a `close` event arrives in the stream,
 *   - the `signal` aborts (client disconnect), or
 *   - an unrecoverable Redis error fires.
 *
 * Caller is responsible for setting the response headers (this writes
 * data: lines only — headers should already be on the wire).
 */
export async function forwardStreamToSse(
  streamKey: string,
  res: ServerResponse,
  signal: AbortSignal,
  opts: BridgeOptions = {},
): Promise<void> {
  const fromOffset = opts.fromOffset ?? '$';
  const heartbeatMs = opts.heartbeatMs ?? 5000;
  const redis = opts.redis ?? (await createDedicatedRedisClient());

  let cursor = fromOffset;
  let lastWroteAt = Date.now();
  // Wall-clock since last block returned — needed because we want to
  // emit a heartbeat even on long quiet periods.
  const streamType: 'run' | 'thread' = streamKey.includes(':ai:thread:') ? 'thread' : 'run';
  void adjustStreamConsumers(streamType, 1);
  try {
    while (!signal.aborted) {
      // XREAD BLOCK 5000 COUNT 100 STREAMS <key> <cursor>
      const reply = (await redis.xread(
        'BLOCK',
        heartbeatMs,
        'COUNT',
        100,
        'STREAMS',
        streamKey,
        cursor,
      )) as Array<[string, Array<[string, string[]]>]> | null;
      if (signal.aborted) break;
      if (!reply || reply.length === 0) {
        // Empty long-poll → heartbeat.
        if (Date.now() - lastWroteAt >= heartbeatMs - 100) {
          res.write(': keepalive\n\n');
          lastWroteAt = Date.now();
        }
        continue;
      }
      let sawClose = false;
      for (const [, entries] of reply) {
        for (const [id, kv] of entries) {
          // The id is a millisecond timestamp + sequence suffix
          // ('1762000050000-0'); ts is the leading integer.
          const tsStr = id.split('-')[0] ?? '0';
          const event = hashFieldsToEvent(Number(tsStr) || Date.now(), kv);
          if (!event) {
            cursor = id;
            continue;
          }
          res.write(`id: ${id}\n`);
          res.write(`event: ${event.type}\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          cursor = id;
          lastWroteAt = Date.now();
          if (event.type === 'close') {
            sawClose = true;
            break;
          }
        }
        if (sawClose) break;
      }
      if (sawClose) break;
    }
  } finally {
    // If we created the client, close it. If the caller supplied one,
    // they own its lifecycle.
    if (!opts.redis) {
      try {
        await redis.quit();
      } catch {
        // Ignore — best-effort cleanup.
      }
    }
    try {
      if (!res.writableEnded) res.end();
    } catch {
      // Best-effort.
    }
    void adjustStreamConsumers(streamType, -1);
  }
}

/**
 * Read the entire stream history into memory. Used by /admin/jobs/:id/stream
 * for the "live tail" replay-then-follow UX — we replay-from-0 once,
 * then forward.
 */
export async function readStreamHistory(
  redis: RedisLike,
  streamKey: string,
  fromOffset: string = '0',
): Promise<Array<{ id: string; event: ReturnType<typeof hashFieldsToEvent> }>> {
  // XRANGE returns ALL entries between two IDs without blocking.
  const reply = (await redis.xrange(streamKey, fromOffset, '+')) as Array<[string, string[]]>;
  return reply.map(([id, kv]) => {
    const tsStr = id.split('-')[0] ?? '0';
    return { id, event: hashFieldsToEvent(Number(tsStr) || Date.now(), kv) };
  });
}

/**
 * Validate the offset shape (`$`, or `<ms>-<seq>`) before passing to
 * XREAD/XRANGE. Spec §8.1.1 — refuse 400 on invalid input.
 */
export function isValidOffset(s: string | undefined): boolean {
  if (!s || s.length === 0) return true; // empty defaults to '$'
  if (s === '$' || s === '0') return true;
  return /^\d+-\d+$/.test(s);
}
