/**
 * Rate-limit key builders. The convention is colon-delimited:
 *
 *   host_media:<op>:<userId>:<hostKind>:<hostId>
 *
 * Per spec-host-media-module §8.9.
 */

export function buildRateLimitKey(
  op: string,
  userId: string,
  hostKind: string,
  hostId: string,
): string {
  return `host_media:${op}:${userId}:${hostKind}:${hostId}`;
}

export const UPLOAD_RATE_LIMIT = { max: 60, windowMs: 60_000 };

export const SIGNED_URL_RATE_LIMIT = { max: 30, windowMs: 60_000 };
