/**
 * GET /api/admin/sites/:siteSlug/block-defs
 *
 * Returns the active templates_block_defs (+ brick_defs) for the site's
 * bound library. Per spec-sites-wysiwyg-builder §6.5: cached for ~60s in
 * process, busted on Postgres NOTIFY 'templates_invalidate'.
 *
 * The cache key is `${library_id}` (block defs are library-scoped, not
 * site-scoped — multiple sites pointing at the same library share an
 * entry). siteSlug → library_id resolution is itself cached for 60s.
 *
 * Cache invalidation:
 *   - 60s TTL (sliding hard ceiling)
 *   - NOTIFY 'templates_invalidate' with payload '<library_id>' OR '*'
 *     (the workflow that publishes a new library version emits the
 *     library_id; '*' is a force-all sledgehammer)
 *   - The LISTEN connection is owned by the createBlockDefsRoute factory
 *     (one per process). If it fails, the cache still expires on TTL.
 */

import type { Request, Response, Router } from 'express';
import { assertCanvasEnabled } from './canvas-auth.js';

interface RequestWithUser extends Request {
  userId?: string;
}

function paramAs(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return undefined;
}

interface ErrorEnvelope {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

function sendError(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  const body: ErrorEnvelope = { error: { code, message, ...(details ? { details } : {}) } };
  res.status(status).json(body);
}

interface BlockDefRow {
  id: string;
  key: string;
  html: string;
  schema: Record<string, unknown>;
  has_bricks: boolean;
  thumbnail_url: string | null;
  canvas_validated: boolean | null;
}

interface BrickDefRow {
  id: string;
  block_def_id: string;
  key: string;
  html: string;
  schema: Record<string, unknown>;
}

export interface BlockDefsResponse {
  libraryId: string;
  blockDefs: ReadonlyArray<{
    id: string;
    key: string;
    html: string;
    schema: Record<string, unknown>;
    has_bricks: boolean;
    thumbnail_url: string | null;
    canvas_validated: boolean | null;
    bricks: ReadonlyArray<{
      id: string;
      key: string;
      html: string;
      schema: Record<string, unknown>;
    }>;
  }>;
  cachedAt: string;
}

export interface BlockDefsDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any };
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Cache TTL in ms (default 60_000). */
  cacheTtlMs?: number;
  /**
   * Optional Postgres LISTEN handle. The factory subscribes to
   * 'templates_invalidate' on construction; if pgListen is null, only
   * TTL-based eviction runs. The handle is invoked with a callback
   * that receives the NOTIFY payload (library_id or '*').
   */
  pgListen?: ((channel: string, onNotify: (payload: string) => void) => Promise<void>) | null;
}

interface CacheEntry {
  data: BlockDefsResponse;
  expiresAt: number;
}

export function createBlockDefsRoute(deps: BlockDefsDeps) {
  const ttl = deps.cacheTtlMs ?? 60_000;
  const cache = new Map<string, CacheEntry>(); // keyed by library_id
  const slugToLibrary = new Map<string, { libraryId: string; expiresAt: number }>();

  function invalidate(payload: string): void {
    if (payload === '*' || payload === '') {
      cache.clear();
      slugToLibrary.clear();
      deps.logger.info('canvas.block-defs.cache.invalidated_all');
      return;
    }
    if (cache.delete(payload)) {
      deps.logger.info('canvas.block-defs.cache.invalidated', { libraryId: payload });
    }
  }

  // Best-effort LISTEN subscription. The platform owns the connection;
  // if it can't be established the cache still expires on TTL.
  if (deps.pgListen) {
    void deps.pgListen('templates_invalidate', (payload) => {
      try {
        invalidate(payload);
      } catch (err) {
        deps.logger.error('canvas.block-defs.notify_handler_failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }).catch((err) => {
      deps.logger.warn('canvas.block-defs.pg_listen_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async function resolveLibraryId(siteSlug: string): Promise<string | null> {
    const cached = slugToLibrary.get(siteSlug);
    if (cached && cached.expiresAt > Date.now()) return cached.libraryId;

    const siteRes = await deps.supabase
      .from('sites')
      .select('id, templates_library_id')
      .eq('slug', siteSlug)
      .maybeSingle();
    const site = (siteRes as { data: { id: string; templates_library_id: string | null } | null }).data;
    if (!site || !site.templates_library_id) return null;

    slugToLibrary.set(siteSlug, { libraryId: site.templates_library_id, expiresAt: Date.now() + ttl });
    return site.templates_library_id;
  }

  async function loadBlockDefs(libraryId: string): Promise<BlockDefsResponse> {
    const defsRes = await deps.supabase
      .from('templates_block_defs')
      .select('id, key, html, schema, has_bricks, thumbnail_url, canvas_validated')
      .eq('library_id', libraryId)
      .eq('is_current', true);
    const blockDefs = ((defsRes as { data: BlockDefRow[] | null }).data ?? []);

    const containerIds = blockDefs.filter((d) => d.has_bricks).map((d) => d.id);
    const bricksByBlock = new Map<string, BrickDefRow[]>();
    if (containerIds.length > 0) {
      const brickRes = await deps.supabase
        .from('templates_brick_defs')
        .select('id, block_def_id, key, html, schema')
        .in('block_def_id', containerIds);
      for (const r of ((brickRes as { data: BrickDefRow[] | null }).data ?? [])) {
        const arr = bricksByBlock.get(r.block_def_id) ?? [];
        arr.push(r);
        bricksByBlock.set(r.block_def_id, arr);
      }
    }

    return {
      libraryId,
      blockDefs: blockDefs.map((d) => ({
        id: d.id,
        key: d.key,
        html: d.html,
        schema: d.schema,
        has_bricks: d.has_bricks,
        thumbnail_url: d.thumbnail_url,
        canvas_validated: d.canvas_validated,
        bricks: (bricksByBlock.get(d.id) ?? []).map((b) => ({
          id: b.id,
          key: b.key,
          html: b.html,
          schema: b.schema,
        })),
      })),
      cachedAt: new Date().toISOString(),
    };
  }

  return async function blockDefs(req: RequestWithUser, res: Response): Promise<void> {
    const userId = req.userId;
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const enabled = assertCanvasEnabled();
    if (!enabled.ok) return sendError(res, enabled.httpStatus, enabled.code, enabled.message);

    const siteSlug = paramAs(req.params.siteSlug);
    if (!siteSlug) return sendError(res, 400, 'invalid_input', 'siteSlug required');

    const libraryId = await resolveLibraryId(siteSlug);
    if (!libraryId) {
      return sendError(res, 404, 'canvas.no_library',
        `site '${siteSlug}' not found or has no templates_library_id`);
    }

    const now = Date.now();
    const hit = cache.get(libraryId);
    if (hit && hit.expiresAt > now) {
      res.setHeader('X-Cache', 'HIT');
      res.status(200).json(hit.data);
      return;
    }

    try {
      const data = await loadBlockDefs(libraryId);
      cache.set(libraryId, { data, expiresAt: now + ttl });
      res.setHeader('X-Cache', 'MISS');
      res.status(200).json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error('canvas.block-defs.load_failed', { siteSlug, libraryId, err: message });
      return sendError(res, 500, 'internal', message);
    }
  };
}

export function mountBlockDefsRoute(router: Router, handler: ReturnType<typeof createBlockDefsRoute>): void {
  router.get('/sites/:siteSlug/block-defs', handler);
}
