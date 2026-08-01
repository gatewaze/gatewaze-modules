/**
 * Minimal in-memory sliding-window rate limiter (per API instance — not distributed). Keyed by an
 * arbitrary string (client IP). Adequate for gating this module's admin API prefix.
 */
const buckets = new Map<string, number[]>();

/** Returns true if this hit is allowed, false if `key` is over `max` hits in the last `windowMs`. */
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;
  const hits = (buckets.get(key) ?? []).filter((t) => t > cutoff);
  if (hits.length >= max) { buckets.set(key, hits); return false; }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.every((t) => t <= cutoff)) buckets.delete(k);
  }
  return true;
}

/** Best-effort client IP from proxy headers, falling back to the socket. */
export function clientIp(req: { headers?: Record<string, unknown>; ip?: string; socket?: { remoteAddress?: string } }): string {
  const fwd = req?.headers?.['x-forwarded-for'];
  // Prefer req.ip: the platform sets Express `trust proxy`, so req.ip is the
  // real client (a public-client-forged X-Forwarded-For is ignored). Raw XFF is
  // only a fallback for non-Express contexts, and is spoofable — never trust it
  // ahead of req.ip, or rate limits can be bypassed by rotating the header.
  return req?.ip || (typeof fwd === 'string' && fwd.split(',')[0]?.trim()) || req?.socket?.remoteAddress || 'unknown';
}
