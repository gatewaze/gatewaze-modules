// @ts-nocheck
/**
 * Minimal in-memory sliding-window rate limiter (per API instance — not distributed; adequate for a
 * single module API process). Keyed by an arbitrary string (client IP or user id).
 */
const buckets = new Map<string, number[]>();

/** Returns true if this hit is allowed, false if the key is over `max` hits in the last `windowMs`. */
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;
  const hits = (buckets.get(key) ?? []).filter((t) => t > cutoff);
  if (hits.length >= max) { buckets.set(key, hits); return false; }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) {                       // opportunistic cleanup of stale keys
    for (const [k, v] of buckets) if (v.every((t) => t <= cutoff)) buckets.delete(k);
  }
  return true;
}

/** Best-effort client IP from proxy headers, falling back to the socket. */
export function clientIp(req: unknown): string {
  const r = req as { headers?: Record<string, string>; ip?: string; socket?: { remoteAddress?: string } };
  const fwd = r?.headers?.['x-forwarded-for'];
  // Prefer req.ip: the platform sets Express `trust proxy`, so req.ip is the
  // real client (a public-client-forged X-Forwarded-For is ignored). Raw XFF is
  // only a fallback for non-Express contexts, and is spoofable — never trust it
  // ahead of req.ip, or rate limits can be bypassed by rotating the header.
  return r?.ip || (typeof fwd === 'string' && fwd.split(',')[0]?.trim()) || r?.socket?.remoteAddress || 'unknown';
}
