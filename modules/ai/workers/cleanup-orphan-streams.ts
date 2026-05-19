/**
 * Worker handler — orphan-stream sweep.
 *
 * Runs every hour (cron: `ai:cleanup-orphan-streams`). SCANs the
 * brand-prefixed keyspace for `ai:run:*` and `ai:thread:*` streams
 * that lack an EXPIRE and sets one if they're older than
 * `2 × STREAM_TTL_SECONDS`.
 *
 * Why: the worker's first action after `XADD run.start` is `EXPIRE`,
 * but a SIGKILL between the two leaves a TTL-less stream. The XADD
 * MAXLEN bound (10k entries) still applies, but the key itself
 * accumulates over time. This sweep catches it.
 *
 * Spec: spec-ai-job-runner §4.1.
 */

import { getRedisClient } from '../lib/jobs/redis-client.js';
import { STREAM_TTL_SECONDS } from '../lib/jobs/stream-keys.js';

interface JobInput {
  data: { kind?: string };
  id?: string | number;
}

interface RuntimeContext {
  logger?: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
    error: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

const BRAND = process.env.BRAND || 'default';
const ORPHAN_THRESHOLD_MS = STREAM_TTL_SECONDS * 2 * 1000;

export default async function cleanupOrphanStreamsHandler(
  _job: JobInput,
  ctx?: RuntimeContext,
): Promise<unknown> {
  const redis = await getRedisClient();
  const scanPatterns = [`${BRAND}:ai:run:*`, `${BRAND}:ai:thread:*`];
  let scanned = 0;
  let expiredSet = 0;
  let errors = 0;

  for (const pattern of scanPatterns) {
    let cursor = '0';
    do {
      // SCAN <cursor> MATCH <pattern> COUNT 100
      const reply = (await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)) as [string, string[]];
      cursor = reply[0];
      const keys = reply[1] ?? [];
      for (const key of keys) {
        scanned++;
        try {
          // PTTL returns -1 when no TTL set, -2 when key doesn't exist.
          const ttl = (await redis.pttl(key)) as number;
          if (ttl !== -1) continue;
          // Use last-generated-id timestamp to decide whether the
          // stream is genuinely stale or recently active without TTL.
          // XINFO STREAM returns flat array of [field, value, ...].
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const info = (await redis.xinfo('STREAM', key)) as Array<string>;
          let lastGeneratedId = '0-0';
          for (let i = 0; i + 1 < info.length; i += 2) {
            if (info[i] === 'last-generated-id') {
              lastGeneratedId = info[i + 1] ?? '0-0';
              break;
            }
          }
          const tsStr = lastGeneratedId.split('-')[0] ?? '0';
          const lastWriteMs = Number(tsStr);
          if (Number.isNaN(lastWriteMs) || Date.now() - lastWriteMs >= ORPHAN_THRESHOLD_MS) {
            await redis.expire(key, STREAM_TTL_SECONDS);
            expiredSet++;
          }
        } catch (err) {
          errors++;
          ctx?.logger?.warn('ai.cleanup-orphan-streams.error', {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } while (cursor !== '0');
  }

  ctx?.logger?.info('ai.cleanup-orphan-streams.complete', {
    scanned,
    expired_set: expiredSet,
    errors,
  });
  return { scanned, expired_set: expiredSet, errors };
}
