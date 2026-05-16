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

import { Router, type Express } from 'express';
import { createClient } from '@supabase/supabase-js';
import {
  createAdminAiRoutes,
  mountAdminAiRoutes,
} from './admin-routes.js';

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

export function registerRoutes(app: Express): void {
  const logger = defaultLogger();

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

  const router = Router();
  const routes = createAdminAiRoutes({ supabase, logger, resolveFetchUrl });
  mountAdminAiRoutes(router, routes);
  app.use('/api/modules/ai', router);

  logger.info('ai routes registered');
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
