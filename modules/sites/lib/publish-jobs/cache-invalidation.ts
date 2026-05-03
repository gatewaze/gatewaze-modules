/**
 * Cache-invalidation pub/sub message format (spec §6.4 — finalize step).
 *
 * After a publish job finalizes (pages.content updated), the worker
 * publishes a message on the platform's pub/sub channel
 * `sites.runtime.invalidate`. Each runtime API replica subscribes to that
 * channel and evicts the matching key from its in-memory cache.
 *
 * Channel: `sites.runtime.invalidate`
 *
 * Message shape:
 *   {
 *     site_id: string,         -- which site
 *     route: string,           -- which route's content was updated
 *     published_version: int,  -- the new pages.published_version
 *     ts: string               -- ISO timestamp
 *   }
 *
 * Per spec, at-least-once delivery is acceptable (cache invalidation is
 * idempotent). Replicas that miss a message during a Redis/NATS hiccup
 * fall back to the per-entry TTL (max 60s for personalized content).
 *
 * The pub/sub backend is platform-shape-specific:
 *   - Docker shapes:           Redis Pub/Sub
 *   - K8s shapes:              NATS
 *
 * Both are abstracted behind the platform's existing pub/sub helper; this
 * file owns the message contract only.
 */

export interface CacheInvalidationMessage {
  site_id: string;
  route: string;
  published_version: number;
  ts: string;
}

export const CACHE_INVALIDATION_CHANNEL = 'sites.runtime.invalidate';

/**
 * Build a well-formed invalidation message. Pure; throws on malformed input.
 */
export function buildInvalidationMessage(args: {
  siteId: string;
  route: string;
  publishedVersion: number;
  now?: () => Date;
}): CacheInvalidationMessage {
  if (!args.siteId) throw new Error('siteId required');
  if (!args.route || !args.route.startsWith('/')) {
    throw new Error('route must start with /');
  }
  if (!Number.isInteger(args.publishedVersion) || args.publishedVersion < 1) {
    throw new Error('publishedVersion must be a positive integer');
  }
  const now = args.now ?? (() => new Date());
  return {
    site_id: args.siteId,
    route: args.route,
    published_version: args.publishedVersion,
    ts: now().toISOString(),
  };
}

/**
 * Validate a received message before applying it. Defends against malformed
 * payloads that snuck past JSON parsing (wrong types, missing fields).
 */
export function isValidInvalidationMessage(msg: unknown): msg is CacheInvalidationMessage {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return (
    typeof m['site_id'] === 'string' &&
    m['site_id'].length > 0 &&
    typeof m['route'] === 'string' &&
    m['route'].startsWith('/') &&
    typeof m['published_version'] === 'number' &&
    Number.isInteger(m['published_version']) &&
    m['published_version'] >= 1 &&
    typeof m['ts'] === 'string'
  );
}

/**
 * Cache-key shape used by the runtime API's in-memory cache. Receivers of
 * an invalidation message build this key from the message and evict the
 * matching entry.
 */
export function cacheKeyForRoute(siteId: string, route: string): string {
  return `${siteId}:${route}`;
}
