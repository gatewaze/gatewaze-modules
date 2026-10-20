/**
 * A fixed-window limiter per key, in process memory. Each api replica keeps
 * its own count, so the real ceiling is max × replicas; that is enough to stop
 * one admin spending the shared daily AI cap in a burst. The use case's
 * daily_cost_cap_micro_usd in ai_use_cases is the hard limit.
 */

export interface RateLimiter {
  take(key: string, now?: number): { ok: true } | { ok: false; retryAfterSec: number };
}

export function createRateLimiter(opts: { max: number; windowMs: number }): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    take(key, now = Date.now()) {
      // Drop expired windows so the map can't grow without bound.
      if (windows.size > 1000) {
        for (const [k, w] of windows) if (now - w.start >= opts.windowMs) windows.delete(k);
      }
      const w = windows.get(key);
      if (!w || now - w.start >= opts.windowMs) {
        windows.set(key, { start: now, count: 1 });
        return { ok: true };
      }
      if (w.count >= opts.max) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.start + opts.windowMs - now) / 1000)) };
      }
      w.count++;
      return { ok: true };
    },
  };
}
