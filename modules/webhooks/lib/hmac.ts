/**
 * HMAC-SHA256 sign + verify for webhook outbound payloads.
 *
 * Signature input: `${unixSeconds}.${rawBody}`. Header `X-Gatewaze-Signature`
 * carries `hex(hmac_sha256(secret, input))`. Subscribers MUST verify the
 * timestamp is within 5 minutes of `now()` to prevent replay.
 *
 * Per spec-api-cache-and-revalidation §5.2 + §8.1.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Maximum acceptable clock skew between platform and subscriber. */
export const MAX_SIGNATURE_SKEW_SECONDS = 300;

/**
 * Sign a webhook outbound payload.
 *
 * @param secret   per-subscription shared secret (32 bytes / 64 hex chars).
 * @param rawBody  the request body as serialised JSON string. The signature
 *                 is computed over the body bytes verbatim — callers MUST
 *                 send the same exact bytes to the subscriber, otherwise
 *                 verification fails.
 * @param timestampSeconds  unix-seconds timestamp included in the
 *                          `X-Gatewaze-Timestamp` header. Defaults to now().
 * @returns hex-encoded SHA-256 HMAC.
 */
export function signWebhook(
  secret: string,
  rawBody: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): { signature: string; timestamp: number } {
  if (!secret) {
    throw new Error('webhook signing secret is empty');
  }
  const signature = createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest('hex');
  return { signature, timestamp: timestampSeconds };
}

/**
 * Verify a webhook inbound signature. Accepts multiple candidate secrets so
 * the platform's secret-rotation flow can accept both the current and
 * previous secret during the 24h overlap window.
 *
 * Returns false on:
 *   - empty / missing signature or timestamp
 *   - timestamp outside MAX_SIGNATURE_SKEW_SECONDS of `nowSeconds`
 *   - HMAC mismatch against every candidate secret
 *
 * Constant-time compare against each candidate.
 */
export function verifyWebhook(args: {
  signatureHex: string;
  timestampSeconds: number | string;
  rawBody: string;
  secrets: readonly string[];
  nowSeconds?: number;
  maxSkewSeconds?: number;
}): boolean {
  const {
    signatureHex,
    timestampSeconds,
    rawBody,
    secrets,
    nowSeconds = Math.floor(Date.now() / 1000),
    maxSkewSeconds = MAX_SIGNATURE_SKEW_SECONDS,
  } = args;

  if (!signatureHex || typeof signatureHex !== 'string') return false;
  if (!secrets || secrets.length === 0) return false;

  const ts = typeof timestampSeconds === 'string' ? Number.parseInt(timestampSeconds, 10) : timestampSeconds;
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowSeconds - ts) > maxSkewSeconds) return false;

  // Decode the candidate signature once. If the hex is malformed, fail closed.
  let sigBuf: Buffer;
  try {
    sigBuf = Buffer.from(signatureHex, 'hex');
  } catch {
    return false;
  }
  // Even-length hex required; Buffer.from silently accepts odd-length hex
  // by ignoring the last nibble, so guard explicitly.
  if (signatureHex.length === 0 || signatureHex.length % 2 !== 0) return false;
  if (sigBuf.length === 0) return false;

  for (const secret of secrets) {
    if (!secret) continue;
    const expected = createHmac('sha256', secret)
      .update(`${ts}.${rawBody}`)
      .digest();
    if (expected.length !== sigBuf.length) continue;
    // timingSafeEqual requires both buffers to be the same length, which
    // we just confirmed above.
    if (timingSafeEqual(sigBuf, expected)) return true;
  }
  return false;
}

/**
 * Generate a fresh per-subscription HMAC secret. 32 random bytes,
 * hex-encoded → 64-char string. Per spec §8.1.
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}
