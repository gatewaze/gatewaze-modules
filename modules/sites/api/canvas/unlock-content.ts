/**
 * POST /api/admin/pages/:id/canvas/unlock-content — emergency JSON-lock disable.
 * Per spec-sites-wysiwyg-builder §6.7.
 *
 * Requirements:
 *   - super_admin only (admin_profiles.is_active = true for the caller)
 *   - confirmation token must equal `unlock-${page.id}`
 *   - rate-limited: 5 req/hour per user
 *   - logs at WARN level with structured audit fields:
 *       { kind: 'sites.canvas.unlock-content', actor_id, target_id=page_id,
 *         metadata: { siteSlug, timestamp, jwt_claims } }
 *
 * Sets `pages.wysiwyg_locked = false`, allowing manual git edits to the
 * page's content/pages/<slug>.json. Used only when migrating off the
 * canvas; normal operation never calls this.
 */

import type { Request, Response, Router } from 'express';
import { assertCanvasEnabled } from './canvas-auth.js';

interface RequestWithUser extends Request {
  userId?: string; jwtClaims?: { email?: string };
}

interface ErrorEnvelope {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

function sendError(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  const body: ErrorEnvelope = { error: { code, message, ...(details ? { details } : {}) } };
  res.status(status).json(body);
}

function paramAs(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return undefined;
}

export interface UnlockContentDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any };
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Sliding-window rate-limiter; should return false to deny. */
  rateLimit: (key: string, max: number, windowMs: number) => boolean;
}

export function createUnlockContentRoute(deps: UnlockContentDeps) {
  return async function unlockContent(req: RequestWithUser, res: Response): Promise<void> {
    const userId = req.userId;
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const enabled = assertCanvasEnabled();
    if (!enabled.ok) return sendError(res, enabled.httpStatus, enabled.code, enabled.message);

    const pageId = paramAs(req.params.id);
    if (!pageId) return sendError(res, 400, 'invalid_input', 'page id required');

    if (!deps.rateLimit(`canvas:unlock-content:${userId}`, 5, 60 * 60 * 1000)) {
      return sendError(res, 429, 'rate_limited', 'unlock-content rate limit (5/hour) exceeded');
    }

    // Super-admin check.
    const adminRes = await deps.supabase
      .from('admin_profiles')
      .select('user_id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    const isAdmin = (adminRes as { data: { user_id: string } | null }).data !== null;
    if (!isAdmin) {
      deps.logger.warn('canvas.unlock-content.denied: not super admin', { userId, pageId });
      return sendError(res, 403, 'forbidden', 'super_admin role required for unlock-content');
    }

    // Body validation.
    const body = req.body as { confirmation?: unknown };
    const confirmation = typeof body.confirmation === 'string' ? body.confirmation : '';
    const expected = `unlock-${pageId}`;
    if (confirmation !== expected) {
      return sendError(res, 400, 'canvas.unlock_confirmation_mismatch',
        `confirmation must equal '${expected}'`);
    }

    // Resolve site slug for the audit log.
    const pageRes = await deps.supabase
      .from('pages')
      .select('id, site_id, wysiwyg_locked')
      .eq('id', pageId)
      .maybeSingle();
    const page = (pageRes as { data: { id: string; site_id: string; wysiwyg_locked: boolean } | null }).data;
    if (!page) return sendError(res, 404, 'not_found', 'page not found');

    const siteRes = await deps.supabase
      .from('sites')
      .select('slug')
      .eq('id', page.site_id)
      .maybeSingle();
    const siteSlug = (siteRes as { data: { slug: string } | null }).data?.slug ?? '<unknown>';

    // Flip the flag.
    const updateRes = await deps.supabase
      .from('pages')
      .update({ wysiwyg_locked: false })
      .eq('id', pageId);
    const updateErr = (updateRes as { error: { message: string } | null }).error;
    if (updateErr) {
      deps.logger.error('canvas.unlock-content.update_failed', { userId, pageId, error: updateErr.message });
      return sendError(res, 500, 'internal', updateErr.message);
    }

    // Structured audit log at WARN level (per spec). The platform's
    // log-collector picks this up; brand-side audit_events tables can
    // tail the structured stream into an audit_events row if installed.
    deps.logger.warn('canvas.unlock-content', {
      kind: 'sites.canvas.unlock-content',
      actor_id: userId,
      target_id: pageId,
      site_slug: siteSlug,
      previous_locked_state: page.wysiwyg_locked,
      timestamp: new Date().toISOString(),
    });

    res.status(200).json({
      pageId,
      wysiwyg_locked: false,
      previousState: page.wysiwyg_locked,
    });
  };
}

export function mountUnlockContentRoute(router: Router, handler: ReturnType<typeof createUnlockContentRoute>): void {
  router.post('/pages/:id/canvas/unlock-content', handler);
}
