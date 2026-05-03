/**
 * Preview-token machinery (per spec-sites-module §9.5, spec-sites-theme-kinds
 * §7.7).
 *
 * Tokens are 256-bit cryptographically random values. The cleartext is
 * returned to the caller exactly once (response of `POST .../preview-tokens`)
 * and never persisted — the database stores SHA-256(token) only. Validation
 * compares hashes; we use a constant-time compare to defend against timing
 * oracles, and we cap the token's lifespan with a hard ceiling.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Format prefix so admin UI / logs can recognize the token kind at a glance. */
export const PREVIEW_TOKEN_PREFIX = 'gw_preview_';

/** Max permitted lifetime for a preview token. Per spec §9.5 — tokens
 * embedded in URLs (e.g., shared with stakeholders) MUST NOT live forever.
 */
export const PREVIEW_TOKEN_MAX_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

export interface GeneratedPreviewToken {
  /** The cleartext token. Returned ONCE. Never log, never persist. */
  token: string;
  /** SHA-256(token) hex — what the DB stores. */
  hash: string;
  /** ISO timestamp when this token expires (UTC). */
  expiresAt: string;
}

/**
 * Generate a fresh preview token bound to a TTL.
 *
 * Throws if ttlSeconds <= 0 or > PREVIEW_TOKEN_MAX_TTL_SECONDS so callers
 * can't accidentally mint a forever token.
 */
export function generatePreviewToken(args: {
  ttlSeconds: number;
  /** Override for tests; defaults to current time. */
  now?: () => Date;
  /** Override for tests; defaults to crypto.randomBytes(32). */
  randomSource?: () => Uint8Array;
}): GeneratedPreviewToken {
  if (!Number.isFinite(args.ttlSeconds) || args.ttlSeconds <= 0) {
    throw new Error('ttlSeconds must be a positive number');
  }
  if (args.ttlSeconds > PREVIEW_TOKEN_MAX_TTL_SECONDS) {
    throw new Error(`ttlSeconds must be <= ${PREVIEW_TOKEN_MAX_TTL_SECONDS}`);
  }
  const random = args.randomSource ? args.randomSource() : new Uint8Array(randomBytes(32));
  if (random.length !== 32) {
    throw new Error('randomSource must produce 32 bytes');
  }
  const token = PREVIEW_TOKEN_PREFIX + bytesToBase32(random);
  const hash = hashPreviewToken(token);
  const now = args.now ? args.now() : new Date();
  const expiresAt = new Date(now.getTime() + args.ttlSeconds * 1000).toISOString();
  return { token, hash, expiresAt };
}

/** SHA-256(token) hex. Stable across processes — used by the DB lookup. */
export function hashPreviewToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time compare of two SHA-256 hex hashes. Length check is done
 * first; the timingSafeEqual call requires equal-length buffers.
 */
export function compareTokenHashes(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface TokenValidationOk {
  ok: true;
}
export interface TokenValidationFail {
  ok: false;
  reason: 'expired' | 'revoked' | 'not_found';
}
export type TokenValidationResult = TokenValidationOk | TokenValidationFail;

/**
 * Validate a token's persisted record against the wall clock.
 * Caller is responsible for the DB lookup; this enforces freshness rules.
 */
export function validateTokenRecord(args: {
  expiresAt: string;
  revokedAt: string | null;
  /** Override for tests; defaults to current time. */
  now?: () => Date;
}): TokenValidationResult {
  const now = args.now ? args.now() : new Date();
  if (args.revokedAt) return { ok: false, reason: 'revoked' };
  const expiresAt = new Date(args.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    return { ok: false, reason: 'not_found' };
  }
  if (expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true };
}

/**
 * Extract a preview token from either an `X-Preview-Token` header value or
 * a `?preview=...` query string. Returns null if absent or malformed.
 */
export function extractPreviewToken(headerValue: unknown, queryValue: unknown): string | null {
  const candidate =
    (typeof headerValue === 'string' && headerValue.length > 0 ? headerValue : null) ??
    (typeof queryValue === 'string' && queryValue.length > 0 ? queryValue : null);
  if (!candidate) return null;
  if (!candidate.startsWith(PREVIEW_TOKEN_PREFIX)) return null;
  // Crockford32 body, 52 chars per 256 bits (256 / log2(32) = 51.2 → 52 padded).
  if (candidate.length < PREVIEW_TOKEN_PREFIX.length + 40) return null;
  if (candidate.length > PREVIEW_TOKEN_PREFIX.length + 64) return null;
  return candidate;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CROCKFORD32 = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';

function bytesToBase32(bytes: Uint8Array): string {
  // Encode 32 bytes into Crockford-32 (no padding). Cleartext token shape:
  // PREFIX + base32(256 bits) → 52 base32 chars + the 11-char prefix.
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | (bytes[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD32[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += CROCKFORD32[(value << (5 - bits)) & 0x1f];
  }
  return out;
}
