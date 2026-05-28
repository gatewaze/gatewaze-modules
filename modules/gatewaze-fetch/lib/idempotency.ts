/**
 * Idempotency cache (spec §10.5).
 *
 * Honors the public-API `Idempotency-Key` header. Same key + same body
 * within `idempotency_ttl_seconds` (default 300 — 5 min) returns the
 * cached response without writing audit/ledger/quota.
 *
 * Storage: Redis when GATEWAZE_REDIS_URL is set; in-process LRU
 * fallback otherwise (10000 entries; first-write-wins eviction).
 *
 * Cache key incorporates `domain_rules_version` and
 * `robots_origin_version` so policy changes invalidate cached
 * responses (§10.5).
 *
 * Idempotency hits DO pass through the per-key RPM limiter (§9.3 step
 * 2a normative rule) — preventing rate-limit bypass via repeated
 * replays. Idempotency hits do NOT debit quota or write audit/ledger.
 */

import { createHash } from 'node:crypto';

export interface IdempotencyKeyInput {
  apiKeyId: string;
  idempotencyKey: string;
  canonicalBody: string;
  domainRulesVersion: number;
  robotsOriginVersion: number;
}

export interface IdempotencyEntry {
  /** The full response body to replay (already stringified JSON). */
  responseBody: string;
  /** HTTP status of the cached response. */
  status: number;
  /** request_id of the original request — replayed in headers. */
  requestId: string;
  /** Wall-clock at which this entry expires. */
  expiresAt: number;
}

/**
 * Compute the cache key (spec §10.5).
 */
export function cacheKey(input: IdempotencyKeyInput): string {
  const h = createHash('sha256');
  h.update(input.apiKeyId);
  h.update('\0');
  h.update(input.idempotencyKey);
  h.update('\0');
  h.update(input.canonicalBody);
  h.update('\0');
  h.update(String(input.domainRulesVersion));
  h.update('\0');
  h.update(String(input.robotsOriginVersion));
  return `gw-fetch:idem:${input.apiKeyId}:${h.digest('hex')}`;
}

// ---- backend interface ------------------------------------------------
export interface IdempotencyBackend {
  get(key: string): Promise<IdempotencyEntry | null>;
  set(key: string, entry: IdempotencyEntry, ttlSeconds: number): Promise<void>;
}

// ---- in-process LRU --------------------------------------------------
class InProcessLru implements IdempotencyBackend {
  private readonly map = new Map<string, IdempotencyEntry>();
  private readonly maxEntries: number;
  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }
  async get(key: string): Promise<IdempotencyEntry | null> {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      return null;
    }
    // refresh recency by reinserting
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }
  async set(key: string, entry: IdempotencyEntry, _ttlSeconds: number): Promise<void> {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest) this.map.delete(oldest);
    }
    this.map.set(key, entry);
  }
}

// ---- Redis backend ---------------------------------------------------
class RedisBackend implements IdempotencyBackend {
  // Lazy require so the module doesn't pull `ioredis` when no Redis is
  // configured.
  private redis: unknown;
  constructor(private readonly url: string) {
    this.redis = null;
  }
  private async getClient() {
    if (this.redis) return this.redis as { get: (k: string) => Promise<string | null>; set: (k: string, v: string, ...args: unknown[]) => Promise<unknown> };
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const Redis = require('ioredis');
    this.redis = new Redis(this.url);
    return this.redis as { get: (k: string) => Promise<string | null>; set: (k: string, v: string, ...args: unknown[]) => Promise<unknown> };
  }
  async get(key: string): Promise<IdempotencyEntry | null> {
    const client = await this.getClient();
    const raw = await client.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as IdempotencyEntry;
    } catch {
      return null;
    }
  }
  async set(key: string, entry: IdempotencyEntry, ttlSeconds: number): Promise<void> {
    const client = await this.getClient();
    await client.set(key, JSON.stringify(entry), 'EX', ttlSeconds);
  }
}

// ---- factory ---------------------------------------------------------
let _backend: IdempotencyBackend | null = null;
export function getIdempotencyBackend(): IdempotencyBackend {
  if (_backend) return _backend;
  const url = process.env.GATEWAZE_REDIS_URL;
  _backend = url ? new RedisBackend(url) : new InProcessLru();
  return _backend;
}

/** Test-only reset hook. */
export function _resetIdempotencyForTests(): void {
  _backend = null;
}
