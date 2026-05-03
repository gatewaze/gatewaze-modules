/**
 * API-key generation, hashing, and verification (spec §9.0).
 *
 *   - Cleartext format: `gw_runtime_<site_id_short>_<base64(32 random bytes)>`
 *   - Stored: `key_hash` = HMAC-SHA256(cleartext, platform_pepper) as 64-char hex
 *   - Cleartext shown to admin once at creation; never persisted
 *
 * Dual-key rotation per §9.0:
 *   - Each site has at most two active keys (`primary`, `secondary`)
 *   - `validateRuntimeKey` accepts either; the API server queries
 *     `sites_runtime_api_keys WHERE site_id=? AND revoked_at IS NULL`
 *
 * Pure crypto helpers; no DB / network IO.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_RANDOM_BYTES = 32;

export interface GeneratedRuntimeApiKey {
  /** Cleartext key — show once to the admin, never store. */
  cleartext: string;
  /** Cleartext prefix (NOT secret) — used for admin-UI identification. */
  prefix: string;
  /** Hash to persist in sites_runtime_api_keys.key_hash. 64-char hex. */
  hash: string;
}

/**
 * Generate a fresh runtime API key for a site.
 *
 *   siteIdShort: first 8 hex chars of the site's UUID, used in the prefix
 *                so the key visibly identifies its owning site (helps with
 *                triage when a leaked key surfaces in logs).
 *   pepper:      platform-level secret. Live keys SHOULD share a pepper across
 *                replicas; rotating the pepper invalidates every existing key
 *                and must be done deliberately. Pepper length: at least 32 bytes.
 */
export function generateRuntimeApiKey(args: {
  siteIdShort: string;
  pepper: Uint8Array;
}): GeneratedRuntimeApiKey {
  if (args.pepper.byteLength < 32) {
    throw new Error('runtime api key pepper must be at least 32 bytes');
  }
  if (!/^[a-f0-9]{8}$/.test(args.siteIdShort)) {
    throw new Error('siteIdShort must be 8 hex characters');
  }
  const random = randomBytes(KEY_RANDOM_BYTES);
  const randomBase64 = random.toString('base64url');
  const prefix = `gw_runtime_${args.siteIdShort}_`;
  const cleartext = prefix + randomBase64;
  const hash = hashRuntimeApiKey(cleartext, args.pepper);
  return { cleartext, prefix, hash };
}

/**
 * Hash a cleartext key with the platform pepper. Idempotent / pure.
 */
export function hashRuntimeApiKey(cleartext: string, pepper: Uint8Array): string {
  if (pepper.byteLength < 32) {
    throw new Error('runtime api key pepper must be at least 32 bytes');
  }
  return createHmac('sha256', pepper).update(cleartext, 'utf-8').digest('hex');
}

/**
 * Constant-time comparison of two key hashes (both expected as 64-char hex).
 * Prevents timing attacks distinguishing "key not found" from "key hash mismatch."
 */
export function compareKeyHashes(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // Both expected 64 hex chars — convert to Buffer for timingSafeEqual.
  // If either is malformed, fall through to false safely.
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, 'hex');
    bufB = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Parse the `Authorization: Bearer <key>` header. Returns the cleartext key
 * or null if the header is absent / malformed. Does not validate the key
 * itself — that's the caller's job.
 */
export function extractBearerKey(authHeader: string | undefined): string | null {
  if (typeof authHeader !== 'string' || authHeader.length === 0) return null;
  const match = authHeader.match(/^Bearer\s+([\w.\-=+/_]+)$/);
  if (!match) return null;
  return match[1] ?? null;
}

/**
 * Extract the site-id-short from a `gw_runtime_<short>_<random>` key. Used
 * to look up the owning site WITHOUT first scanning every site's keys —
 * the key prefix is structured so we know which site to query.
 */
export function siteIdShortFromKey(key: string): string | null {
  const match = key.match(/^gw_runtime_([a-f0-9]{8})_/);
  return match ? (match[1] ?? null) : null;
}
