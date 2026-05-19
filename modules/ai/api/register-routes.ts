// @ts-nocheck — depends on supabase-js + express; resolved at module-host install time.

/**
 * ai module — apiRoutes entry.
 *
 * Mounts admin endpoints under /api/modules/ai/admin/* (platform-labelled
 * 'jwt' so the JWT middleware gates these handlers).
 *
 * Optional fetch_url resolver: if SCRAPLING_FETCHER_URL and
 * SCRAPLING_INTERNAL_TOKEN are set, builds a resolveFetchUrl callback
 * that proxies fetch_url tool calls to scrapling-fetcher AND writes a
 * second ai_usage_events row tagged kind='tool' for cost attribution.
 */

// supabase-js >= 2.50 probes globalThis.WebSocket; shim it for Node.
if (typeof (globalThis as Record<string, unknown>).WebSocket === 'undefined') {
  (globalThis as Record<string, unknown>).WebSocket = class FakeWebSocket {
    addEventListener() {}
    removeEventListener() {}
    close() {}
    send() {}
  };
}

import express, { Router, type Express } from 'express';
import { createClient } from '@supabase/supabase-js';
import {
  createAdminAiRoutes,
  mountAdminAiRoutes,
} from './admin-routes.js';
import { mountSkillSourceRoutes } from './skill-sources.js';
import { mountSkillsRoutes } from './skills.js';
import { mountSkillWebhookRoute } from './skill-webhook.js';
import { mountRecipeSourceRoutes } from './recipe-sources.js';
import { mountRecipeWebhookRoute } from './recipe-webhook.js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

function defaultLogger(): PlatformLogger {
  return {
    info: (msg, meta) => console.log(`[ai] ${msg}`, meta ?? ''),
    warn: (msg, meta) => console.warn(`[ai] ${msg}`, meta ?? ''),
    error: (msg, meta) => console.error(`[ai] ${msg}`, meta ?? ''),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerRoutes(app: Express, ctx?: any): void {
  const logger = defaultLogger();

  // Job enqueue, provided by the platform's ModuleRuntimeContext (added
  // in shared/src/types/modules.ts + wired in api/src/server.ts).
  // Skill-sources Sync + post-create auto-sync route through this.
  // Fallback shim only fires if a deployment is somehow running
  // pre-bridge platform code — in that case sync silently no-ops with
  // a warning, but the rest of ai's surface stays up.
  const enqueueJob: (
    q: string,
    j: string,
    d: Record<string, unknown>,
  ) => Promise<{ id: string | undefined }> =
    ctx?.enqueueJob ?? (async (q: string, j: string) => {
      logger.warn(
        `enqueueJob shim hit — platform ctx didn't provide a queue bridge. queue='${q}' job='${j}'`,
      );
      return { id: undefined };
    });

  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !supabaseServiceKey) {
    logger.warn(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — ai module endpoints will fail',
    );
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Optional fetch_url resolver. When the use-case enables fetch_url
  // the runner will call this; otherwise it's not invoked.
  const scraplingUrl = process.env.SCRAPLING_FETCHER_URL ?? '';
  const scraplingToken = process.env.SCRAPLING_INTERNAL_TOKEN ?? '';
  const resolveFetchUrl = scraplingUrl && scraplingToken
    ? buildFetchUrlResolver(scraplingUrl, scraplingToken, logger)
    : undefined;
  if (!resolveFetchUrl) {
    logger.warn(
      'SCRAPLING_FETCHER_URL / SCRAPLING_INTERNAL_TOKEN not set — fetch_url tool disabled for all use-cases',
    );
  }

  // Optional gatewaze_search resolver. Backed by Serper.dev when
  // SERPER_API_KEY is configured, otherwise falls back to a DuckDuckGo
  // HTML scrape via scrapling-fetcher. GATEWAZE_SEARCH_BACKEND can
  // explicitly force 'serper' or 'ddg'.
  const serperKey = process.env.SERPER_API_KEY ?? '';
  const searchBackend = (process.env.GATEWAZE_SEARCH_BACKEND as
    | 'auto'
    | 'serper'
    | 'ddg'
    | undefined) ?? 'auto';
  let resolveGatewazeSearch: ReturnType<typeof import('../lib/gatewaze-search.js').buildGatewazeSearchResolver> | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildGatewazeSearchResolver } = require('../lib/gatewaze-search.js');
    resolveGatewazeSearch = buildGatewazeSearchResolver({
      serperApiKey: serperKey || undefined,
      backend: searchBackend,
      scraplingFetcherUrl: scraplingUrl || undefined,
      scraplingInternalToken: scraplingToken || undefined,
      logger,
    });
    logger.info('gatewaze_search resolver ready', {
      backend: searchBackend,
      serper_configured: Boolean(serperKey),
      ddg_available: Boolean(scraplingUrl && scraplingToken),
    });
  } catch (err) {
    logger.warn('failed to build gatewaze_search resolver', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const router = Router();
  const routes = createAdminAiRoutes({ supabase, logger, resolveFetchUrl, resolveGatewazeSearch });
  mountAdminAiRoutes(router, routes);

  // ── Skills subsystem (moved from editor-ai-copilot, Phase 2) ──────────
  //
  // The skill-sources router needs to decode the operator's JWT so the
  // handler knows who made the call (mirrors editor-ai-copilot's prior
  // mount). Signature verification is upstream; this just extracts the
  // sub claim to populate req.userId. We DON'T apply this to the
  // webhook router below — webhook callers authenticate via HMAC.
  function decodeJwt(req: { headers: Record<string, string | string[] | undefined>; userId?: string }, _res: unknown, next: () => void): void {
    const auth = req.headers['authorization'];
    const header = Array.isArray(auth) ? auth[0] : auth;
    if (header && header.startsWith('Bearer ')) {
      const parts = header.slice(7).split('.');
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8'));
          if (typeof payload.sub === 'string') req.userId = payload.sub;
        } catch {
          /* bad token — handler will return 401 */
        }
      }
    }
    next();
  }

  const skillsRouter: Router = express.Router();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  skillsRouter.use(decodeJwt as any);
  mountSkillSourceRoutes(skillsRouter, {
    supabase,
    // enqueueJob is provided by the module-runtime context but the ai
    // module's registerRoutes signature doesn't expose ctx today — wire
    // up via globalThis hook the worker module already publishes. Falls
    // back to a no-op shim if not present (manual sync still works
    // through the cron-style sync-skill-sources worker tick).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    enqueueJob,
  });
  mountSkillsRoutes(skillsRouter, { supabase });
  // Recipe sources + recipes mount under the same JWT-gated router so
  // they share the decodeJwt middleware. The handler enforces
  // admin_profiles membership; super-admin is only required for
  // create/update/delete of source rows (mirrors the skills surface).
  mountRecipeSourceRoutes(skillsRouter, {
    supabase,
    enqueueJob,
    resolveFetchUrl,
  });

  // Webhook receiver — separate router (no JWT decode), HMAC-authenticated.
  const webhookRouter: Router = express.Router();
  mountSkillWebhookRoute(webhookRouter, {
    supabase,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    enqueueJob,
  });
  mountRecipeWebhookRoute(webhookRouter, {
    supabase,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    enqueueJob,
  });
  app.use('/api/modules/ai/admin', webhookRouter);

  // Then mount the authed admin routes. Skills routes nested under
  // /api/modules/ai/admin/skill-sources + /api/modules/ai/admin/skills.
  app.use('/api/modules/ai/admin', skillsRouter);
  app.use('/api/modules/ai', router);

  logger.info('ai routes registered (including skills subsystem)');
}

/**
 * scrapling-fetcher direct-call resolver. Returns content already wrapped
 * for safe model consumption (status header + truncated body).
 *
 * TODO(post-bridge): switch this to gatewaze-fetch's public /api/v1/fetch
 * once the consumer migrations land — that path enables per-api-key
 * billing alongside our ai_usage_events row.
 */
function buildFetchUrlResolver(
  baseUrl: string,
  token: string,
  logger: PlatformLogger,
): (url: string, reason: string) => Promise<{
  ok: boolean;
  content: string;
  bytesIn: number;
  finalUrl: string;
  error?: string;
}> {
  const MAX_BYTES = 200_000;
  const TIMEOUT_MS = 20_000;
  return async (url, reason) => {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/fetch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-token': token,
        },
        body: JSON.stringify({ url, mode: 'fast', extract: ['html'], timeout_ms: TIMEOUT_MS - 1000 }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        logger.warn('ai.fetch_url.upstream_error', { url, status: response.status, text: text.slice(0, 400) });
        return {
          ok: false,
          content: '',
          bytesIn: 0,
          finalUrl: url,
          error: `upstream ${response.status}`,
        };
      }
      const data = (await response.json()) as {
        data?: { html?: string; final_url?: string; bytes_in?: number };
        warnings?: string[];
      };
      const html = data.data?.html ?? '';
      const truncated = html.length > MAX_BYTES ? html.slice(0, MAX_BYTES) + '\n[…truncated]' : html;
      const wrapped = wrapAsFetchedContent(data.data?.final_url ?? url, truncated, reason);
      return {
        ok: true,
        content: wrapped,
        bytesIn: data.data?.bytes_in ?? html.length,
        finalUrl: data.data?.final_url ?? url,
      };
    } catch (err) {
      logger.warn('ai.fetch_url.exception', {
        url,
        elapsed_ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        content: '',
        bytesIn: 0,
        finalUrl: url,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

function wrapAsFetchedContent(finalUrl: string, body: string, reason: string): string {
  return [
    `<fetched_content url="${escapeAttr(finalUrl)}" reason="${escapeAttr(reason)}">`,
    body,
    `</fetched_content>`,
  ].join('\n');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
