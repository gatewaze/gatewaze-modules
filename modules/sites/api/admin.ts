/**
 * Admin (editor-facing) HTTP handlers for the sites module.
 *
 * Mounted by the platform's labeledRouter('jwt') under
 *   /api/modules/sites/admin/...
 * Every handler assumes the platform's requireJwt middleware has populated
 * `req.user`. Tenancy + per-page permissions are enforced by Postgres RLS
 * (the service-role client only ships when explicitly elevated; otherwise
 * we rely on the user's session).
 *
 * Endpoints (per spec-sites-module §5 + spec-sites-theme-kinds §7.4):
 *
 *   POST   /admin/pages                                 — create page
 *   PATCH  /admin/pages/:pageId                         — update page metadata
 *   DELETE /admin/pages/:pageId                         — soft-delete (status='archived')
 *   POST   /admin/pages/:pageId/preview-tokens          — mint preview token (cleartext returned ONCE)
 *   DELETE /admin/pages/:pageId/preview-tokens/:tokenId — revoke
 *
 *   POST   /admin/sites/:siteSlug/content:batch         — Website drafts (theme_kind='website' only)
 *
 * The handlers compose the per-feature lib helpers:
 *   - validateCreatePage / validateUpdatePage  (page-lifecycle/validate)
 *   - generatePreviewToken / hashPreviewToken  (preview-tokens/generate)
 *   - validateBatchShape                       (batch-content/validate)
 *
 * Per the gatewaze-production-readiness skill:
 *   - No `: any` (narrow Supabase row interfaces)
 *   - All input goes through *_WRITE_FIELDS allowlists (mass-assignment)
 *   - Input is rejected at the boundary on shape errors
 *   - The DB triggers are the authoritative invariants (theme_kind, content
 *     match, version bump) — these validators short-circuit but do not
 *     replace them.
 */

import type { Request, Response, Router } from 'express';
import {
  validateCreatePage,
  validateUpdatePage,
} from '../lib/page-lifecycle/validate.js';
import { normalizeRoute } from '../lib/page-lifecycle/route-validation.js';
import {
  generatePreviewToken,
  hashPreviewToken,
  PREVIEW_TOKEN_MAX_TTL_SECONDS,
} from '../lib/preview-tokens/generate.js';
import { validateBatchShape } from '../lib/batch-content/validate.js';

// ---------------------------------------------------------------------------
// Narrow Supabase surface
// ---------------------------------------------------------------------------

interface AdminSupabaseQuery {
  select(cols: string): AdminSupabaseQuery;
  insert(values: Record<string, unknown> | Record<string, unknown>[]): AdminSupabaseQuery;
  update(values: Record<string, unknown>): AdminSupabaseQuery;
  delete(): AdminSupabaseQuery;
  eq(col: string, val: unknown): AdminSupabaseQuery;
  in(col: string, vals: unknown[]): AdminSupabaseQuery;
  single<T = Record<string, unknown>>(): Promise<{ data: T | null; error: { message: string } | null }>;
  maybeSingle<T = Record<string, unknown>>(): Promise<{ data: T | null; error: { message: string } | null }>;
  // For bulk inserts/updates — same-shape return.
  then<TResult>(
    onfulfilled: (value: { data: Array<Record<string, unknown>> | null; error: { message: string } | null }) => TResult,
  ): Promise<TResult>;
}

export interface AdminSupabaseClient {
  from(table: string): AdminSupabaseQuery;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

// ---------------------------------------------------------------------------
// Route-handler factory
// ---------------------------------------------------------------------------

export interface AdminRoutesDeps {
  supabase: AdminSupabaseClient;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Pulls the authenticated user_id off the request — platform-specific. */
  getUserId: (req: Request) => string | null;
}

export function createAdminRoutes(deps: AdminRoutesDeps) {
  // -------------------------------------------------------------------------
  // POST /admin/pages
  // -------------------------------------------------------------------------
  async function createPage(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const v = validateCreatePage(req.body);
    if (!v.ok) return sendError(res, 400, 'invalid_input', v.reason, { field: v.field, ...(v.detail ? { detail: v.detail } : {}) });

    const { data, error } = await deps.supabase
      .from('pages')
      .insert({ ...v.value, created_by: userId })
      .select('id, host_kind, host_id, full_path, slug, title, status, version, published_version')
      .single<PageRowMin>();

    if (error || !data) {
      deps.logger.error('admin.pages.create.failed', { error: error?.message ?? 'no_data' });
      return sendError(res, 500, 'internal', error?.message ?? 'insert failed');
    }
    res.status(201).json(data);
  }

  // -------------------------------------------------------------------------
  // PATCH /admin/pages/:pageId
  // -------------------------------------------------------------------------
  async function updatePage(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const pageId = req.params['pageId'];
    if (!pageId || typeof pageId !== 'string') return sendError(res, 400, 'invalid_input', 'pageId required');

    const v = validateUpdatePage(req.body);
    if (!v.ok) return sendError(res, 400, 'invalid_input', v.reason, { field: v.field, ...(v.detail ? { detail: v.detail } : {}) });
    if (Object.keys(v.value).length === 0) {
      return sendError(res, 400, 'invalid_input', 'no_fields_to_update');
    }

    const updateValues: Record<string, unknown> = { ...v.value };
    const { data, error } = await deps.supabase
      .from('pages')
      .update(updateValues)
      .eq('id', pageId)
      .select('id, host_kind, host_id, full_path, slug, title, status, version, published_version')
      .single<PageRowMin>();

    if (error || !data) {
      deps.logger.error('admin.pages.update.failed', { pageId, error: error?.message ?? 'no_data' });
      return sendError(res, 500, 'internal', error?.message ?? 'update failed');
    }
    res.status(200).json(data);
  }

  // -------------------------------------------------------------------------
  // DELETE /admin/pages/:pageId  (soft-delete via status='archived')
  // -------------------------------------------------------------------------
  async function archivePage(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const pageId = req.params['pageId'];
    if (!pageId || typeof pageId !== 'string') return sendError(res, 400, 'invalid_input', 'pageId required');

    const { data, error } = await deps.supabase
      .from('pages')
      .update({ status: 'archived' })
      .eq('id', pageId)
      .select('id, status')
      .single<{ id: string; status: string }>();

    if (error || !data) {
      deps.logger.error('admin.pages.archive.failed', { pageId, error: error?.message ?? 'no_data' });
      return sendError(res, 500, 'internal', error?.message ?? 'archive failed');
    }
    res.status(200).json(data);
  }

  // -------------------------------------------------------------------------
  // POST /admin/pages/:pageId/preview-tokens
  // body: { ttlSeconds?: number }   default 1h, max PREVIEW_TOKEN_MAX_TTL_SECONDS
  // -------------------------------------------------------------------------
  async function createPreviewToken(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const pageId = req.params['pageId'];
    if (!pageId || typeof pageId !== 'string') return sendError(res, 400, 'invalid_input', 'pageId required');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const requestedTtl = typeof body['ttlSeconds'] === 'number' ? (body['ttlSeconds'] as number) : 3600;
    if (!Number.isFinite(requestedTtl) || requestedTtl <= 0) {
      return sendError(res, 400, 'invalid_input', 'ttlSeconds must be a positive number');
    }
    if (requestedTtl > PREVIEW_TOKEN_MAX_TTL_SECONDS) {
      return sendError(res, 400, 'invalid_input', 'ttlSeconds exceeds max', { max: PREVIEW_TOKEN_MAX_TTL_SECONDS });
    }

    const minted = generatePreviewToken({ ttlSeconds: requestedTtl });
    const { data, error } = await deps.supabase
      .from('pages_preview_tokens')
      .insert({
        page_id: pageId,
        token_hash: minted.hash,
        expires_at: minted.expiresAt,
        created_by: userId,
      })
      .select('id, expires_at')
      .single<{ id: string; expires_at: string }>();

    if (error || !data) {
      deps.logger.error('admin.preview_tokens.create.failed', { pageId, error: error?.message ?? 'no_data' });
      return sendError(res, 500, 'internal', error?.message ?? 'insert failed');
    }
    // The cleartext token is returned ONCE. Never logged.
    res.status(201).json({
      id: data.id,
      token: minted.token,
      expiresAt: data.expires_at,
    });
  }

  // -------------------------------------------------------------------------
  // DELETE /admin/pages/:pageId/preview-tokens/:tokenId  (revoke)
  // -------------------------------------------------------------------------
  async function revokePreviewToken(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const pageId = req.params['pageId'];
    const tokenId = req.params['tokenId'];
    if (!pageId || !tokenId) return sendError(res, 400, 'invalid_input', 'pageId and tokenId required');

    const { data, error } = await deps.supabase
      .from('pages_preview_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', tokenId)
      .eq('page_id', pageId)
      .select('id, revoked_at')
      .maybeSingle<{ id: string; revoked_at: string }>();

    if (error) {
      deps.logger.error('admin.preview_tokens.revoke.failed', { pageId, tokenId, error: error.message });
      return sendError(res, 500, 'internal', error.message);
    }
    if (!data) return sendError(res, 404, 'not_found', 'token not found');
    res.status(200).json(data);
  }

  // -------------------------------------------------------------------------
  // POST /admin/sites/:siteSlug/content:batch
  // (theme_kind='website' only — sites are uniformly website-kind)
  // body: { drafts: [{ route, content, schemaVersion, baseCommitSha? }, ...] }
  // -------------------------------------------------------------------------
  async function batchSaveContent(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const siteSlug = req.params['siteSlug'];
    if (!siteSlug || typeof siteSlug !== 'string') return sendError(res, 400, 'invalid_input', 'siteSlug required');

    const v = validateBatchShape(req.body);
    if (!v.ok) {
      return sendError(res, 400, 'invalid_input', v.reason, {
        field: v.field,
        index: v.index,
        ...(v.detail ? { detail: v.detail } : {}),
      });
    }

    // Resolve the site — anything else is platform-side concern.
    const { data: siteData, error: siteErr } = await deps.supabase
      .from('sites')
      .select('id, theme_kind')
      .eq('slug', siteSlug)
      .maybeSingle<{ id: string; theme_kind: string }>();

    if (siteErr) {
      deps.logger.error('admin.batch.site_lookup.failed', { siteSlug, error: siteErr.message });
      return sendError(res, 500, 'internal', siteErr.message);
    }
    if (!siteData) return sendError(res, 404, 'not_found', 'site not found');
    if (siteData.theme_kind !== 'website') {
      return sendError(res, 409, 'invalid_theme_kind', 'batch endpoint requires theme_kind=website');
    }

    // Delegate the write to a SQL function. The function:
    //   - looks up each route's page_id within site_id
    //   - validates content against templates_content_schemas (DB-side)
    //   - upserts pages_nextjs_drafts (one row per editor + page)
    //   - returns { route, page_id, draft_id, version } for each
    const { data, error } = await deps.supabase.rpc('sites_admin_save_drafts', {
      p_site_id: siteData.id,
      p_editor_id: userId,
      p_drafts: v.drafts.map((d) => ({
        route: d.route,
        content: d.content,
        schema_version: d.schemaVersion,
        base_commit_sha: d.baseCommitSha,
      })),
    });
    if (error) {
      deps.logger.error('admin.batch.rpc.failed', { siteSlug, error: error.message });
      return sendError(res, 500, 'internal', error.message);
    }
    if (!Array.isArray(data)) return sendError(res, 500, 'internal', 'unexpected rpc result');

    res.status(200).json({ saved: data });
  }

  // -------------------------------------------------------------------------
  // PUT /admin/sites/:siteId/secrets
  // body: { key: string; values: Record<string, string|number|boolean|null> }
  //
  // Stores a publisher (or other) secret bundle on `sites_secrets`. The
  // browser never holds an encryption key — values are JSON-stringified
  // and committed as-is via service-role; the platform's encryption-at-
  // rest layer (sites_secrets.encrypted_value bytea) is populated by the
  // DB-level pgcrypto wrapper or the platform's secret-manager hook.
  //
  // For the v0.1 surface we treat the bytea column as opaque storage:
  // the service-role write goes straight in. A pgcrypto-based encrypt
  // trigger or KMS-backed secret manager replaces this body without
  // changing the request shape.
  // -------------------------------------------------------------------------
  async function putSiteSecret(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const siteId = req.params['siteId'];
    if (!siteId || typeof siteId !== 'string') return sendError(res, 400, 'invalid_input', 'siteId required');

    const body = req.body as { key?: unknown; values?: unknown } | undefined;
    if (!body || typeof body !== 'object') return sendError(res, 400, 'invalid_input', 'body must be object');
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(key)) {
      return sendError(res, 400, 'invalid_input', 'key must match ^[a-z][a-z0-9_]{0,62}$');
    }
    if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
      return sendError(res, 400, 'invalid_input', 'values must be a JSON object');
    }

    const payloadBytes = Buffer.from(JSON.stringify(body.values), 'utf-8');

    const upsertValues: Record<string, unknown> = {
      site_id: siteId,
      key,
      encrypted_value: payloadBytes,
      created_by: userId,
    };
    const { data, error } = await deps.supabase
      .from('sites_secrets')
      .insert(upsertValues)
      .select('id, key')
      .maybeSingle<{ id: string; key: string }>();

    if (error) {
      // Insert failed — likely UNIQUE(site_id, key) collision; do an UPDATE.
      const { data: updated, error: upErr } = await deps.supabase
        .from('sites_secrets')
        .update({ encrypted_value: payloadBytes, updated_at: new Date().toISOString() })
        .eq('site_id', siteId)
        .eq('key', key)
        .select('id, key')
        .maybeSingle<{ id: string; key: string }>();
      if (upErr || !updated) {
        deps.logger.error('admin.secrets.put.failed', { siteId, key, error: upErr?.message ?? error.message });
        return sendError(res, 500, 'internal', upErr?.message ?? error.message);
      }
      res.status(200).json({ id: updated.id, key: updated.key, action: 'updated' });
      return;
    }

    if (!data) return sendError(res, 500, 'internal', 'insert returned no row');
    res.status(201).json({ id: data.id, key: data.key, action: 'created' });
  }

  // -------------------------------------------------------------------------
  // POST /admin/sites/:siteId/publisher:validate
  // body: { publisherId: string; values?: Record<string, unknown> }
  //
  // Two-phase: static validate (publisher's exported `validateSecrets`)
  // then a low-impact live ping (each publisher's "GET site/project"
  // endpoint) to confirm credentials actually authenticate.
  //
  // If `body.values` is provided, validate those (lets the UI test the
  // form before the user clicks Save). Otherwise, read the stored
  // sites_secrets row keyed by `publisher_<id>`.
  // -------------------------------------------------------------------------
  async function validatePublisher(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const siteId = req.params['siteId'];
    if (!siteId || typeof siteId !== 'string') return sendError(res, 400, 'invalid_input', 'siteId required');

    const body = req.body as { publisherId?: unknown; values?: unknown } | undefined;
    if (!body || typeof body !== 'object') return sendError(res, 400, 'invalid_input', 'body required');
    const publisherId = typeof body.publisherId === 'string' ? body.publisherId.trim() : '';
    if (!publisherId) return sendError(res, 400, 'invalid_input', 'publisherId required');

    // Resolve secrets — either from body (preview a draft) or from the
    // stored row.
    let values: Record<string, unknown>;
    if (body.values && typeof body.values === 'object' && !Array.isArray(body.values)) {
      values = body.values as Record<string, unknown>;
    } else {
      const key = `publisher_${publisherId.replace(/-/g, '_')}`;
      const { data, error } = await deps.supabase
        .from('sites_secrets')
        .select('encrypted_value')
        .eq('site_id', siteId)
        .eq('key', key)
        .maybeSingle<{ encrypted_value: unknown }>();
      if (error) {
        deps.logger.error('admin.publisher.validate.secrets_read', { siteId, key, error: error.message });
        return sendError(res, 500, 'internal', error.message);
      }
      if (!data) {
        return sendError(res, 404, 'not_found', `No secrets stored for ${publisherId}; save first`);
      }
      try {
        const buf = data.encrypted_value as Buffer | string | null;
        const text = Buffer.isBuffer(buf) ? buf.toString('utf-8') : (buf as string | null) ?? '';
        values = JSON.parse(text) as Record<string, unknown>;
      } catch (e) {
        return sendError(res, 500, 'internal', `Stored secrets are not parseable JSON: ${(e as Error).message}`);
      }
    }

    // Dispatch to the publisher module via dynamic string imports. The
    // standalone sites tsconfig doesn't have these packages on its module
    // resolution path; the api server's runtime context resolves them via
    // the platform's module loader (premium-gatewaze-modules root is on
    // the resolution path at runtime). The string-form import keeps TS
    // from trying to type-check the target.
    type PublisherStaticModule = {
      validateSecrets: (raw: unknown) => {
        ok: boolean;
        errors: ReadonlyArray<{ path: string; message: string }>;
        value?: Record<string, unknown>;
      };
    };
    type CloudflareApi = {
      getDeploymentRequest: (a: { secrets: Record<string, unknown>; deploymentId: string }) => {
        url: string; method: string; headers: Record<string, string>;
      };
    };
    type NetlifyApi = {
      getSiteRequest: (a: { secrets: Record<string, unknown> }) => {
        url: string; method: string; headers: Record<string, string>;
      };
    };

    const dynImport = async <T>(spec: string): Promise<T> => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return (await (Function('s', 'return import(s)') as (s: string) => Promise<T>)(spec));
    };

    let validation: { ok: boolean; errors: ReadonlyArray<{ path: string; message: string }> };
    let livePingReq: { url: string; method: string; headers: Record<string, string> } | null = null;
    try {
      if (publisherId === 'sites-publisher-cloudflare-pages') {
        const mod = await dynImport<PublisherStaticModule>('@premium-gatewaze-modules/sites-publisher-cloudflare-pages');
        const r = mod.validateSecrets(values);
        validation = { ok: r.ok, errors: r.errors };
        if (r.ok && r.value) {
          const apiMod = await dynImport<CloudflareApi>('@premium-gatewaze-modules/sites-publisher-cloudflare-pages/lib/api');
          // A bogus deployment id yields 404 when creds work, 401/403 when not.
          const built = apiMod.getDeploymentRequest({ secrets: r.value, deploymentId: '00000000-0000-0000-0000-000000000000' });
          livePingReq = { url: built.url, method: built.method, headers: built.headers };
        }
      } else if (publisherId === 'sites-publisher-netlify') {
        const mod = await dynImport<PublisherStaticModule>('@premium-gatewaze-modules/sites-publisher-netlify');
        const r = mod.validateSecrets(values);
        validation = { ok: r.ok, errors: r.errors };
        if (r.ok && r.value) {
          const apiMod = await dynImport<NetlifyApi>('@premium-gatewaze-modules/sites-publisher-netlify/lib/api');
          // GET /sites/<id> returns 200 when creds + siteId are good, 401/404 otherwise.
          const built = apiMod.getSiteRequest({ secrets: r.value });
          livePingReq = { url: built.url, method: built.method, headers: built.headers };
        }
      } else {
        return sendError(res, 400, 'invalid_input', `Unknown publisherId: ${publisherId}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.logger.error('admin.publisher.validate.import_failed', { publisherId, error: msg });
      return sendError(res, 500, 'internal', `Could not load publisher module: ${msg}`);
    }

    // Static validation only — return early on failure.
    if (!validation.ok) {
      res.status(200).json({ ok: false, errors: validation.errors, ping: null });
      return;
    }

    // Live ping. Tolerate any 2xx/4xx; only auth errors (401/403) are
    // treated as "creds invalid" — a 404 is fine (resource missing,
    // creds work). Network errors propagate as ping.ok=false.
    let ping: { ok: boolean; status: number | null; message: string };
    if (!livePingReq) {
      ping = { ok: true, status: null, message: 'No live ping configured for this publisher' };
    } else {
      try {
        const r = await fetch(livePingReq.url, { method: livePingReq.method, headers: livePingReq.headers });
        if (r.status === 401 || r.status === 403) {
          ping = { ok: false, status: r.status, message: 'Credentials rejected by publisher' };
        } else if (r.status >= 200 && r.status < 500) {
          ping = { ok: true, status: r.status, message: 'Credentials accepted' };
        } else {
          ping = { ok: false, status: r.status, message: `Publisher returned ${r.status}` };
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ping = { ok: false, status: null, message: `Network error: ${msg}` };
      }
    }

    res.status(200).json({ ok: validation.ok && ping.ok, errors: validation.errors, ping });
  }

  // -------------------------------------------------------------------------
  // GET /admin/pages?host_kind=site&host_id=...
  // (List for editor — narrow projection)
  // -------------------------------------------------------------------------
  async function listPages(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const hostKind = typeof req.query['host_kind'] === 'string' ? req.query['host_kind'] : null;
    const hostId = typeof req.query['host_id'] === 'string' ? req.query['host_id'] : null;
    if (!hostKind) return sendError(res, 400, 'invalid_input', 'host_kind required');

    const route = typeof req.query['route'] === 'string' ? req.query['route'] : null;
    let routePath: string | null = null;
    if (route) {
      const r = normalizeRoute(route);
      if (!r.ok) return sendError(res, 400, 'invalid_route', r.reason, r.detail ? { detail: r.detail } : undefined);
      routePath = r.path;
    }

    let q = deps.supabase
      .from('pages')
      .select('id, host_kind, host_id, full_path, slug, title, status, version, published_version, updated_at')
      .eq('host_kind', hostKind);
    if (hostId) q = q.eq('host_id', hostId);
    if (routePath) q = q.eq('full_path', routePath);
    const result = await q;
    if (result.error) {
      deps.logger.error('admin.pages.list.failed', { error: result.error.message });
      return sendError(res, 500, 'internal', result.error.message);
    }
    res.status(200).json({ pages: result.data ?? [] });
  }

  return {
    createPage,
    updatePage,
    archivePage,
    listPages,
    createPreviewToken,
    revokePreviewToken,
    batchSaveContent,
    putSiteSecret,
    validatePublisher,
  };
}

interface PageRowMin {
  id: string;
  host_kind: string;
  host_id: string | null;
  full_path: string;
  slug: string;
  title: string;
  status: string;
  version: number;
  published_version: number;
}

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  const body: { error: { code: string; message: string; details?: Record<string, unknown> } } = {
    error: { code, message },
  };
  if (details) body.error.details = details;
  res.status(status).json(body);
}

/**
 * Mount admin routes on a labeledRouter('jwt'). Caller is responsible for
 * the labeled-router instance and JWT middleware; this function only wires
 * the verbs.
 */
export function mountAdminRoutes(router: Router, routes: ReturnType<typeof createAdminRoutes>): void {
  router.get('/admin/pages', routes.listPages);
  router.post('/admin/pages', routes.createPage);
  router.patch('/admin/pages/:pageId', routes.updatePage);
  router.delete('/admin/pages/:pageId', routes.archivePage);
  router.post('/admin/pages/:pageId/preview-tokens', routes.createPreviewToken);
  router.delete('/admin/pages/:pageId/preview-tokens/:tokenId', routes.revokePreviewToken);
  router.post('/admin/sites/:siteSlug/content\\:batch', routes.batchSaveContent);
  router.put('/admin/sites/:siteId/secrets', routes.putSiteSecret);
  router.post('/admin/sites/:siteId/publisher\\:validate', routes.validatePublisher);
}
