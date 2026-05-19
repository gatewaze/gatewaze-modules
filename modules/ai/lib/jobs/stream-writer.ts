/**
 * XADD helper used by workers to append entries to a recipe-run or
 * thread stream.
 *
 * Wraps the ioredis call so the worker handler reads cleanly and the
 * TTL/MAXLEN policy is centralised here per spec §4.2.
 */

import { eventToHashFields, type StreamEvent } from './events.js';
import { recordStreamEntry } from './metrics.js';
import { STREAM_MAXLEN } from './stream-keys.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisLike = any;

/**
 * Append an entry to a stream. Auto-generates the ID (`*`), trims to
 * MAXLEN (approximate, `~`), and stamps the event with `ts = Date.now()`
 * if the caller didn't.
 */
export async function appendStreamEvent(
  redis: RedisLike,
  streamKey: string,
  event: Omit<StreamEvent, 'ts'> & { ts?: number },
): Promise<string> {
  const ts = event.ts ?? Date.now();
  const fullEvent: StreamEvent = { ...(event as Omit<StreamEvent, 'ts'>), ts } as StreamEvent;
  const hash = eventToHashFields(fullEvent);
  // XADD <key> MAXLEN ~ 10000 * field value field value ...
  // ioredis accepts a flat varargs form.
  const args: (string | number)[] = [streamKey, 'MAXLEN', '~', STREAM_MAXLEN, '*'];
  for (const [k, v] of Object.entries(hash)) {
    args.push(k, v);
  }
  const id = (await redis.xadd(...args)) as string;
  // Crude stream-type derivation from the key — runs use `:ai:run:`,
  // threads use `:ai:thread:`. The label set stays small (2 values).
  if (streamKey.includes(':ai:thread:')) void recordStreamEntry('thread');
  else if (streamKey.includes(':ai:run:')) void recordStreamEntry('run');
  return id;
}
