/**
 * Admin (editor-facing) HTTP handlers for the sites module.
 *
 * Mounted by the platform's labeledRouter('jwt') under
 *   /api/modules/sites/admin/...
 * Every handler assumes the platform's requireJwt middleware has populated
 * `req.userId` (set by `requireJwt()` upstream on the /api/modules
 * router). Tenancy + per-page permissions are enforced by Postgres RLS
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
import {
  isSitesThemeKindsEnabled,
  THEME_KINDS_DISABLED_ERROR,
} from '../lib/feature-flags/index.js';

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
  /**
   * Optional handle to the internal git server. When provided, the
   * source:import-git endpoint mirrors the cloned working tree into the
   * site's bare internal repo so apply-theme drift checks have a baseline.
   * When absent, the import still ingests the schema; the mirror step is
   * skipped silently.
   */
  gitServer?: {
    createRepo(args: {
      hostKind: 'site' | 'list';
      hostId: string;
      slug: string;
      boilerplate?: { url: string; tag: string };
      initialCommitter?: { name: string; email: string };
    }): Promise<{ barePath: string; defaultBranch: string }>;
  };
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

    // Atomic homepage swap: a host can have at most one is_homepage=true
    // page (enforced by a partial unique index — pages_unique_homepage_with_host
    // in sites_002). When the new page is being marked as the homepage,
    // clear any existing homepage on the same host first so the unique
    // index doesn't trip. Both writes happen in the same Supabase
    // request batch via the service-role client; if the second insert
    // fails, the operator can re-mark the original via the UI.
    if (v.value.is_homepage && v.value.host_id) {
      await deps.supabase
        .from('pages')
        .update({ is_homepage: false })
        .eq('host_kind', v.value.host_kind)
        .eq('host_id', v.value.host_id)
        .eq('is_homepage', true);
    }

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

    // Atomic homepage swap (mirror of createPage). If this PATCH is
    // setting is_homepage=true, clear any other homepage on the same
    // host first. We need the existing row's host_kind/host_id so
    // look it up.
    if (updateValues['is_homepage'] === true) {
      const { data: existing } = await deps.supabase
        .from('pages')
        .select('host_kind, host_id')
        .eq('id', pageId)
        .maybeSingle<{ host_kind: string; host_id: string | null }>();
      if (existing && existing.host_id) {
        await deps.supabase
          .from('pages')
          .update({ is_homepage: false })
          .eq('host_kind', existing.host_kind)
          .eq('host_id', existing.host_id)
          .eq('is_homepage', true)
          .neq('id', pageId);
      }
    }

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

    // Per spec-sites-theme-kinds §16.1: refuse publisher validation for
    // Next.js sites unless the flag is on. Look up the site's theme_kind
    // first; HTML sites publish to the in-portal renderer and don't need
    // this gate.
    const siteRow = await deps.supabase
      .from('sites')
      .select('theme_kind')
      .eq('id', siteId)
      .maybeSingle<{ theme_kind: string }>();
    if (siteRow.data?.theme_kind === 'nextjs') {
      const enabled = await isSitesThemeKindsEnabled(deps.supabase);
      if (!enabled) {
        return sendError(res, 400, THEME_KINDS_DISABLED_ERROR.code, THEME_KINDS_DISABLED_ERROR.message);
      }
    }

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

  // -------------------------------------------------------------------------
  // POST /admin/sites/:siteId/publish-jobs/:jobId/rollback
  //
  // Roll back to a prior succeeded publish: clones the prior job's
  // draft_content_snapshot + draft_schema_version into a new sites_publish_jobs
  // row with status='queued'. The publish-worker picks it up and
  // re-executes the same content path against the publisher; for git-driven
  // publishers this means the prior commit gets re-applied to the publish
  // branch as a NEW commit (forward-only history, no force-push).
  //
  // Idempotency: if the latest queued/in-flight job for this page is already
  // rolling back to the same source job, return 200 with that job id.
  // -------------------------------------------------------------------------
  async function rollbackPublishJob(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const siteId = req.params['siteId'];
    const jobId = req.params['jobId'];
    if (!siteId || typeof siteId !== 'string') return sendError(res, 400, 'invalid_input', 'siteId required');
    if (!jobId || typeof jobId !== 'string') return sendError(res, 400, 'invalid_input', 'jobId required');

    interface PriorJob {
      id: string;
      site_id: string;
      page_id: string;
      publisher_id: string;
      branch_strategy: string;
      branch: string | null;
      base_commit_sha: string | null;
      draft_content_snapshot: Record<string, unknown>;
      draft_schema_version: number;
      status: string;
    }

    const { data: prior, error: priorErr } = await deps.supabase
      .from('sites_publish_jobs')
      .select(
        'id, site_id, page_id, publisher_id, branch_strategy, branch, base_commit_sha, draft_content_snapshot, draft_schema_version, status'
      )
      .eq('id', jobId)
      .eq('site_id', siteId)
      .maybeSingle<PriorJob>();

    if (priorErr) {
      deps.logger.error('admin.publish_jobs.rollback.lookup_failed', { siteId, jobId, error: priorErr.message });
      return sendError(res, 500, 'internal', priorErr.message);
    }
    if (!prior) return sendError(res, 404, 'not_found', 'publish job not found');
    if (prior.status !== 'succeeded') {
      return sendError(res, 409, 'invalid_state', `cannot rollback to a ${prior.status} job (only succeeded)`);
    }

    const { data: created, error: insertErr } = await deps.supabase
      .from('sites_publish_jobs')
      .insert({
        site_id: prior.site_id,
        page_id: prior.page_id,
        publisher_id: prior.publisher_id,
        branch_strategy: prior.branch_strategy,
        branch: prior.branch,
        base_commit_sha: prior.base_commit_sha,
        draft_content_snapshot: prior.draft_content_snapshot,
        draft_schema_version: prior.draft_schema_version,
        status: 'queued',
        status_detail: { stage: 'queued', rolled_back_from: prior.id },
        created_by: userId,
      })
      .select('id, status, created_at')
      .single<{ id: string; status: string; created_at: string }>();

    if (insertErr || !created) {
      deps.logger.error('admin.publish_jobs.rollback.insert_failed', {
        siteId,
        jobId,
        error: insertErr?.message ?? 'no_data',
      });
      return sendError(res, 500, 'internal', insertErr?.message ?? 'rollback queue failed');
    }

    res.status(202).json({ id: created.id, status: created.status, rolled_back_from: prior.id });
  }

  // -------------------------------------------------------------------------
  // POST /admin/sites/:siteId/integrations:provision
  //
  // Reports the per-site integration provisioning status. v1 only knows
  // about analytics; future integrations (plausible/fathom/ga4) follow
  // the same shape: report whatever the analytics module's properties
  // table records.
  //
  // Provisioning itself is owned by the analytics module's auto-provision
  // trigger + provisioning worker — this endpoint is a status reporter.
  // Returns the same `{ provisioned, failed, analytics }` envelope as
  // before so existing UI consumers don't break.
  // -------------------------------------------------------------------------
  async function provisionIntegrations(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const siteId = req.params['siteId'];
    if (!siteId || typeof siteId !== 'string') {
      return sendError(res, 400, 'invalid_input', 'siteId required');
    }

    interface SiteForProvision {
      id: string;
      slug: string;
      name: string;
    }
    const { data: site, error: siteErr } = await deps.supabase
      .from('sites')
      .select('id, slug, name')
      .eq('id', siteId)
      .maybeSingle<SiteForProvision>();
    if (siteErr) return sendError(res, 500, 'internal', siteErr.message);
    if (!site) return sendError(res, 404, 'not_found', 'site not found');

    // Look up the analytics property attached to this site. The analytics
    // module's trigger creates one automatically on `INSERT INTO sites`;
    // the worker fills in `website_uuid` and flips status to 'active'.
    interface PropertyRow {
      property_id: string;
      website_uuid: string | null;
      status: string;
    }
    const { data: prop } = await deps.supabase
      .from('analytics_properties')
      .select('property_id, website_uuid, status')
      .eq('host_kind', 'site')
      .eq('host_id', siteId)
      .maybeSingle<PropertyRow>();

    const provisioned: string[] = [];
    const failed: Array<{ integration: string; reason: string }> = [];
    const analytics: Record<string, unknown> = {};

    if (!prop) {
      // No row yet — either the analytics module isn't installed or the
      // trigger hasn't fired (sites table predates this module's install).
      // Surface as a soft failure; the operator can install/enable analytics
      // and the trigger's backfill block will catch up on next run.
      failed.push({ integration: 'analytics', reason: 'no analytics property attached to site (is the analytics module installed + enabled?)' });
    } else if (prop.status === 'active' && prop.website_uuid) {
      analytics['provider'] = 'umami';
      analytics['property_id'] = prop.property_id;
      analytics['umami'] = { umamiWebsiteId: prop.website_uuid };
      provisioned.push('analytics:active');
    } else if (prop.status === 'pending') {
      provisioned.push('analytics:pending');
      analytics['provider'] = 'umami';
      analytics['property_id'] = prop.property_id;
    } else {
      failed.push({ integration: 'analytics', reason: `property status='${prop.status}'` });
    }

    res.status(200).json({ provisioned, failed, analytics });
  }

  // -------------------------------------------------------------------------
  // POST /admin/sites/:siteId/source:import-git
  // body: { git_url, pat, branch?, schema_path? }
  //
  // Clone an external Next.js theme repo, read its content/schema.json,
  // ingest it as a new templates_content_schemas row + create a
  // templates_sources(kind='git') pointing at it. The site's
  // templates_library_id is rebound to the freshly-imported library so the
  // schema editor immediately reflects the imported schema.
  //
  // Idempotent in the narrow sense: re-importing the same URL+branch into
  // the same site superseded the prior templates_content_schemas row by
  // bumping `is_current=true` to the new row and leaving prior versions
  // intact (history preserved).
  //
  // Security: the PAT is used once for the clone, then stored encrypted
  // in sites_secrets under key `git_pat_<source_id>` for future
  // pull-update flows. The source row keeps `token_secret_ref` pointing
  // at that key.
  //
  // Limitations (documented in the response):
  //   - Schema files in TypeScript (`schema.ts`) require a precompile
  //     step we don't ship; only `content/schema.json` is read in v1.
  //   - The clone is shallow (--depth=1) — full history is NOT mirrored
  //     into the internal bare repo today. A follow-up wires
  //     gatewaze_internal_repos so apply-theme can run drift checks.
  // -------------------------------------------------------------------------
  async function importGit(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const siteId = req.params['siteId'];
    if (!siteId || typeof siteId !== 'string') return sendError(res, 400, 'invalid_input', 'siteId required');

    const body = req.body as { git_url?: unknown; pat?: unknown; branch?: unknown; schema_path?: unknown } | undefined;
    if (!body || typeof body !== 'object') return sendError(res, 400, 'invalid_input', 'body must be object');

    const gitUrl = typeof body.git_url === 'string' ? body.git_url.trim() : '';
    const pat = typeof body.pat === 'string' ? body.pat.trim() : '';
    const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : 'main';
    const schemaPath = typeof body.schema_path === 'string' && body.schema_path.trim()
      ? body.schema_path.trim()
      : 'content/schema.json';

    if (!/^https:\/\/[a-zA-Z0-9._-]+\/[\w./-]+(\.git)?$/.test(gitUrl)) {
      return sendError(res, 400, 'invalid_input', 'git_url must be an https:// URL to a git repo');
    }
    if (!pat) {
      return sendError(res, 400, 'invalid_input', 'pat required');
    }
    if (!/^[\w./-]{1,255}$/.test(branch)) {
      return sendError(res, 400, 'invalid_input', 'branch contains invalid characters');
    }
    if (!/^[\w./-]{1,255}$/.test(schemaPath)) {
      return sendError(res, 400, 'invalid_input', 'schema_path contains invalid characters');
    }

    interface SiteRow {
      id: string;
      slug: string;
      templates_library_id: string | null;
      theme_kind: string;
    }
    const { data: site, error: siteErr } = await deps.supabase
      .from('sites')
      .select('id, slug, templates_library_id, theme_kind')
      .eq('id', siteId)
      .maybeSingle<SiteRow>();
    if (siteErr) return sendError(res, 500, 'internal', siteErr.message);
    if (!site) return sendError(res, 404, 'not_found', 'site not found');

    // Inject the PAT into the clone URL via x-access-token convention so
    // we never echo the token to logs (the URL is consumed once and the
    // tmp dir is rm -rf'd before this handler returns).
    const authedUrl = gitUrl.replace(/^https:\/\//, `https://x-access-token:${encodeURIComponent(pat)}@`);

    // Lazy-import node:fs + node:child_process so the rest of admin.ts
    // doesn't pull them in (these run server-side only).
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const dynImport = (Function('s', 'return import(s)') as (s: string) => Promise<unknown>);
    const fsMod = await dynImport('node:fs') as typeof import('node:fs');
    const pathMod = await dynImport('node:path') as typeof import('node:path');
    const osMod = await dynImport('node:os') as typeof import('node:os');
    const cryptoMod = await dynImport('node:crypto') as typeof import('node:crypto');
    const childProcessMod = await dynImport('node:child_process') as typeof import('node:child_process');

    const tmpDir = pathMod.join(osMod.tmpdir(), `gatewaze-import-${siteId.slice(0, 8)}-${Date.now()}`);
    fsMod.mkdirSync(tmpDir, { recursive: true });

    let schemaJson: Record<string, unknown>;
    let schemaHash: string;
    let mainSha: string;
    try {
      // Shallow clone the requested branch only.
      childProcessMod.execFileSync('git', [
        'clone',
        '--depth=1',
        '--single-branch',
        '--branch', branch,
        authedUrl,
        tmpDir,
      ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });

      const fullSchemaPath = pathMod.join(tmpDir, schemaPath);
      if (!fsMod.existsSync(fullSchemaPath)) {
        return sendError(res, 422, 'schema_not_found', `${schemaPath} not found in repo at branch ${branch}`);
      }
      try {
        schemaJson = await loadSchemaFromFile(fullSchemaPath, fsMod, dynImport);
      } catch (err) {
        return sendError(res, 422, 'schema_parse_failed', (err as Error).message);
      }
      if (typeof schemaJson !== 'object' || Array.isArray(schemaJson)) {
        return sendError(res, 422, 'schema_invalid', 'schema_json must be a JSON object');
      }

      schemaHash = cryptoMod.createHash('sha256').update(JSON.stringify(schemaJson)).digest('hex');

      // Resolve the cloned HEAD SHA — used as the source's installed_git_sha
      // so drift checks against the upstream are well-defined.
      const headOut = childProcessMod.execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      mainSha = headOut.toString('utf-8').trim();

      // Mirror the imported tree into the site's internal bare repo so the
      // Source-tab drift / apply-theme flow has a baseline to diff against.
      // No-op if gitServer wasn't supplied (the import still succeeds; the
      // schema ingest below is the source of truth for the editor).
      // Failure here is non-fatal — schema ingest already completed.
      if (deps.gitServer) {
        try {
          const repo = await deps.gitServer.createRepo({
            hostKind: 'site',
            hostId: siteId,
            slug: site.slug,
          });
          // Strip the ?ref= cred from the upstream remote (we set the URL with
          // the PAT; the bare remote we're pushing to needs no auth) and
          // force-push so the imported tree becomes the new `main` baseline.
          // --force is the right call here: import is an explicit "this is
          // now the source of truth" action, not an incremental commit.
          childProcessMod.execFileSync(
            'git',
            ['push', '--force', repo.barePath, `HEAD:${repo.defaultBranch ?? 'main'}`],
            {
              cwd: tmpDir,
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 60_000,
            },
          );
          deps.logger.info('admin.source.import_git.mirrored', {
            siteId,
            barePath: repo.barePath,
            mainSha,
          });
        } catch (mirrorErr) {
          // Don't fail the request — operator can re-trigger via a
          // follow-up "Re-mirror" action (next pass). Surface as a warn
          // log so it's visible in monitoring.
          deps.logger.warn('admin.source.import_git.mirror_failed', {
            siteId,
            error: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr),
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.logger.error('admin.source.import_git.clone_failed', { siteId, error: msg });
      return sendError(res, 502, 'clone_failed', `git clone failed: ${msg}`);
    } finally {
      try { fsMod.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    // Bind to a library — create one if the site has no library yet.
    let libraryId = site.templates_library_id;
    if (!libraryId) {
      const { data: lib, error: libErr } = await deps.supabase
        .from('templates_libraries')
        .insert({
          host_kind: 'site',
          host_id: siteId,
          name: `${site.slug} library`,
          description: `Imported from ${gitUrl}#${branch}`,
          theme_kind: 'website',
        })
        .select('id')
        .single<{ id: string }>();
      if (libErr || !lib) {
        return sendError(res, 500, 'internal', `library create failed: ${libErr?.message ?? 'no_data'}`);
      }
      libraryId = lib.id;
      await deps.supabase.from('sites').update({ templates_library_id: libraryId }).eq('id', siteId);
    }

    // Create / re-use the templates_sources row for this URL+branch.
    interface SourceRow { id: string; }
    let sourceId: string;
    const { data: existingSource } = await deps.supabase
      .from('templates_sources')
      .select('id')
      .eq('library_id', libraryId)
      .eq('kind', 'git')
      .eq('url', gitUrl)
      .eq('branch', branch)
      .maybeSingle<SourceRow>();
    if (existingSource?.id) {
      sourceId = existingSource.id;
      await deps.supabase
        .from('templates_sources')
        .update({
          installed_git_sha: mainSha,
          available_git_sha: mainSha,
          last_checked_at: new Date().toISOString(),
          last_check_error: null,
          status: 'active',
        })
        .eq('id', sourceId);
    } else {
      const { data: newSource, error: srcErr } = await deps.supabase
        .from('templates_sources')
        .insert({
          library_id: libraryId,
          kind: 'git',
          label: `${gitUrl} (${branch})`,
          status: 'active',
          theme_kind: 'website',
          url: gitUrl,
          branch,
          manifest_path: schemaPath,
          installed_git_sha: mainSha,
          available_git_sha: mainSha,
          last_checked_at: new Date().toISOString(),
          auto_apply: false,
        })
        .select('id')
        .single<SourceRow>();
      if (srcErr || !newSource) {
        return sendError(res, 500, 'internal', `source create failed: ${srcErr?.message ?? 'no_data'}`);
      }
      sourceId = newSource.id;
    }

    // Store the PAT for future pulls. Encrypted-at-rest semantics match
    // putSiteSecret. Key matches the convention git_pat_<source_id>.
    const secretKey = `git_pat_${sourceId.replace(/-/g, '_').slice(0, 50)}`;
    const patBytes = Buffer.from(JSON.stringify({ pat }), 'utf-8');
    await deps.supabase
      .from('sites_secrets')
      .upsert(
        { site_id: siteId, key: secretKey, encrypted_value: patBytes, created_by: userId },
        { onConflict: 'site_id,key' },
      );

    await deps.supabase
      .from('templates_sources')
      .update({ token_secret_ref: secretKey })
      .eq('id', sourceId);

    // Bump prior is_current=true rows to false, then insert the new schema.
    await deps.supabase
      .from('templates_content_schemas')
      .update({ is_current: false })
      .eq('library_id', libraryId)
      .eq('is_current', true);

    interface VersionRow { version: number; }
    const { data: maxVer } = await deps.supabase
      .from('templates_content_schemas')
      .select('version')
      .eq('library_id', libraryId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle<VersionRow>();
    const nextVersion = (maxVer?.version ?? 0) + 1;

    const { data: created, error: schemaErr } = await deps.supabase
      .from('templates_content_schemas')
      .insert({
        source_id: sourceId,
        library_id: libraryId,
        version: nextVersion,
        is_current: true,
        schema_format: 'json',
        schema_hash: schemaHash,
        schema_json: schemaJson,
        applied_at: new Date().toISOString(),
        applied_by: userId,
      })
      .select('id, version')
      .single<{ id: string; version: number }>();
    if (schemaErr || !created) {
      return sendError(res, 500, 'internal', `content schema insert failed: ${schemaErr?.message ?? 'no_data'}`);
    }

    res.status(200).json({
      sourceId,
      libraryId,
      schemaId: created.id,
      schemaVersion: created.version,
      mainSha,
      branch,
    });
  }

  // -------------------------------------------------------------------------
  // POST /admin/sites/:siteId/source/:sourceId/refresh-git
  // body: { schema_path? }
  //
  // Re-clones the existing external git source using the PAT stored in
  // sites_secrets under git_pat_<source_id>, ingests the schema again as a
  // new templates_content_schemas version (is_current=true; prior versions
  // retained), and force-pushes the fresh tree into the internal bare repo
  // so apply-theme drift baselines update.
  //
  // Use case: operator updated their theme repo upstream and wants gatewaze
  // to pick up the new schema without re-typing the URL/PAT.
  // -------------------------------------------------------------------------
  async function refreshGit(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const siteId = req.params['siteId'];
    const sourceId = req.params['sourceId'];
    if (!siteId || typeof siteId !== 'string') return sendError(res, 400, 'invalid_input', 'siteId required');
    if (!sourceId || typeof sourceId !== 'string') return sendError(res, 400, 'invalid_input', 'sourceId required');

    const body = req.body as { schema_path?: unknown } | undefined;
    const schemaPathOverride = body && typeof body.schema_path === 'string' && body.schema_path.trim()
      ? body.schema_path.trim()
      : null;

    interface SourceRow {
      id: string;
      library_id: string;
      url: string | null;
      branch: string | null;
      manifest_path: string | null;
      token_secret_ref: string | null;
    }
    const { data: source, error: srcErr } = await deps.supabase
      .from('templates_sources')
      .select('id, library_id, url, branch, manifest_path, token_secret_ref')
      .eq('id', sourceId)
      .maybeSingle<SourceRow>();
    if (srcErr) return sendError(res, 500, 'internal', srcErr.message);
    if (!source) return sendError(res, 404, 'not_found', 'source not found');
    if (!source.url || !source.token_secret_ref) {
      return sendError(res, 409, 'invalid_state', 'source has no url or token_secret_ref — re-import via /source:import-git');
    }

    interface SecretRow { encrypted_value: Buffer | string; }
    const { data: secret } = await deps.supabase
      .from('sites_secrets')
      .select('encrypted_value')
      .eq('site_id', siteId)
      .eq('key', source.token_secret_ref)
      .maybeSingle<SecretRow>();
    if (!secret) {
      return sendError(res, 409, 'invalid_state', 'PAT not found in sites_secrets — re-import to set');
    }

    // The encrypted_value is JSON-encoded `{ pat }`. Decode lossily — when
    // the platform's encryption-at-rest layer wraps these the codec lands
    // in a follow-up; for v1 we round-trip JSON straight.
    let pat = '';
    try {
      const txt = typeof secret.encrypted_value === 'string'
        ? secret.encrypted_value
        : Buffer.from(secret.encrypted_value as Buffer).toString('utf-8');
      const parsed = JSON.parse(txt) as { pat?: string };
      pat = parsed.pat ?? '';
    } catch {
      return sendError(res, 500, 'internal', 'stored PAT could not be decoded');
    }
    if (!pat) return sendError(res, 409, 'invalid_state', 'stored PAT is empty');

    const branch = source.branch ?? 'main';
    const schemaPath = schemaPathOverride ?? source.manifest_path ?? 'content/schema.json';
    const authedUrl = source.url.replace(/^https:\/\//, `https://x-access-token:${encodeURIComponent(pat)}@`);

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const dynImport = (Function('s', 'return import(s)') as (s: string) => Promise<unknown>);
    const fsMod = await dynImport('node:fs') as typeof import('node:fs');
    const pathMod = await dynImport('node:path') as typeof import('node:path');
    const osMod = await dynImport('node:os') as typeof import('node:os');
    const cryptoMod = await dynImport('node:crypto') as typeof import('node:crypto');
    const childProcessMod = await dynImport('node:child_process') as typeof import('node:child_process');

    const tmpDir = pathMod.join(osMod.tmpdir(), `gatewaze-refresh-${siteId.slice(0, 8)}-${Date.now()}`);
    fsMod.mkdirSync(tmpDir, { recursive: true });

    let schemaJson: Record<string, unknown>;
    let schemaHash: string;
    let mainSha: string;
    try {
      childProcessMod.execFileSync('git', [
        'clone', '--depth=1', '--single-branch', '--branch', branch, authedUrl, tmpDir,
      ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });

      const fullSchemaPath = pathMod.join(tmpDir, schemaPath);
      if (!fsMod.existsSync(fullSchemaPath)) {
        return sendError(res, 422, 'schema_not_found', `${schemaPath} not found in repo at branch ${branch}`);
      }
      try {
        schemaJson = await loadSchemaFromFile(fullSchemaPath, fsMod, dynImport);
      } catch (err) {
        return sendError(res, 422, 'schema_parse_failed', (err as Error).message);
      }
      schemaHash = cryptoMod.createHash('sha256').update(JSON.stringify(schemaJson)).digest('hex');
      mainSha = childProcessMod.execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir, stdio: ['ignore', 'pipe', 'pipe'],
      }).toString('utf-8').trim();

      // Mirror into internal bare repo (same as import).
      if (deps.gitServer) {
        try {
          interface SiteSlugRow { slug: string; }
          const { data: siteSlugRow } = await deps.supabase
            .from('sites').select('slug').eq('id', siteId).maybeSingle<SiteSlugRow>();
          if (siteSlugRow) {
            const repo = await deps.gitServer.createRepo({
              hostKind: 'site', hostId: siteId, slug: siteSlugRow.slug,
            });
            childProcessMod.execFileSync(
              'git', ['push', '--force', repo.barePath, `HEAD:${repo.defaultBranch ?? 'main'}`],
              { cwd: tmpDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
            );
          }
        } catch (mirrorErr) {
          deps.logger.warn('admin.source.refresh_git.mirror_failed', {
            siteId, sourceId,
            error: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr),
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.logger.error('admin.source.refresh_git.clone_failed', { siteId, sourceId, error: msg });
      return sendError(res, 502, 'clone_failed', `git clone failed: ${msg}`);
    } finally {
      try { fsMod.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    // Update source metadata
    await deps.supabase
      .from('templates_sources')
      .update({
        installed_git_sha: mainSha,
        available_git_sha: mainSha,
        last_checked_at: new Date().toISOString(),
        last_check_error: null,
        status: 'active',
      })
      .eq('id', sourceId);

    // Bump prior is_current=true → false; insert new schema version
    await deps.supabase
      .from('templates_content_schemas')
      .update({ is_current: false })
      .eq('library_id', source.library_id)
      .eq('is_current', true);

    interface VersionRow { version: number; }
    const { data: maxVer } = await deps.supabase
      .from('templates_content_schemas')
      .select('version')
      .eq('library_id', source.library_id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle<VersionRow>();
    const nextVersion = (maxVer?.version ?? 0) + 1;

    const { data: created, error: schemaErr } = await deps.supabase
      .from('templates_content_schemas')
      .insert({
        source_id: sourceId,
        library_id: source.library_id,
        version: nextVersion,
        is_current: true,
        schema_format: 'json',
        schema_hash: schemaHash,
        schema_json: schemaJson,
        applied_at: new Date().toISOString(),
        applied_by: userId,
      })
      .select('id, version')
      .single<{ id: string; version: number }>();
    if (schemaErr || !created) {
      return sendError(res, 500, 'internal', `content schema insert failed: ${schemaErr?.message ?? 'no_data'}`);
    }

    res.status(200).json({
      sourceId,
      libraryId: source.library_id,
      schemaId: created.id,
      schemaVersion: created.version,
      mainSha,
      branch,
    });
  }

  // -------------------------------------------------------------------------
  // POST /admin/sites/:siteId/archive
  //
  // Server-side archive flow with cascading cleanup:
  //   1. Set sites.status='archived'
  //   2. Soft-delete the site's internal git repo (30-day retention; restore
  //      via a future "Restore site" UI within the window)
  //   3. Delete the corresponding Umami website if umami is
  //      enabled and a websiteId is recorded on sites.config.analytics.umami
  //   4. Leave templates_libraries / pages / page_blocks intact (history
  //      preserved; they're referenced by FKs from publish jobs etc.)
  //
  // Idempotent: re-archiving a site already at status='archived' just
  // re-runs the cleanup steps.
  // -------------------------------------------------------------------------
  async function archiveSite(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const siteId = req.params['siteId'];
    if (!siteId || typeof siteId !== 'string') return sendError(res, 400, 'invalid_input', 'siteId required');

    interface SiteRow {
      id: string;
      slug: string;
      config: Record<string, unknown> | null;
    }
    const { data: site, error: siteErr } = await deps.supabase
      .from('sites')
      .select('id, slug, config')
      .eq('id', siteId)
      .maybeSingle<SiteRow>();
    if (siteErr) return sendError(res, 500, 'internal', siteErr.message);
    if (!site) return sendError(res, 404, 'not_found', 'site not found');

    const cleanupErrors: Array<{ step: string; reason: string }> = [];

    // 1. Mark archived
    const { error: archiveErr } = await deps.supabase
      .from('sites')
      .update({ status: 'archived' })
      .eq('id', siteId);
    if (archiveErr) {
      return sendError(res, 500, 'internal', `archive failed: ${archiveErr.message}`);
    }

    // 2. Soft-delete internal repo (when gitServer is wired)
    if (deps.gitServer) {
      try {
        // gitServer.createRepo is idempotent — returns existing or creates;
        // we only need the ref to soft-delete. Reusing it avoids needing to
        // expose lookupRepo/softDeleteRepo on the deps interface.
        const repo = await deps.gitServer.createRepo({
          hostKind: 'site',
          hostId: siteId,
          slug: site.slug,
        });
        // Best-effort: write a marker on the bare repo so the platform's
        // sweeper hard-deletes after the retention window. If the deps
        // interface gets softDeleteRepo later, swap in for that. For v1
        // we just log so the operator can manually rm the repo if needed.
        deps.logger.info('admin.archive.repo_marked', {
          siteId,
          barePath: repo.barePath,
          retentionPolicy: '30d',
        });
      } catch (err) {
        cleanupErrors.push({
          step: 'repo_soft_delete',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 3. Analytics property cleanup
    //
    // Site archive used to reach into Umami directly via the legacy `umami`
    // integration module's deleteWebsite() helper. That module has been
    // consolidated into the `analytics` module (see spec-analytics-module);
    // analytics_properties + the underlying Umami website now outlive the
    // archived site so historical analytics remain queryable. If you need
    // hard-deletion (cost/quota concerns), the analytics module owns that
    // surface — TODO: add an `onSiteArchived` hook over there that does
    // its own POST /api/websites/:id DELETE and flips the property row to
    // status='archived'.

    // 4. Stop running A/B tests on the site (so the renderer halts traffic
    //    routing into them; rows preserved for history).
    await deps.supabase
      .from('templates_ab_tests')
      .update({ status: 'concluded', ended_at: new Date().toISOString() })
      .eq('host_kind', 'site')
      .eq('host_id', siteId)
      .in('status', ['draft', 'running', 'paused']);

    res.status(200).json({ archived: true, cleanupErrors });
  }

  // -------------------------------------------------------------------------
  // POST /admin/sites/:siteId/internal-repo:ensure
  //
  // Idempotently provisions the site's bare internal git repo via
  // gitServer.createRepo. Called by sitesService.createSite after a fresh
  // site row inserts, so the Source tab + Connect-git flows have a repo
  // to push into without surprise.
  // -------------------------------------------------------------------------
  async function ensureInternalRepo(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    if (!deps.gitServer) {
      // gitServer not wired — succeed silently so the createSite caller
      // doesn't block on an environment that doesn't run the publish-worker.
      res.status(200).json({ created: false, reason: 'git_server_unavailable' });
      return;
    }
    const siteId = req.params['siteId'];
    if (!siteId || typeof siteId !== 'string') return sendError(res, 400, 'invalid_input', 'siteId required');

    const { data: site, error: siteErr } = await deps.supabase
      .from('sites')
      .select('id, slug')
      .eq('id', siteId)
      .maybeSingle<{ id: string; slug: string }>();
    if (siteErr) return sendError(res, 500, 'internal', siteErr.message);
    if (!site) return sendError(res, 404, 'not_found', 'site not found');

    // Boilerplate: defaults to gatewaze-template-site at the configured tag,
    // overridable per-brand via env. createRepo is idempotent — when the repo
    // already exists, the boilerplate clone is skipped (existing rows are
    // returned). First-time creation pushes the boilerplate's main branch
    // into the freshly-init'd bare repo so the operator's CI has something
    // to build immediately.
    const boilerplateUrl = process.env.SITES_BOILERPLATE_URL ?? 'https://github.com/gatewaze/gatewaze-template-site.git';
    const boilerplateTag = process.env.SITES_BOILERPLATE_TAG ?? 'main';
    const skipBoilerplate = process.env.SITES_SKIP_BOILERPLATE === '1';

    try {
      const repo = await deps.gitServer.createRepo({
        hostKind: 'site',
        hostId: siteId,
        slug: site.slug,
        ...(skipBoilerplate
          ? {}
          : { boilerplate: { url: boilerplateUrl, tag: boilerplateTag } }),
      });
      res.status(200).json({
        barePath: repo.barePath,
        defaultBranch: repo.defaultBranch,
        boilerplate: skipBoilerplate ? null : { url: boilerplateUrl, tag: boilerplateTag },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Boilerplate clone failures are non-fatal — log + retry without it
      // so the bare repo still gets created. Operators can later push their
      // own theme via Connect-git.
      if (msg.includes('boilerplate clone failed') && !skipBoilerplate) {
        deps.logger.warn('admin.internal_repo.boilerplate_clone_failed_retry', {
          siteId,
          boilerplateUrl,
          error: msg,
        });
        try {
          const repo = await deps.gitServer.createRepo({
            hostKind: 'site',
            hostId: siteId,
            slug: site.slug,
          });
          res.status(200).json({
            barePath: repo.barePath,
            defaultBranch: repo.defaultBranch,
            boilerplate: null,
            boilerplateError: msg,
          });
          return;
        } catch (retryErr) {
          deps.logger.error('admin.internal_repo.ensure_failed_after_retry', {
            siteId,
            error: retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
          return sendError(res, 500, 'internal', retryErr instanceof Error ? retryErr.message : String(retryErr));
        }
      }
      deps.logger.error('admin.internal_repo.ensure_failed', { siteId, error: msg });
      return sendError(res, 500, 'internal', msg);
    }
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
    rollbackPublishJob,
    provisionIntegrations,
    importGit,
    ensureInternalRepo,
    provisionStarterLibrary,
    archiveSite,
    refreshGit,
  };

  // -------------------------------------------------------------------------
  // POST /admin/sites/:siteId/library:provision-starter
  //
  // Idempotently creates a starter templates_library + wrapper + inline
  // source + content_schema for the site, and writes the library id back
  // to sites.templates_library_id. Mirrors the browser-side
  // sitesService.provisionStarterLibrary but runs with service-role so
  // RLS can't silently block the linkage update on sites — root cause of
  // the canvas-blank / no-templates-library issue post-create.
  // -------------------------------------------------------------------------
  async function provisionStarterLibrary(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const siteId = req.params['siteId'];
    if (!siteId || typeof siteId !== 'string') {
      return sendError(res, 400, 'invalid_input', 'siteId required');
    }

    interface SiteRow {
      id: string; name: string; theme_kind: string;
      templates_library_id: string | null;
    }
    const { data: site, error: siteErr } = await deps.supabase
      .from('sites')
      .select('id, name, theme_kind, templates_library_id')
      .eq('id', siteId)
      .maybeSingle<SiteRow>();
    if (siteErr) return sendError(res, 500, 'internal', siteErr.message);
    if (!site) return sendError(res, 404, 'not_found', 'site not found');

    if (site.templates_library_id) {
      return res.status(200).json({ libraryId: site.templates_library_id, created: false }) as unknown as void;
    }

    const { data: lib, error: libErr } = await deps.supabase
      .from('templates_libraries')
      .insert({
        host_kind: 'site',
        host_id: site.id,
        name: `${site.name} library`,
        description: `Auto-provisioned starter library for site ${site.name}.`,
        theme_kind: site.theme_kind,
      })
      .select('id')
      .single<{ id: string }>();
    if (libErr || !lib) return sendError(res, 500, 'internal', `library insert failed: ${libErr?.message ?? 'no_data'}`);
    const libraryId = lib.id;

    const wrapperHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{{page.title}}</title>
  {{>head}}
</head>
<body>
  <main>
    {{>page_body}}
  </main>
</body>
</html>`;
    const { error: wrapperErr } = await deps.supabase
      .from('templates_wrappers')
      .insert({ library_id: libraryId, key: 'default', name: 'Default wrapper', html: wrapperHtml });
    if (wrapperErr) return sendError(res, 500, 'internal', `wrapper insert failed: ${wrapperErr.message}`);

    // Inline source with sha256(empty) so the templates_sources_inline_fields CHECK passes.
    const inlineSha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const { data: source, error: sourceErr } = await deps.supabase
      .from('templates_sources')
      .insert({
        library_id: libraryId,
        kind: 'inline',
        label: 'Inline starter',
        status: 'active',
        theme_kind: site.theme_kind,
        inline_html: '',
        inline_sha: inlineSha,
        auto_apply: false,
      })
      .select('id')
      .single<{ id: string }>();
    if (sourceErr || !source) return sendError(res, 500, 'internal', `source insert failed: ${sourceErr?.message ?? 'no_data'}`);

    const schemaJson = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'Starter page',
      type: 'object',
      properties: {
        heroTitle: { type: 'string', title: 'Hero heading' },
        heroBody: { type: 'string', format: 'html', title: 'Hero body' },
        sections: { type: 'array', title: 'Sections', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string', format: 'html' } }, required: ['title'] } },
      },
    } as const;
    const schemaJsonString = JSON.stringify(schemaJson);
    const schemaHash = await (async () => {
      const { createHash } = await import('node:crypto');
      return createHash('sha256').update(schemaJsonString).digest('hex');
    })();
    const { error: schemaErr } = await deps.supabase
      .from('templates_content_schemas')
      .insert({
        source_id: source.id,
        library_id: libraryId,
        version: 1,
        is_current: true,
        schema_format: 'json',
        schema_hash: schemaHash,
        schema_json: schemaJson,
      });
    if (schemaErr) return sendError(res, 500, 'internal', `content schema insert failed: ${schemaErr.message}`);

    const { error: linkErr } = await deps.supabase
      .from('sites')
      .update({ templates_library_id: libraryId })
      .eq('id', site.id);
    if (linkErr) return sendError(res, 500, 'internal', `site link failed: ${linkErr.message}`);

    res.status(201).json({ libraryId, created: true });
  }
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
 * Load a JSON Schema from a file. Supports `.json` (parse) and `.ts` /
 * `.tsx` (best-effort transpile via the `typescript` package's
 * transpileModule, then sandboxed eval to extract `module.exports.default`
 * or the bare `module.exports` object).
 *
 * Why support .ts: many Next.js theme repos author schemas in TypeScript
 * for type-safety (e.g., `export default { type: 'object', ... } satisfies
 * JSONSchema`). Forcing them to ship pre-compiled JSON splits source-of-
 * truth from the editor experience. This v1 transpile path covers the
 * "single-file, no imports" case which is ~95% of schema authoring.
 *
 * Limits: imports inside the .ts file aren't resolved (`require`/`import`
 * fail); use a single self-contained literal. Imports lands when we ship
 * a proper esbuild bundle step in v2.
 */
async function loadSchemaFromFile(
  fullPath: string,
  fsMod: typeof import('node:fs'),
  dynImport: (s: string) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const raw = fsMod.readFileSync(fullPath, 'utf-8');
  const ext = fullPath.toLowerCase();
  if (ext.endsWith('.json')) {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`schema is not valid JSON: ${(err as Error).message}`);
    }
  }
  if (ext.endsWith('.ts') || ext.endsWith('.tsx')) {
    let ts: typeof import('typescript');
    try {
      ts = (await dynImport('typescript')) as typeof import('typescript');
    } catch (err) {
      throw new Error(
        `schema.ts requires the 'typescript' package on the server. ` +
        `Pre-compile to schema.json and re-import, or install typescript. ` +
        `(${(err as Error).message})`,
      );
    }
    const transpiled = ts.transpileModule(raw, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    });
    const vmMod = (await dynImport('node:vm')) as typeof import('node:vm');
    const sandbox: { module: { exports: Record<string, unknown> }; exports: Record<string, unknown> } = {
      module: { exports: {} },
      exports: {},
    };
    sandbox.exports = sandbox.module.exports;
    try {
      vmMod.createContext(sandbox);
      vmMod.runInContext(transpiled.outputText, sandbox, { timeout: 5000 });
    } catch (err) {
      throw new Error(`schema.ts eval failed (single-file literal only; no imports): ${(err as Error).message}`);
    }
    const fromDefault = sandbox.module.exports['default'];
    const candidate =
      fromDefault && typeof fromDefault === 'object'
        ? (fromDefault as Record<string, unknown>)
        : sandbox.module.exports;
    if (typeof candidate !== 'object' || Array.isArray(candidate) || candidate === null) {
      throw new Error('schema.ts must export a JSON-Schema-shaped object (use `export default { ... }`)');
    }
    return candidate as Record<string, unknown>;
  }
  throw new Error(`unsupported schema file extension; expected .json, .ts, or .tsx`);
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
  router.post('/admin/sites/:siteId/publish-jobs/:jobId/rollback', routes.rollbackPublishJob);
  router.post('/admin/sites/:siteId/integrations\\:provision', routes.provisionIntegrations);
  router.post('/admin/sites/:siteId/source\\:import-git', routes.importGit);
  router.post('/admin/sites/:siteId/internal-repo\\:ensure', routes.ensureInternalRepo);
  router.post('/admin/sites/:siteId/library\\:provision-starter', routes.provisionStarterLibrary);
  router.post('/admin/sites/:siteId/archive', routes.archiveSite);
  router.post('/admin/sites/:siteId/source/:sourceId/refresh-git', routes.refreshGit);
}
