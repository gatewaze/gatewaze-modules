/**
 * Authorization helpers for canvas routes. Per spec-sites-wysiwyg-builder
 * §6.0 the route handlers MUST explicitly verify the caller can admin
 * the site backing the requested page — service-role JWTs bypass RLS
 * (used here so admin pages can read across hosts), so we cannot rely
 * on the RLS policy alone. Each handler calls `assertCanAdminSite()`
 * after JWT auth and rate-limiting.
 *
 * Implementation: calls the platform's `can_admin_site(p_user_id,
 * p_site_id)` SQL function via supabase.rpc. Returns true when the
 * caller is a super_admin or has an active grant on the site. If the
 * RPC is unavailable (e.g. older platform version), we fall back to
 * the admin_profiles row check (super_admin only) and DENY everything
 * else — fail-closed.
 */

import { canvasConfig } from './canvas-config.js';

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

interface Logger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export type CanvasAuthResult =
  | { ok: true }
  | { ok: false; httpStatus: number; code: string; message: string };

/**
 * Hard fail-closed if the canvas feature is disabled by env. Every
 * canvas handler invokes this first.
 */
export function assertCanvasEnabled(): CanvasAuthResult {
  if (!canvasConfig.enabled) {
    return { ok: false, httpStatus: 503, code: 'canvas.disabled', message: 'canvas editor is disabled in this environment' };
  }
  return { ok: true };
}

/**
 * Verify the caller is allowed to admin `siteId`. Returns ok=true on
 * success, or a structured error envelope the caller forwards via
 * sendError(). Logs at warn on denial so security review can audit.
 */
export async function assertCanAdminSite(
  deps: { supabase: SupabaseLike; logger: Logger },
  userId: string,
  siteId: string,
): Promise<CanvasAuthResult> {
  // Primary path: SQL function. The platform owns the policy.
  try {
    const rpc = await deps.supabase.rpc('can_admin_site', {
      p_user_id: userId,
      p_site_id: siteId,
    });
    if (!rpc.error) {
      const allowed = rpc.data === true;
      if (allowed) return { ok: true };
      deps.logger.warn('canvas.auth.denied', { userId, siteId, reason: 'can_admin_site=false' });
      return { ok: false, httpStatus: 403, code: 'forbidden', message: 'caller cannot admin this site' };
    }
    // RPC reported error — fall through to fallback path.
    deps.logger.warn('canvas.auth.rpc_error', { userId, siteId, error: rpc.error.message });
  } catch (err) {
    deps.logger.warn('canvas.auth.rpc_threw', { userId, siteId, err: err instanceof Error ? err.message : String(err) });
  }

  // Fallback: super_admin only. Fail-closed for site-scoped admins.
  const adminRes = await deps.supabase
    .from('admin_profiles')
    .select('user_id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();
  const isSuperAdmin = (adminRes as { data: { user_id: string } | null }).data !== null;
  if (isSuperAdmin) return { ok: true };

  deps.logger.warn('canvas.auth.denied_fallback', { userId, siteId, reason: 'no can_admin_site rpc + not super_admin' });
  return { ok: false, httpStatus: 403, code: 'forbidden', message: 'caller cannot admin this site' };
}
