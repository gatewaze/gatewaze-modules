/**
 * Canvas admin endpoints. Per spec-sites-wysiwyg-builder §6.
 *
 *   GET  /admin/pages/:id/canvas/render       — server-rendered iframe srcdoc
 *   POST /admin/pages/:id/canvas              — apply op-batch (Phase 1: stub returning 501)
 *   POST /admin/pages/:id/canvas/lock         — acquire / heartbeat advisory lock
 *   POST /admin/pages/:id/canvas/unlock       — release lock
 *   POST /admin/pages/:id/canvas/unlock-content — emergency disable JSON-lock (super-admin)
 *
 * Phase 1 scope:
 *   - render endpoint: fully wired (loads page tree, calls renderPage)
 *   - lock endpoints:  fully wired (lazy reap + upsert + heartbeat)
 *   - apply endpoint:  validates envelope, returns 501 — op handlers ship in Phase 1.B
 *   - presets/unlock-content: deferred to Phase 3 (presets) / Phase 1.B (unlock)
 *
 * Auth: relies on the platform's requireJwt middleware applied upstream.
 */

import type { Request, Response, Router } from 'express';
import { renderPage } from '../../lib/canvas-render/index.js';
import { sanitiseDocument } from '@gatewaze/shared/sanitisers';
import type {
  RenderInput,
  PageBlockNode,
  PageBrickNode,
  BlockDefView,
  BrickDefView,
  WrapperDefView,
} from '../../lib/canvas-render/index.js';
import { validateEnvelope } from './validators.js';
import { applyEnvelope } from './op-handlers.js';
import { canvasConfig } from './canvas-config.js';
import { assertCanvasEnabled, assertCanAdminSite } from './canvas-auth.js';
import { noopCanvasMetrics, type CanvasMetrics, elapsedSeconds } from './canvas-metrics.js';

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

// ----------------------------------------------------------------------------
// Dependency-injection shape (mirrors the pattern in source-routes.ts +
// menus-routes.ts so register-routes can wire deps in one place).
// ----------------------------------------------------------------------------

export interface CanvasRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any; rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> };
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Per-key sliding-window rate limiter (max requests in windowMs). Returns true when the request should pass. */
  rateLimit: (key: string, max: number, windowMs: number) => boolean;
  /** Brand identifier — flows into render context. */
  brand: string;
  /** Fetches the resolved sites_media url for a media id. NULL when not found. */
  resolveAssetUrl: (mediaId: string) => Promise<{ url: string; alt?: string } | null>;
  /** Optional metrics sink. Platform passes a prom-client-backed impl; tests pass nothing. */
  metrics?: CanvasMetrics;
}

// ----------------------------------------------------------------------------
// Page-tree fetcher: hydrates RenderInput from the DB.
// ----------------------------------------------------------------------------

interface PageRow {
  id: string;
  site_id: string;
  composition_mode: 'schema' | 'blocks';
  wrapper_id: string | null;
  content: Record<string, unknown> | null;
  title: string;
  full_path: string;
  version: number;
  wysiwyg_locked: boolean;
}

interface SiteRow {
  id: string;
  slug: string;
  templates_library_id: string | null;
}

interface PageBlockRow {
  id: string;
  page_id: string;
  block_def_id: string;
  parent_brick_id: string | null;
  sort_order: number;
  content: Record<string, unknown>;
  variant_key: string;
}

interface PageBrickRow {
  id: string;
  page_block_id: string;
  brick_def_id: string;
  sort_order: number;
  content: Record<string, unknown>;
  variant_key: string;
}

interface BlockDefRow {
  id: string;
  key: string;
  html: string;
  schema: Record<string, unknown>;
  has_bricks: boolean;
  thumbnail_url: string | null;
}

interface BrickDefRow {
  id: string;
  key: string;
  html: string;
  schema: Record<string, unknown>;
  block_def_id: string;
}

interface WrapperRow {
  id: string;
  key: string;
  html: string;
  library_id: string;
}

async function fetchPageTree(deps: CanvasRoutesDeps, pageId: string): Promise<{
  page: PageRow;
  site: SiteRow;
  blocks: PageBlockRow[];
  bricks: PageBrickRow[];
  blockDefs: Map<string, BlockDefRow>;
  brickDefs: Map<string, BrickDefRow>;
  wrappers: Map<string, WrapperRow>;
} | { notFound: true }> {
  const pageRes = await deps.supabase
    .from('pages')
    .select('id, site_id, composition_mode, wrapper_id, content, title, full_path, version, wysiwyg_locked')
    .eq('id', pageId)
    .maybeSingle();
  const page = (pageRes as { data: PageRow | null }).data;
  if (!page) return { notFound: true };

  const siteRes = await deps.supabase
    .from('sites')
    .select('id, slug, templates_library_id')
    .eq('id', page.site_id)
    .maybeSingle();
  const site = (siteRes as { data: SiteRow | null }).data;
  if (!site) return { notFound: true };

  const blocksRes = await deps.supabase
    .from('page_blocks')
    .select('id, page_id, block_def_id, parent_brick_id, sort_order, content, variant_key')
    .eq('page_id', pageId)
    .order('sort_order', { ascending: true });
  const blocks = ((blocksRes as { data: PageBlockRow[] | null }).data ?? []);

  const blockIds = blocks.map((b) => b.id);
  const bricksRes = blockIds.length === 0
    ? { data: [] as PageBrickRow[] }
    : await deps.supabase
        .from('page_block_bricks')
        .select('id, page_block_id, brick_def_id, sort_order, content, variant_key')
        .in('page_block_id', blockIds)
        .order('sort_order', { ascending: true });
  const bricks = ((bricksRes as { data: PageBrickRow[] | null }).data ?? []);

  const blockDefIds = Array.from(new Set(blocks.map((b) => b.block_def_id)));
  const blockDefs = new Map<string, BlockDefRow>();
  if (blockDefIds.length > 0) {
    const defsRes = await deps.supabase
      .from('templates_block_defs')
      .select('id, key, html, schema, has_bricks, thumbnail_url')
      .in('id', blockDefIds);
    const rows = ((defsRes as { data: BlockDefRow[] | null }).data ?? []);
    for (const r of rows) blockDefs.set(r.id, r);
  }

  const brickDefIds = Array.from(new Set(bricks.map((b) => b.brick_def_id)));
  const brickDefs = new Map<string, BrickDefRow>();
  if (brickDefIds.length > 0) {
    const defsRes = await deps.supabase
      .from('templates_brick_defs')
      .select('id, key, html, schema, block_def_id')
      .in('id', brickDefIds);
    const rows = ((defsRes as { data: BrickDefRow[] | null }).data ?? []);
    for (const r of rows) brickDefs.set(r.id, r);
  }

  const wrappers = new Map<string, WrapperRow>();
  if (page.wrapper_id) {
    const wrapRes = await deps.supabase
      .from('templates_wrappers')
      .select('id, key, html, library_id')
      .eq('id', page.wrapper_id)
      .maybeSingle();
    const w = (wrapRes as { data: WrapperRow | null }).data;
    if (w) wrappers.set(w.id, w);
  }

  return { page, site, blocks, bricks, blockDefs, brickDefs, wrappers };
}

async function buildRenderInput(
  deps: CanvasRoutesDeps,
  page: PageRow,
  site: SiteRow,
  blocks: PageBlockRow[],
  bricks: PageBrickRow[],
  blockDefs: Map<string, BlockDefRow>,
  brickDefs: Map<string, BrickDefRow>,
  wrappers: Map<string, WrapperRow>,
  preview: boolean,
  selectedBlockVariants?: ReadonlyMap<string, string>,
): Promise<RenderInput> {
  // Group bricks by parent block.
  const bricksByBlock = new Map<string, PageBrickRow[]>();
  for (const b of bricks) {
    const arr = bricksByBlock.get(b.page_block_id) ?? [];
    arr.push(b);
    bricksByBlock.set(b.page_block_id, arr);
  }

  // Group blocks by parent_brick_id.
  const blocksByBrick = new Map<string | null, PageBlockRow[]>();
  for (const b of blocks) {
    const key = b.parent_brick_id;
    const arr = blocksByBrick.get(key) ?? [];
    arr.push(b);
    blocksByBrick.set(key, arr);
  }

  // Recursively materialise the tree starting from top-level (parent_brick_id IS NULL).
  function buildBlock(row: PageBlockRow): PageBlockNode {
    const childBricks = (bricksByBlock.get(row.id) ?? []).map(buildBrick);
    return {
      id: row.id,
      block_def_id: row.block_def_id,
      content: row.content,
      variant_key: row.variant_key,
      sort_order: row.sort_order,
      parent_brick_id: row.parent_brick_id,
      bricks: childBricks,
    };
  }
  function buildBrick(row: PageBrickRow): PageBrickNode {
    const children = (blocksByBrick.get(row.id) ?? []).map(buildBlock);
    return {
      id: row.id,
      brick_def_id: row.brick_def_id,
      content: row.content,
      variant_key: row.variant_key,
      sort_order: row.sort_order,
      children,
    };
  }
  const topBlocks = (blocksByBrick.get(null) ?? []).map(buildBlock);

  // Resolve assets — walks the content tree once, gathers all asset ids, batches the lookup.
  const assetIds = new Set<string>();
  function gatherAssets(value: unknown): void {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const v of value) gatherAssets(v);
      return;
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (typeof obj.id === 'string' && (obj.url !== undefined || obj.alt !== undefined)) {
        assetIds.add(obj.id);
      }
      for (const v of Object.values(obj)) gatherAssets(v);
    }
  }
  for (const b of blocks) gatherAssets(b.content);
  for (const b of bricks) gatherAssets(b.content);

  const assets = new Map<string, { url: string; alt?: string }>();
  for (const id of assetIds) {
    const resolved = await deps.resolveAssetUrl(id);
    if (resolved) assets.set(id, resolved);
  }

  // Fetch variant overrides only when the editor has selected a non-default
  // variant for at least one block — saves a round-trip on the common case.
  const blockVariants = new Map<string, Map<string, Record<string, unknown>>>();
  const brickVariants = new Map<string, Map<string, Record<string, unknown>>>();
  const hasNonDefaultSelection = selectedBlockVariants && Array.from(selectedBlockVariants.values()).some((v) => v !== 'default');
  if (hasNonDefaultSelection && blocks.length > 0) {
    const blockIdSet = blocks.map((b) => b.id);
    const blockVariantsRes = await deps.supabase
      .from('page_block_variants')
      .select('page_block_id, variant_key, content')
      .in('page_block_id', blockIdSet);
    interface BlockVariantRow { page_block_id: string; variant_key: string; content: Record<string, unknown> }
    for (const r of (blockVariantsRes as { data: BlockVariantRow[] | null }).data ?? []) {
      const m = blockVariants.get(r.page_block_id) ?? new Map<string, Record<string, unknown>>();
      m.set(r.variant_key, r.content);
      blockVariants.set(r.page_block_id, m);
    }
    if (bricks.length > 0) {
      const brickIdSet = bricks.map((b) => b.id);
      const brickVariantsRes = await deps.supabase
        .from('page_block_brick_variants')
        .select('page_block_brick_id, variant_key, content')
        .in('page_block_brick_id', brickIdSet);
      interface BrickVariantRow { page_block_brick_id: string; variant_key: string; content: Record<string, unknown> }
      for (const r of (brickVariantsRes as { data: BrickVariantRow[] | null }).data ?? []) {
        const m = brickVariants.get(r.page_block_brick_id) ?? new Map<string, Record<string, unknown>>();
        m.set(r.variant_key, r.content);
        brickVariants.set(r.page_block_brick_id, m);
      }
    }
  }

  const blockDefViews = new Map<string, BlockDefView>();
  for (const [id, row] of blockDefs) {
    blockDefViews.set(id, {
      id: row.id,
      key: row.key,
      html: row.html,
      schema: row.schema,
      has_bricks: row.has_bricks,
      thumbnail_url: row.thumbnail_url,
    });
  }

  const brickDefViews = new Map<string, BrickDefView>();
  for (const [id, row] of brickDefs) {
    brickDefViews.set(id, {
      id: row.id,
      key: row.key,
      html: row.html,
      schema: row.schema,
    });
  }

  const wrapperViews = new Map<string, WrapperDefView>();
  for (const [id, row] of wrappers) {
    wrapperViews.set(id, { id: row.id, key: row.key, html: row.html });
  }

  return {
    page: {
      id: page.id,
      site_id: page.site_id,
      composition_mode: page.composition_mode,
      wrapper_id: page.wrapper_id,
      content: page.content,
      title: page.title,
      full_path: page.full_path,
    },
    blocks: topBlocks,
    blockDefs: blockDefViews,
    brickDefs: brickDefViews,
    wrappers: wrapperViews,
    assets,
    ...(selectedBlockVariants && selectedBlockVariants.size > 0 ? { selectedBlockVariants } : {}),
    ...(blockVariants.size > 0 ? { blockVariants } : {}),
    ...(brickVariants.size > 0 ? { brickVariants } : {}),
    context: { siteSlug: site.slug, brand: deps.brand, preview },
  };
}

/**
 * Parse `?variants=<JSON>` into a Map<blockId, variantKey>. Bounded by:
 *   - max 100 entries (canvas page-block cap)
 *   - max 4KB raw JSON
 *   - keys must be UUID-shaped (defense against arbitrary keys)
 */
function parseSelectedVariants(raw: unknown): ReadonlyMap<string, string> | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (raw.length > 4096) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const out = new Map<string, string>();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  for (const [k, v] of Object.entries(obj)) {
    if (!UUID_RE.test(k)) continue;
    if (typeof v !== 'string' || v.length === 0 || v.length > 64) continue;
    out.set(k, v);
    if (out.size >= 100) break;
  }
  return out.size > 0 ? out : undefined;
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------

const RATE_LIMIT_RENDER = 120;            // req/min per (user, page)
const RATE_LIMIT_APPLY = 60;              // req/min per (user, page)
const RATE_LIMIT_LOCK = 4;                // req/min per (user, page) — heartbeat is once per 30s
const RATE_LIMIT_WINDOW_MS = 60_000;

export function createCanvasRoutes(deps: CanvasRoutesDeps) {
  const metrics: CanvasMetrics = deps.metrics ?? noopCanvasMetrics;

  /**
   * GET /admin/pages/:id/canvas/render
   * Returns the iframe srcdoc HTML.
   */
  async function getRender(req: RequestWithUser, res: Response): Promise<void> {
    const userId = req.userId;
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const enabled = assertCanvasEnabled();
    if (!enabled.ok) return sendError(res, enabled.httpStatus, enabled.code, enabled.message);

    const pageId = paramAs(req.params.id);
    if (!pageId) return sendError(res, 400, 'invalid_input', 'page id required');

    if (!deps.rateLimit(`canvas:render:${userId}:${pageId}`, RATE_LIMIT_RENDER, RATE_LIMIT_WINDOW_MS)) {
      return sendError(res, 429, 'rate_limited', 'render rate limit exceeded');
    }

    const tree = await fetchPageTree(deps, pageId);
    if ('notFound' in tree) return sendError(res, 404, 'not_found', 'page not found');

    if (tree.page.composition_mode !== 'blocks') {
      return sendError(res, 404, 'not_found', 'page is not in blocks composition mode');
    }

    const auth = await assertCanAdminSite(deps, userId, tree.page.site_id);
    if (!auth.ok) return sendError(res, auth.httpStatus, auth.code, auth.message);

    const selectedVariants = parseSelectedVariants(req.query.variants);
    const input = await buildRenderInput(
      deps, tree.page, tree.site, tree.blocks, tree.bricks,
      tree.blockDefs, tree.brickDefs, tree.wrappers, /* preview */ true,
      selectedVariants,
    );
    const renderStart = process.hrtime.bigint();
    const result = renderPage(input);
    metrics.observeRender({ phase: 'render', durationSeconds: elapsedSeconds(renderStart) });

    // Document-level backstop sanitisation. Preserves data-trusted-html
    // markers; strips anything outside the platform allowlist.
    const sanitiseStart = process.hrtime.bigint();
    const sanitisedHtml = sanitiseDocument(result.html);
    metrics.observeRender({ phase: 'sanitise', durationSeconds: elapsedSeconds(sanitiseStart) });

    const etag = `"${result.contentHash}"`;
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.status(200).send(sanitisedHtml);
  }

  /**
   * POST /admin/pages/:id/canvas
   * Validates the envelope; returns 501 in Phase 1 (op handlers in Phase 1.B).
   */
  async function applyOps(req: RequestWithUser, res: Response): Promise<void> {
    const userId = req.userId;
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const enabled = assertCanvasEnabled();
    if (!enabled.ok) return sendError(res, enabled.httpStatus, enabled.code, enabled.message);

    const pageId = paramAs(req.params.id);
    if (!pageId) return sendError(res, 400, 'invalid_input', 'page id required');

    if (!deps.rateLimit(`canvas:apply:${userId}:${pageId}`, RATE_LIMIT_APPLY, RATE_LIMIT_WINDOW_MS)) {
      return sendError(res, 429, 'rate_limited', 'apply rate limit exceeded');
    }

    // Resolve site_id and authorise BEFORE we run any RPC. fetchPageTree
    // is heavier than we need; a single-row pages.site_id select suffices.
    const pageRes = await deps.supabase
      .from('pages')
      .select('site_id')
      .eq('id', pageId)
      .maybeSingle();
    const siteIdRow = (pageRes as { data: { site_id: string } | null }).data;
    if (!siteIdRow) return sendError(res, 404, 'not_found', 'page not found');
    const auth = await assertCanAdminSite(deps, userId, siteIdRow.site_id);
    if (!auth.ok) return sendError(res, auth.httpStatus, auth.code, auth.message);

    const v = validateEnvelope(req.body);
    if (!v.ok) {
      return sendError(res, 400, 'canvas.invalid_op', v.reason, {
        ...(v.field ? { field: v.field } : {}),
        ...(v.index !== undefined ? { index: v.index } : {}),
        ...(v.detail ? { detail: v.detail } : {}),
      });
    }

    const result = await applyEnvelope(deps, pageId, userId, v.value);
    if (result.ok) {
      res.status(result.httpStatus).json(result.response);
      return;
    }
    sendError(res, result.httpStatus, result.code, result.message, result.details);
  }

  /**
   * POST /admin/pages/:id/canvas/lock
   * Acquire / heartbeat the advisory editor lock.
   */
  async function acquireLock(req: RequestWithUser, res: Response): Promise<void> {
    const userId = req.userId;
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const enabled = assertCanvasEnabled();
    if (!enabled.ok) return sendError(res, enabled.httpStatus, enabled.code, enabled.message);

    const pageId = paramAs(req.params.id);
    if (!pageId) return sendError(res, 400, 'invalid_input', 'page id required');

    const body = req.body as { clientToken?: unknown };
    const clientToken = body.clientToken;
    if (typeof clientToken !== 'string' || clientToken.length < 16 || clientToken.length > 64) {
      return sendError(res, 400, 'invalid_input', 'clientToken must be 16..64 chars');
    }

    if (!deps.rateLimit(`canvas:lock:${userId}:${pageId}`, RATE_LIMIT_LOCK, RATE_LIMIT_WINDOW_MS)) {
      return sendError(res, 429, 'rate_limited', 'lock rate limit exceeded');
    }

    const pageRes = await deps.supabase
      .from('pages')
      .select('site_id')
      .eq('id', pageId)
      .maybeSingle();
    const pageRow = (pageRes as { data: { site_id: string } | null }).data;
    if (!pageRow) return sendError(res, 404, 'not_found', 'page not found');
    const auth = await assertCanAdminSite(deps, userId, pageRow.site_id);
    if (!auth.ok) return sendError(res, auth.httpStatus, auth.code, auth.message);

    // Lazy reap stale locks before attempting upsert.
    await deps.supabase.rpc('canvas_reap_stale_locks', { p_ttl_seconds: canvasConfig.lockTtlSeconds });

    const existingRes = await deps.supabase
      .from('page_canvas_locks')
      .select('editor_id, client_token, locked_at, heartbeat_at')
      .eq('page_id', pageId)
      .maybeSingle();
    const existing = (existingRes as {
      data: { editor_id: string; client_token: string; locked_at: string; heartbeat_at: string } | null;
    }).data;

    let stolenFromTab: string | undefined;
    if (existing && existing.editor_id !== userId) {
      metrics.recordLockConflict();
      // Different editor holds the lock — conflict.
      return sendError(res, 409, 'canvas.lock_conflict', 'another editor holds this page', {
        activeEditor: { id: existing.editor_id },
        lockedAt: existing.locked_at,
      });
    }
    if (existing && existing.editor_id === userId && existing.client_token !== clientToken) {
      // Same editor, different tab → steal-back.
      stolenFromTab = existing.client_token;
    }

    const upsertRes = await deps.supabase
      .from('page_canvas_locks')
      .upsert(
        {
          page_id: pageId,
          editor_id: userId,
          client_token: clientToken,
          heartbeat_at: new Date().toISOString(),
        },
        { onConflict: 'page_id' },
      )
      .select('locked_at, heartbeat_at')
      .maybeSingle();
    const upsertErr = (upsertRes as { error: { message: string } | null }).error;
    if (upsertErr) {
      deps.logger.error('canvas.lock.upsert.failed', { userId, pageId, error: upsertErr.message });
      return sendError(res, 500, 'internal', upsertErr.message);
    }

    const expiresAt = new Date(Date.now() + canvasConfig.lockTtlSeconds * 1000).toISOString();
    res.status(200).json({
      locked: true,
      expiresAt,
      ...(stolenFromTab ? { stolenFromTab } : {}),
    });
  }

  /**
   * POST /admin/pages/:id/canvas/unlock
   * Release the lock if (page_id, editor_id, client_token) match.
   */
  async function releaseLock(req: RequestWithUser, res: Response): Promise<void> {
    const userId = req.userId;
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const enabled = assertCanvasEnabled();
    if (!enabled.ok) return sendError(res, enabled.httpStatus, enabled.code, enabled.message);

    const pageId = paramAs(req.params.id);
    if (!pageId) return sendError(res, 400, 'invalid_input', 'page id required');

    const body = req.body as { clientToken?: unknown };
    const clientToken = body.clientToken;
    if (typeof clientToken !== 'string') {
      return sendError(res, 400, 'invalid_input', 'clientToken required');
    }

    await deps.supabase
      .from('page_canvas_locks')
      .delete()
      .eq('page_id', pageId)
      .eq('editor_id', userId)
      .eq('client_token', clientToken);

    res.status(204).end();
  }

  return { getRender, applyOps, acquireLock, releaseLock };
}

export function mountCanvasRoutes(router: Router, routes: ReturnType<typeof createCanvasRoutes>): void {
  router.get('/pages/:id/canvas/render', routes.getRender);
  router.post('/pages/:id/canvas', routes.applyOps);
  router.post('/pages/:id/canvas/lock', routes.acquireLock);
  router.post('/pages/:id/canvas/unlock', routes.releaseLock);
}
