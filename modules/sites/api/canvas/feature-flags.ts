/**
 * GET /api/admin/feature-flags
 *
 * Tiny read endpoint exposing the sites-module canvas feature flag (and
 * any future flags) so the admin UI can hide unsupported tabs without
 * baking process.env into the bundled JS. Per spec-sites-wysiwyg-builder
 * §6.0.
 *
 * Auth: requires a JWT (the platform's middleware) — we don't surface
 * the kill switch to anonymous callers, even though the value is
 * non-sensitive, because anyone able to query the admin namespace is
 * already authenticated.
 */

import type { Request, Response, Router } from 'express';
import { canvasConfig } from './canvas-config.js';

interface RequestWithUser extends Request {
  userId?: string;
}

export interface FeatureFlagsResponse {
  canvas_enabled: boolean;
  canvas_op_batch_max: number;
  canvas_block_count_max: number;
  canvas_lock_ttl_seconds: number;
  /** Per spec-builder-evaluation §3.7. */
  canvas_engine_default: 'legacy' | 'puck';
}

export function createFeatureFlagsRoute() {
  return function featureFlags(req: RequestWithUser, res: Response): void {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: { code: 'unauthenticated', message: 'session required' } });
      return;
    }
    const body: FeatureFlagsResponse = {
      canvas_enabled: canvasConfig.enabled,
      canvas_op_batch_max: canvasConfig.opBatchMax,
      canvas_block_count_max: canvasConfig.blockCountMax,
      canvas_lock_ttl_seconds: canvasConfig.lockTtlSeconds,
      canvas_engine_default: canvasConfig.engineDefault,
    };
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.status(200).json(body);
  };
}

export function mountFeatureFlagsRoute(router: Router, handler: ReturnType<typeof createFeatureFlagsRoute>): void {
  router.get('/feature-flags', handler);
}
