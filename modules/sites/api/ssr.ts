/**
 * SSR HTTP handler — serves rendered HTML for a published page.
 *
 *   GET /api/modules/sites/render?host=<host>&path=<path>
 *
 * Mounted under labeledRouter('public'). The handler:
 *
 *   1. Resolves (host, path) → page row via SQL function `sites_render_resolve`
 *      (which considers custom_domains + slug + status='published')
 *   2. Returns 404 if no page or non-published; 410 if archived; 200 with HTML on hit
 *   3. Wires Cache-Control headers based on page-level cache hints
 *
 * The portal app's Next.js middleware is responsible for inbound custom-
 * domain rewrites — it forwards the original Host header, and this handler
 * uses that for resolution. Spec-sites-module §6.6.
 *
 * Legacy block-list path; sites are uniformly website-kind, so this is now
 * a fallback for non-site hosts. theme_kind='website' pages render in the
 * consumer's Next.js app via the runtime content API (see api/runtime.ts).
 */

import type { Request, Response, Router } from 'express';
import { renderPage, type RenderInput } from '../lib/renderer/index.js';
import { normalizeRoute } from '../lib/page-lifecycle/route-validation.js';

export interface SsrSupabaseClient {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface SsrRoutesDeps {
  supabase: SsrSupabaseClient;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Per-host rate-limit hook. Return false to short-circuit with 429. */
  checkRateLimit: (key: string) => Promise<boolean>;
  /** Default Cache-Control max-age (seconds) for non-personalized HTML. */
  defaultCacheMaxAge?: number;
}

interface ResolvedRender {
  // Shape returned by `sites_render_resolve`; mirrors the inputs to renderPage().
  page: RenderInput['page'] | null;
  site: RenderInput['site'];
  wrapper: RenderInput['wrapper'] | null;
  blocks: RenderInput['blocks'] | null;
  page_status: 'draft' | 'scheduled' | 'published' | 'archived' | null;
  /** Per-page or per-site cache override. Optional. */
  cache_max_age: number | null;
}

export function createSsrRoutes(deps: SsrRoutesDeps) {
  return {
    async getRender(req: Request, res: Response): Promise<void> {
      const host = typeof req.query['host'] === 'string' ? req.query['host'] : null;
      const pathQ = typeof req.query['path'] === 'string' ? req.query['path'] : null;
      if (!host || !pathQ) {
        return sendError(res, 400, 'invalid_input', 'host and path required');
      }
      const route = normalizeRoute(pathQ);
      if (!route.ok) {
        return sendError(res, 400, 'invalid_route', route.reason);
      }

      const ok = await deps.checkRateLimit(`ssr:${host}`);
      if (!ok) {
        res.setHeader('Retry-After', '60');
        return sendError(res, 429, 'rate_limited', 'Too many requests');
      }

      const { data, error } = await deps.supabase.rpc('sites_render_resolve', {
        p_host: host,
        p_path: route.path,
      });
      if (error) {
        deps.logger.error('ssr.resolve.failed', { host, path: route.path, error: error.message });
        return sendError(res, 500, 'internal', 'resolver failed');
      }
      const resolved = (data ?? null) as ResolvedRender | null;
      if (!resolved || !resolved.page) return sendError(res, 404, 'not_found', 'page not found');
      if (resolved.page_status === 'archived') return sendError(res, 410, 'gone', 'page archived');
      if (resolved.page_status !== 'published') return sendError(res, 404, 'not_found', 'page not published');
      if (!resolved.wrapper || !resolved.blocks) {
        deps.logger.error('ssr.resolve.missing_wrapper_or_blocks', { host, path: route.path });
        return sendError(res, 500, 'internal', 'malformed render input');
      }

      let rendered;
      try {
        rendered = renderPage({
          page: resolved.page,
          site: resolved.site,
          wrapper: resolved.wrapper,
          blocks: resolved.blocks,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        deps.logger.error('ssr.render.failed', { host, path: route.path, error: msg });
        return sendError(res, 500, 'internal', 'render failed');
      }

      const maxAge = resolved.cache_max_age ?? deps.defaultCacheMaxAge ?? 300;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
      res.setHeader('X-Render-Stats', `blocks=${rendered.stats.blocksRendered};bricks=${rendered.stats.bricksRendered}`);
      res.status(200).send(rendered.html);
    },
  };
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function mountSsrRoutes(router: Router, routes: ReturnType<typeof createSsrRoutes>): void {
  router.get('/render', routes.getRender);
}
