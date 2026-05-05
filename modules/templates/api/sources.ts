/**
 * HTTP routes for templates_sources management — per spec-templates-module §6.9.
 *
 * Endpoints (mounted at `/api/modules/templates/...`):
 *
 *   POST   /sources                          — create source (upload, inline, git)
 *   GET    /sources/:id                      — read source state + recent audit
 *   POST   /sources/:id/check                — manual drift check
 *   POST   /sources/:id/apply?confirm=true   — apply pending update
 *   POST   /sources/:id/pause                — pause source (kill switch)
 *   POST   /sources/:id/unpause              — resume
 *   GET    /libraries/:id/block-defs         — list block definitions
 *
 * Per the gatewaze-production-readiness skill:
 *   - Mass-assignment guarded by TEMPLATES_SOURCES_WRITE_FIELDS allowlist
 *   - PostgREST `.or()` filters never interpolate user input
 *   - All inputs validated at the boundary; errors return structured 4xx
 *   - DB triggers + RLS are the authoritative invariants
 */

import type { Request, Response, Router } from 'express';
import { createHash } from 'node:crypto';
import { parse } from '../lib/parser/parse.js';
import { applySource } from '../lib/sources/apply.js';
import { ingestUpload, ingestInline } from '../lib/sources/ingest.js';
import { ingestGit, checkGitSourceForUpdates, assertHostInEgressAllowlist } from '../lib/sources/git.js';
import { getBoilerplateConfig, type HostKind } from '../lib/boilerplate/index.js';

// ---------------------------------------------------------------------------
// Narrow Supabase surface — extends the ingest/apply client interfaces
// ---------------------------------------------------------------------------

export interface SourcesSupabaseQuery {
  select(cols: string): SourcesSupabaseQuery;
  insert(values: Record<string, unknown> | Record<string, unknown>[]): SourcesSupabaseQuery;
  update(values: Record<string, unknown>): SourcesSupabaseQuery;
  eq(col: string, val: unknown): SourcesSupabaseQuery;
  order(col: string, opts: { ascending: boolean }): SourcesSupabaseQuery;
  limit(n: number): SourcesSupabaseQuery;
  single<T = Record<string, unknown>>(): Promise<{ data: T | null; error: { message: string } | null }>;
  maybeSingle<T = Record<string, unknown>>(): Promise<{ data: T | null; error: { message: string } | null }>;
  then<TResult>(
    onfulfilled: (value: { data: Array<Record<string, unknown>> | null; error: { message: string } | null }) => TResult,
  ): Promise<TResult>;
}

export interface SourcesSupabaseClient {
  from(table: string): SourcesSupabaseQuery;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface SourcesRoutesDeps {
  supabase: SourcesSupabaseClient;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  getUserId: (req: Request) => string | null;
}

// ---------------------------------------------------------------------------
// Mass-assignment allow-list per §10.5
// ---------------------------------------------------------------------------

/** Fields a caller is permitted to set on a templates_sources INSERT. */
const TEMPLATES_SOURCES_WRITE_FIELDS = [
  'library_id',
  'kind',
  'label',
  // git-specific
  'url',
  'branch',
  'token_secret_ref',
  'manifest_path',
  'auto_apply',
  // upload/inline
  'upload_blob_ref',
  'upload_sha',
  'inline_html',
  // shared
  'allow_overwrite',
] as const;

function pickFields<K extends string>(body: unknown, fields: ReadonlyArray<K>): Partial<Record<K, unknown>> {
  if (!body || typeof body !== 'object') return {};
  const src = body as Record<string, unknown>;
  const out: Partial<Record<K, unknown>> = {};
  for (const f of fields) {
    if (f in src) out[f] = src[f];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

interface SourceRow {
  id: string;
  library_id: string;
  kind: 'git' | 'upload' | 'inline';
  label: string;
  status: 'active' | 'paused' | 'error';
  url: string | null;
  branch: string | null;
  manifest_path: string | null;
  auto_apply: boolean | null;
  last_check_error: string | null;
  installed_git_sha: string | null;
}

interface ValidationResult<T> {
  ok: boolean;
  reason?: string;
  field?: string;
  value?: T;
}

const KIND_VALUES = new Set(['git', 'upload', 'inline']);
const LABEL_MAX = 200;
const URL_MAX = 1000;
const BRANCH_MAX = 200;
const MANIFEST_PATH_MAX = 200;

/** Per spec §10.5 + §6.9: validates the discriminated-union body for POST /sources. */
export function validateCreateSourceInput(body: unknown): ValidationResult<Record<string, unknown>> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'body must be an object' };
  }
  const picked = pickFields(body, TEMPLATES_SOURCES_WRITE_FIELDS);

  // Common fields
  const libraryId = picked['library_id'];
  if (typeof libraryId !== 'string' || !/^[0-9a-f-]{36}$/i.test(libraryId)) {
    return { ok: false, reason: 'library_id must be a uuid', field: 'library_id' };
  }
  const kind = picked['kind'];
  if (typeof kind !== 'string' || !KIND_VALUES.has(kind)) {
    return { ok: false, reason: `kind must be one of ${[...KIND_VALUES].join(', ')}`, field: 'kind' };
  }
  const label = picked['label'];
  if (typeof label !== 'string' || label.length === 0 || label.length > LABEL_MAX) {
    return { ok: false, reason: `label required, max ${LABEL_MAX} chars`, field: 'label' };
  }

  // Discriminated by kind
  if (kind === 'git') {
    const url = picked['url'];
    if (typeof url !== 'string' || url.length === 0 || url.length > URL_MAX) {
      return { ok: false, reason: `url required for git source, max ${URL_MAX} chars`, field: 'url' };
    }
    // Defense-in-depth: reject non-http(s) schemes — prevents file://, ssh://
    // injection attempts that aren't covered by the egress allowlist yet.
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, reason: 'url must use http:// or https://', field: 'url' };
    }
    const branch = picked['branch'];
    if (branch !== undefined && (typeof branch !== 'string' || branch.length > BRANCH_MAX || !/^[A-Za-z0-9_./-]+$/.test(branch))) {
      return { ok: false, reason: `branch must be a safe ref name, max ${BRANCH_MAX} chars`, field: 'branch' };
    }
    const manifestPath = picked['manifest_path'];
    if (manifestPath !== undefined && (typeof manifestPath !== 'string' || manifestPath.length > MANIFEST_PATH_MAX || manifestPath.includes('..'))) {
      return { ok: false, reason: `manifest_path must be relative + path-traversal-free, max ${MANIFEST_PATH_MAX} chars`, field: 'manifest_path' };
    }
    // Egress allowlist gate (per spec §15.6 acceptance criterion). Empty
    // EGRESS_ALLOWLIST = unrestricted; non-empty restricts which hosts the
    // platform may clone from. Reject at validateConfig time so the admin
    // sees the failure before the worker tries to clone and fails async.
    try {
      assertHostInEgressAllowlist(url);
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : 'egress_blocked', field: 'url' };
    }
    return { ok: true, value: picked as Record<string, unknown> };
  }

  if (kind === 'upload') {
    const blobRef = picked['upload_blob_ref'];
    if (typeof blobRef !== 'string' || blobRef.length === 0) {
      return { ok: false, reason: 'upload_blob_ref required for upload source', field: 'upload_blob_ref' };
    }
    return { ok: true, value: picked as Record<string, unknown> };
  }

  // inline
  const html = picked['inline_html'];
  if (typeof html !== 'string' || html.length === 0) {
    return { ok: false, reason: 'inline_html required for inline source', field: 'inline_html' };
  }
  return { ok: true, value: picked as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function sendError(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

export function createSourcesRoutes(deps: SourcesRoutesDeps) {
  // -------------------------------------------------------------------------
  // POST /sources
  // -------------------------------------------------------------------------
  async function createSource(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const v = validateCreateSourceInput(req.body);
    if (!v.ok) return sendError(res, 400, 'validation_failed', v.reason ?? 'invalid input', v.field ? { field: v.field } : undefined);
    const fields = v.value!;

    const kind = fields['kind'] as 'git' | 'upload' | 'inline';

    try {
      if (kind === 'git') {
        // The token, when supplied, is a pointer into the platform secrets
        // store (token_secret_ref). The route doesn't dereference it here —
        // that's the responsibility of the caller's deployment glue. For
        // now we accept an inline `token` body field as the v1 path; a
        // future iteration can wire through the secrets resolver.
        const inlineToken = (req.body as Record<string, unknown>)['token'];
        const result = await ingestGit(deps.supabase, {
          library_id: fields['library_id'] as string,
          label: fields['label'] as string,
          url: fields['url'] as string,
          branch: fields['branch'] as string | undefined,
          manifest_path: fields['manifest_path'] as string | undefined,
          auto_apply: fields['auto_apply'] as boolean | undefined,
          token: typeof inlineToken === 'string' ? inlineToken : undefined,
          created_by: userId,
        });
        if (result.apply.errors.length > 0 && result.apply.artifacts.length === 0) {
          return sendError(res, 422, 'parse_failed', 'git source contained parse errors', { errors: result.apply.errors, source_id: result.source_id });
        }
        res.status(201).json({ source_id: result.source_id, installed_git_sha: result.installed_git_sha, apply: result.apply });
        return;
      }

    // Upload + inline both go through the existing ingest helpers, which
    // create the source row AND parse + apply in one call.
      if (kind === 'upload') {
        // For upload we need the actual HTML — the spec talks about
        // upload_blob_ref + upload_sha pointing to object storage. Reading
        // the blob is platform-specific (Supabase Storage). For now we
        // accept an inline_html shortcut on the upload create body so the
        // route is testable; the real blob-fetch lands when the storage
        // adapter is wired through.
        const inlineHtml = (req.body as Record<string, unknown>)['inline_html'];
        if (typeof inlineHtml !== 'string' || inlineHtml.length === 0) {
          return sendError(res, 400, 'validation_failed', 'upload source currently requires the inline_html shortcut while blob-fetch is being wired up', { field: 'inline_html' });
        }
        const result = await ingestUpload(deps.supabase, {
          library_id: fields['library_id'] as string,
          label: fields['label'] as string,
          html: inlineHtml,
          upload_blob_ref: fields['upload_blob_ref'] as string,
          created_by: userId,
        });
        if (result.apply.errors.length > 0 && !result.source_id) {
          return sendError(res, 422, 'parse_failed', 'upload contained parse errors', { errors: result.apply.errors });
        }
        res.status(201).json({ source_id: result.source_id, apply: result.apply });
        return;
      }

      // inline
      const result = await ingestInline(deps.supabase, {
        library_id: fields['library_id'] as string,
        label: fields['label'] as string,
        inline_html: fields['inline_html'] as string,
        created_by: userId,
      });
      if (result.apply.errors.length > 0 && !result.source_id) {
        return sendError(res, 422, 'parse_failed', 'inline contained parse errors', { errors: result.apply.errors });
      }
      res.status(201).json({ source_id: result.source_id, apply: result.apply });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown error';
      deps.logger.error('templates.sources.create.failed', { error: message });
      sendError(res, 500, 'internal_error', 'source create failed');
    }
  }

  // -------------------------------------------------------------------------
  // GET /sources/:id
  // -------------------------------------------------------------------------
  async function getSource(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const sourceId = req.params['id'];
    if (!sourceId || !/^[0-9a-f-]{36}$/i.test(sourceId)) {
      return sendError(res, 400, 'validation_failed', 'id must be a uuid', { field: 'id' });
    }

    const sourceQ = await deps.supabase
      .from('templates_sources')
      .select('id, library_id, kind, label, status, url, branch, manifest_path, auto_apply, last_check_error, installed_git_sha')
      .eq('id', sourceId)
      .maybeSingle<SourceRow>();
    if (sourceQ.error) {
      deps.logger.error('templates.sources.get.failed', { sourceId, error: sourceQ.error.message });
      return sendError(res, 500, 'internal_error', sourceQ.error.message);
    }
    if (!sourceQ.data) return sendError(res, 404, 'not_found', `source ${sourceId} not found`);

    res.status(200).json({ source: sourceQ.data, preview: null, recent_audit: [] });
  }

  // -------------------------------------------------------------------------
  // POST /sources/:id/check
  // -------------------------------------------------------------------------
  async function checkSource(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const sourceId = req.params['id'];
    if (!sourceId || !/^[0-9a-f-]{36}$/i.test(sourceId)) {
      return sendError(res, 400, 'validation_failed', 'id must be a uuid', { field: 'id' });
    }

    const sourceQ = await deps.supabase
      .from('templates_sources')
      .select('id, kind, status, url, branch, manifest_path, installed_git_sha')
      .eq('id', sourceId)
      .maybeSingle<{ id: string; kind: string; status: string; url: string | null; branch: string | null; manifest_path: string | null; installed_git_sha: string | null }>();
    if (!sourceQ.data) return sendError(res, 404, 'not_found', `source ${sourceId} not found`);

    if (sourceQ.data.kind === 'git') {
      // Manual drift check — clones/updates the cached repo and reports
      // whether HEAD has moved past the installed_git_sha. Apply is a
      // separate explicit click (POST /sources/:id/apply).
      if (!sourceQ.data.url) {
        return sendError(res, 500, 'internal_error', 'git source has no url stored');
      }
      try {
        const probe = await checkGitSourceForUpdates({
          url: sourceQ.data.url,
          branch: sourceQ.data.branch,
          installed_git_sha: sourceQ.data.installed_git_sha,
          manifest_path: sourceQ.data.manifest_path,
        });
        res.status(200).json({
          source: sourceQ.data,
          preview: probe.hasChanges ? { headSha: probe.headSha, previousSha: probe.previousSha } : null,
        });
        return;
      } catch (e) {
        const message = e instanceof Error ? e.message : 'unknown error';
        return sendError(res, 502, 'upstream_error', `git check failed: ${message}`, { last_check_error: message });
      }
    }

    // For upload + inline sources, the source content is captured at create
    // time and never drifts — the check is a no-op success.
    res.status(200).json({ source: sourceQ.data, preview: null });
  }

  // -------------------------------------------------------------------------
  // POST /sources/:id/apply?confirm=true
  // -------------------------------------------------------------------------
  async function applyEndpoint(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const sourceId = req.params['id'];
    if (!sourceId || !/^[0-9a-f-]{36}$/i.test(sourceId)) {
      return sendError(res, 400, 'validation_failed', 'id must be a uuid', { field: 'id' });
    }

    const sourceQ = await deps.supabase
      .from('templates_sources')
      .select('id, kind, status, inline_html, upload_blob_ref')
      .eq('id', sourceId)
      .maybeSingle<{ id: string; kind: string; status: string; inline_html: string | null; upload_blob_ref: string | null }>();
    if (sourceQ.error) return sendError(res, 500, 'internal_error', sourceQ.error.message);
    if (!sourceQ.data) return sendError(res, 404, 'not_found', `source ${sourceId} not found`);
    if (sourceQ.data.status === 'paused') return sendError(res, 409, 'source_paused', 'source is paused; unpause first');

    const html = sourceQ.data.inline_html;
    if (!html) {
      // For git, the cloned working tree's HTML lives elsewhere; not wired up yet.
      return sendError(res, 501, 'not_implemented', `apply for kind=${sourceQ.data.kind} is not implemented in v0.1`);
    }

    const parsed = parse(html, { sourcePath: `source-${sourceId}` });
    if (parsed.errors.length > 0) {
      return sendError(res, 422, 'parse_failed', 'source contains parse errors', { errors: parsed.errors });
    }

    const sha = createHash('sha256').update(html).digest('hex');
    const result = await applySource(deps.supabase, sourceId, parsed, { sourceSha: sha, dryRun: false });
    if (result.errors.length > 0) {
      return sendError(res, 500, 'internal_error', 'apply failed', { errors: result.errors });
    }

    res.status(200).json({ applied: result.artifacts, source: sourceQ.data });
  }

  // -------------------------------------------------------------------------
  // POST /sources/:id/pause and /unpause
  // -------------------------------------------------------------------------
  async function setStatus(req: Request, res: Response, status: 'active' | 'paused'): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const sourceId = req.params['id'];
    if (!sourceId || !/^[0-9a-f-]{36}$/i.test(sourceId)) {
      return sendError(res, 400, 'validation_failed', 'id must be a uuid', { field: 'id' });
    }

    const result = await deps.supabase
      .from('templates_sources')
      .update({ status })
      .eq('id', sourceId)
      .select('id, status')
      .single<{ id: string; status: string }>();
    if (result.error) return sendError(res, 500, 'internal_error', result.error.message);
    if (!result.data) return sendError(res, 404, 'not_found', `source ${sourceId} not found`);
    res.status(200).json({ source: result.data });
  }
  const pauseSource = (req: Request, res: Response) => setStatus(req, res, 'paused');
  const unpauseSource = (req: Request, res: Response) => setStatus(req, res, 'active');

  // -------------------------------------------------------------------------
  // GET /libraries/:id/block-defs
  // -------------------------------------------------------------------------
  async function listBlockDefs(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const libraryId = req.params['id'];
    if (!libraryId || !/^[0-9a-f-]{36}$/i.test(libraryId)) {
      return sendError(res, 400, 'validation_failed', 'id must be a uuid', { field: 'id' });
    }

    const includeInactive = req.query['include_inactive'] === 'true';

    // Per §10.5: sanitise the optional key filter — strip filter
    // metacharacters and cap length so it can never break out into a
    // PostgREST `.or()` injection.
    const keyRaw = req.query['key'];
    const key = typeof keyRaw === 'string' ? keyRaw.replace(/[,()*\\]/g, '').slice(0, 100) : null;

    let query = deps.supabase
      .from('templates_block_defs')
      .select('id, library_id, key, version, schema, role, is_current, source_id, created_at')
      .eq('library_id', libraryId);

    if (!includeInactive) query = query.eq('is_current', true);
    if (key) query = query.eq('key', key);

    const { data, error } = await query.order('key', { ascending: true });
    if (error) {
      deps.logger.error('templates.block_defs.list.failed', { libraryId, error: error.message });
      return sendError(res, 500, 'internal_error', error.message);
    }
    res.status(200).json({ items: data ?? [] });
  }

  // -------------------------------------------------------------------------
  // POST /libraries/:id/seed-from-boilerplate
  // body: { host_kind: 'newsletter' | 'site' }
  //
  // Per spec-content-modules-git-architecture §5: when a newsletter / site
  // is created with no external git configured, this endpoint kicks off a
  // one-shot clone of the canonical boilerplate (override via
  // GATEWAZE_*_BOILERPLATE_URL env). Returns 409 when the library already
  // has any source — the boilerplate clone is single-shot per library.
  // -------------------------------------------------------------------------
  async function seedFromBoilerplate(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const libraryId = req.params['id'];
    if (!libraryId || !/^[0-9a-f-]{36}$/i.test(libraryId)) {
      return sendError(res, 400, 'validation_failed', 'id must be a uuid', { field: 'id' });
    }

    const body = req.body as { host_kind?: unknown } | undefined;
    const hostKindRaw = typeof body?.host_kind === 'string' ? body.host_kind : '';
    if (hostKindRaw !== 'newsletter' && hostKindRaw !== 'site') {
      return sendError(res, 400, 'validation_failed', "host_kind must be 'newsletter' or 'site'", { field: 'host_kind' });
    }
    const hostKind: HostKind = hostKindRaw;

    // Refuse when the library already has a source — boilerplate seeding is
    // single-shot. If the admin wants to add another source they use POST
    // /sources directly.
    const existing = await deps.supabase
      .from('templates_sources')
      .select('id')
      .eq('library_id', libraryId)
      .maybeSingle<{ id: string }>();
    if (existing.data) {
      return sendError(res, 409, 'source_conflict', 'library already has at least one source; use POST /sources to add more');
    }

    const config = getBoilerplateConfig(hostKind);

    try {
      const result = await ingestGit(deps.supabase, {
        library_id: libraryId,
        label: config.label,
        url: config.url,
        branch: config.branch,
        manifest_path: config.manifestPath,
        auto_apply: false,
        created_by: userId,
      });
      res.status(201).json({
        source_id: result.source_id,
        installed_git_sha: result.installed_git_sha,
        apply: result.apply,
        boilerplate_url: config.url,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown error';
      // Network / 404 / parse failure all surface here. Pass the message
      // through so the admin sees "the canonical repo doesn't exist yet,
      // override GATEWAZE_NEWSLETTER_BOILERPLATE_URL" rather than a
      // generic 500.
      return sendError(res, 502, 'upstream_error', `boilerplate clone failed: ${message}`, {
        boilerplate_url: config.url,
      });
    }
  }

  return {
    createSource,
    getSource,
    checkSource,
    applyEndpoint,
    pauseSource,
    unpauseSource,
    listBlockDefs,
    seedFromBoilerplate,
  };
}

export function mountSourcesRoutes(router: Router, routes: ReturnType<typeof createSourcesRoutes>): void {
  router.post('/sources', routes.createSource);
  router.get('/sources/:id', routes.getSource);
  router.post('/sources/:id/check', routes.checkSource);
  router.post('/sources/:id/apply', routes.applyEndpoint);
  router.post('/sources/:id/pause', routes.pauseSource);
  router.post('/sources/:id/unpause', routes.unpauseSource);
  router.get('/libraries/:id/block-defs', routes.listBlockDefs);
  router.post('/libraries/:id/seed-from-boilerplate', routes.seedFromBoilerplate);
}
