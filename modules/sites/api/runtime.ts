/**
 * Runtime content API HTTP handlers — mounted via the module's apiRoutes
 * callback under `/api/modules/sites/runtime/...`.
 *
 * Endpoints (per spec-sites-theme-kinds §7.2):
 *   POST /api/modules/sites/runtime/content        ← primary; resolves a route + RenderContext
 *   GET  /api/modules/sites/runtime/content        ← cache-friendly shortcut for non-personalized routes
 *   POST /api/modules/sites/runtime/ab-assign      ← variant assignment without content fetch
 *   POST /api/modules/sites/runtime/preview/validate ← Next.js draft mode handshake (§7.7)
 *
 * The handlers compose:
 *   - canonicalizeRenderContext (lib/runtime/render-context.ts)
 *   - selectVariant            (lib/runtime/variant-precedence.ts)
 *   - hashRuntimeApiKey/compareKeyHashes (lib/runtime/api-keys.ts)
 *   - the platform's labeledRouter, requireJwt-style middleware, rate limiter
 *   - a Supabase service-role client for DB reads
 *
 * The HTTP layer below is a reference implementation that can be wired in
 * by the platform's module loader. For v0.1, runtime-API endpoints are
 * marked `public` (anon-readable for published content; preview tokens
 * unlock drafts; API keys are validated per §9.0 inside the handlers, not
 * by the platform's JWT middleware).
 */

import type { Request, Response, Router } from 'express';
import { canonicalizeRenderContext } from '../lib/runtime/render-context.js';
import {
  extractBearerKey,
  hashRuntimeApiKey,
  compareKeyHashes,
  siteIdShortFromKey,
} from '../lib/runtime/api-keys.js';
import { selectVariant, type VariantCandidate } from '../lib/runtime/variant-precedence.js';

// ---------------------------------------------------------------------------
// Wire shapes (per spec §7.2)
// ---------------------------------------------------------------------------

export interface ContentRequest {
  site: string;       // site slug
  route: string;      // page path, e.g. '/' or '/for/developer'
  context?: unknown;  // RenderContext in flat OR nested form
}

export interface ContentResponse {
  schemaVersion: number;
  route: string;
  content: unknown;
  appliedContext: Record<string, string | number | boolean | null>;
  cacheHints: { maxAge: number; varyOn: string[] };
}

export interface RuntimeError {
  code: string;
  message: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Supabase client surface (narrow; pluggable for tests)
// ---------------------------------------------------------------------------

export interface RuntimeSupabaseClient {
  // Look up a site + its current content schema and pinned page content.
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): {
        eq(col: string, val: unknown): {
          maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
        };
        maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
      };
    };
  };
}

export interface RuntimeRoutesDeps {
  supabase: RuntimeSupabaseClient;
  /** Platform pepper for HMAC-SHA256 of API keys. */
  apiKeyPepper: Uint8Array;
  /** Logger (info/warn/error) — typically the platform's logger; tests can pass a stub. */
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Rate-limit hook. Return false to short-circuit with 429. */
  checkRateLimit: (key: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Handler factory: returns a function the module's apiRoutes callback can
// register on the platform's labeledRouter.
// ---------------------------------------------------------------------------

export function createRuntimeRoutes(deps: RuntimeRoutesDeps) {
  return {
    /** POST /runtime/content */
    async postContent(req: Request, res: Response): Promise<void> {
      const traceId = generateTraceId(req.headers['x-trace-id']);
      res.setHeader('X-Trace-Id', traceId);

      const body = req.body as ContentRequest | undefined;
      if (!body || typeof body !== 'object' || typeof body.site !== 'string' || typeof body.route !== 'string') {
        return sendError(res, 400, { code: 'invalid_input', message: 'site and route are required' });
      }
      if (!body.route.startsWith('/')) {
        return sendError(res, 400, { code: 'invalid_route', message: 'route must start with /' });
      }
      if (body.route.includes('..')) {
        return sendError(res, 400, { code: 'invalid_route', message: 'route must not contain ..' });
      }

      // 1. Canonicalize context.
      const ctxResult = canonicalizeRenderContext(body.context);
      if (!ctxResult.ok) {
        return sendError(res, 400, {
          code: ctxResult.reason,
          message: ctxResult.detail ?? ctxResult.reason,
        });
      }
      const context = ctxResult.canonical;

      // 2. Authenticate (optional). Anon callers see published content only.
      const auth = await authenticate(req, body.site, deps);
      if (auth.kind === 'invalid_key') {
        return sendError(res, 401, { code: 'invalid_api_key', message: 'API key is invalid' });
      }
      const previewToken = req.header('X-Preview-Token') ?? null;

      // 3. Rate limit (per-key for authenticated; per-IP for anon).
      const rateLimitKey =
        auth.kind === 'authenticated' ? `runtime:key:${auth.keyId}` : `runtime:ip:${ipFromReq(req)}`;
      const ok = await deps.checkRateLimit(rateLimitKey);
      if (!ok) {
        res.setHeader('Retry-After', '60');
        return sendError(res, 429, { code: 'rate_limited', message: 'Too many requests' });
      }

      // 4. Resolve site + page + content. Delegated to a SQL function so
      // the bulk of the work is one round-trip; the function returns
      // { schema_version, content, variants } or null.
      const { data, error } = await deps.supabase.rpc('sites_runtime_resolve_content', {
        p_site_slug: body.site,
        p_route: body.route,
        p_preview_token_hash: previewToken ? hashPreviewToken(previewToken) : null,
        p_authenticated: auth.kind === 'authenticated',
      });
      if (error) {
        deps.logger.error('runtime.content.rpc_failed', { traceId, error: error.message });
        return sendError(res, 500, { code: 'internal', message: 'resolver failed' });
      }
      if (!data || typeof data !== 'object') {
        return sendError(res, 404, { code: 'route_not_found', message: 'route not found' });
      }

      const resolved = data as {
        schema_version: number;
        base_content: Record<string, unknown>;
        variants_by_field: Record<string, VariantCandidate[]>;
        applicable_axes_by_field: Record<string, string[]>;
      };

      // 5. Apply variants per field path (in-process; the SQL function
      // pre-fetched candidate variants).
      const merged: Record<string, unknown> = structuredClone(resolved.base_content);
      const appliedContext: Record<string, string | number | boolean | null> = {};
      const varyAxes: Set<string> = new Set();

      for (const [fieldPath, variants] of Object.entries(resolved.variants_by_field ?? {})) {
        const winner = selectVariant(variants, context);
        if (winner) {
          setAtPath(merged, fieldPath, winner.content);
          for (const k of Object.keys(winner.match_context)) {
            const val = context[k];
            if (val !== undefined) appliedContext[k] = val;
          }
          for (const axis of resolved.applicable_axes_by_field[fieldPath] ?? []) {
            varyAxes.add(axis);
          }
        }
      }

      // 6. Cache hints — when ANY personalization applied, force private + Vary.
      const personalized = Object.keys(appliedContext).length > 0 || varyAxes.size > 0;
      const cacheHints = {
        maxAge: personalized ? 60 : 300,
        varyOn: Array.from(varyAxes).sort(),
      };
      res.setHeader(
        'Cache-Control',
        previewToken
          ? 'private, no-store'
          : personalized
            ? `private, max-age=${cacheHints.maxAge}`
            : `public, max-age=${cacheHints.maxAge}`,
      );
      if (personalized) res.setHeader('Vary', 'X-Render-Context-Hash');

      const response: ContentResponse = {
        schemaVersion: resolved.schema_version,
        route: body.route,
        content: merged,
        appliedContext,
        cacheHints,
      };
      res.status(200).json(response);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AnonAuth { kind: 'anon' }
interface KeyAuth { kind: 'authenticated'; keyId: string; siteId: string }
interface InvalidAuth { kind: 'invalid_key' }

async function authenticate(req: Request, siteSlug: string, deps: RuntimeRoutesDeps): Promise<AnonAuth | KeyAuth | InvalidAuth> {
  const bearer = extractBearerKey(req.header('Authorization'));
  if (!bearer) return { kind: 'anon' };

  const siteIdShort = siteIdShortFromKey(bearer);
  if (!siteIdShort) return { kind: 'invalid_key' };

  const expectedHash = hashRuntimeApiKey(bearer, deps.apiKeyPepper);

  // Look up the row by site + non-revoked key_hash. The query is narrow
  // because we know which site the key claims to belong to.
  const { data } = await deps.supabase
    .from('sites_runtime_api_keys')
    .select('id,site_id,key_hash')
    .eq('key_hash', expectedHash)
    .maybeSingle();
  if (!data || typeof data['site_id'] !== 'string' || typeof data['id'] !== 'string' || typeof data['key_hash'] !== 'string') {
    return { kind: 'invalid_key' };
  }
  // Constant-time compare as defense in depth (the indexed lookup may have
  // type-coerced or otherwise leaked timing info).
  if (!compareKeyHashes(data['key_hash'], expectedHash)) {
    return { kind: 'invalid_key' };
  }
  return { kind: 'authenticated', keyId: data['id'], siteId: data['site_id'] };
}

function generateTraceId(incoming: unknown): string {
  if (typeof incoming === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(incoming)) {
    return incoming;
  }
  // ULID-ish: timestamp-millis (10 chars Crockford32) + 16 random Crockford32.
  // Implementation is sufficient for tracing; not a true ULID library to avoid
  // pulling in a dependency.
  const t = Date.now().toString(32).toUpperCase().padStart(10, '0').slice(-10);
  const r = randomBase32(16);
  return t + r;
}

function randomBase32(len: number): string {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

function ipFromReq(req: Request): string {
  const xff = req.header('X-Forwarded-For');
  if (xff) return xff.split(',')[0]?.trim() ?? 'unknown';
  return req.ip ?? 'unknown';
}

function hashPreviewToken(token: string): string {
  // SHA-256 of the cleartext (not HMAC) — the token itself is a 256-bit
  // random value generated by the editor and the DB stores the hash. Per
  // sites spec §9.5 production-readiness: tokens never persisted in
  // cleartext.
  // Note: this depends on node:crypto already being imported via api-keys.ts.
  // We re-import here to keep this file standalone.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as { createHash: (algo: string) => { update(s: string, enc: string): { digest(format: string): string } } };
  return createHash('sha256').update(token, 'utf-8').digest('hex');
}

function setAtPath(obj: Record<string, unknown>, jsonPointer: string, value: unknown): void {
  // jsonPointer like '/hero/title' — strip leading '/', split on '/'.
  const parts = jsonPointer.replace(/^\//, '').split('/').map(unescapePointer);
  let node: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!k) continue;
    if (typeof node !== 'object' || node === null) return;
    const next = (node as Record<string, unknown>)[k];
    if (typeof next !== 'object' || next === null) return;
    node = next;
  }
  const last = parts[parts.length - 1];
  if (last && typeof node === 'object' && node !== null) {
    (node as Record<string, unknown>)[last] = value;
  }
}

function unescapePointer(s: string): string {
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}

function sendError(res: Response, status: number, err: RuntimeError): void {
  res.status(status).json({ error: err });
}

/**
 * Stub `apiRoutes` mount. The platform invokes `apiRoutes(app, runtimeCtx)`
 * at module-enable time; sites' apiRoutes callback should:
 *
 *   1. Build a labeledRouter('public') for the runtime endpoints
 *   2. Call createRuntimeRoutes() with platform-supplied deps
 *   3. Mount the router at `/api/modules/sites/runtime`
 *   4. Build a labeledRouter('jwt') for admin endpoints (PR 12)
 *   5. Mount under `/api/modules/sites`
 *
 * The actual mounting glue lives in the module's index.ts apiRoutes
 * callback once the platform's `labeledRouter` import is wired in.
 */
export function mountRuntimeRoutes(router: Router, routes: ReturnType<typeof createRuntimeRoutes>): void {
  router.post('/runtime/content', routes.postContent.bind(routes));
}
