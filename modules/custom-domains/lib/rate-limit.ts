// @ts-nocheck — express types are resolved at module-host install time.
/**
 * A small fixed-window limiter per client address, with no dependency:
 * this module declares none and the api image links only what modules
 * declare. It sits in front of the auth gate so a stranger cannot make
 * the api verify tokens as fast as they can send them. Per replica, in
 * memory; enough for an admin api, and the platform's own ingress limits
 * sit in front of it.
 */

import type { NextFunction, Request, Response } from 'express';

export function rateLimit(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let sweepAt = Date.now() + opts.windowMs;
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    if (now >= sweepAt) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      sweepAt = now + opts.windowMs;
    }
    const key = (req.ip ?? 'unknown').toString();
    const slot = hits.get(key);
    if (!slot || slot.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }
    slot.count += 1;
    if (slot.count > opts.max) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((slot.resetAt - now) / 1000)).toString());
      res.status(429).json({ error: 'rate_limited', message: 'too many requests' });
      return;
    }
    next();
  };
}
