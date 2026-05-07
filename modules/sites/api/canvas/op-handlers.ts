/**
 * Canvas op-handler — orchestrates a single applyOps request. Per
 * spec-sites-wysiwyg-builder §6.1.
 *
 * Flow:
 *   1. Idempotency check — if (page_id, idempotency_key) already exists,
 *      return the cached response with the original status.
 *   2. Pre-flight schema validation — runs Ajv-lite (`schema-validate`)
 *      against block_def.schema for any op that carries `content` or
 *      `newValue`.
 *   3. SQL dispatch — calls the public.canvas_apply_ops PL/pgSQL function
 *      which acquires the row lock, applies ops transactionally, bumps
 *      pages.version, and flips wysiwyg_locked.
 *   4. Tree re-read + render — fetches the post-apply tree and calls
 *      `renderPage` to produce the new iframe srcdoc HTML.
 *   5. Cache the response under (page_id, idempotency_key) for 1 hour.
 *
 * Errors map to the canvas.* error codes in spec §9. The route handler
 * (canvas-routes.ts) translates each domain code to its HTTP status.
 */

import type { OpEnvelope, ApplyOpsResponse, RenderResult, CanvasOp } from '../../lib/canvas-render/index.js';
import { renderPage } from '../../lib/canvas-render/index.js';
import { validateContent, validateFieldUpdate } from './schema-validate.js';
import type { ContentValidationResult } from './schema-validate.js';
import { sanitiseHtmlField, sanitiseTrustedHtmlField, sanitiseDocument } from '@gatewaze/shared/sanitisers';
import { lookupSchema } from '../../lib/canvas-render/index.js';
import { noopCanvasMetrics, type CanvasMetrics, elapsedSeconds } from './canvas-metrics.js';

// Re-uses the row-shape interfaces from canvas-routes.ts. To avoid duplicating
// them we re-declare locally; both are aligned with the actual DB columns.

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
  canvas_validated: boolean;
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
}

// ----------------------------------------------------------------------------
// Op-handler dependency shape — matches the relevant slice of CanvasRoutesDeps.
// ----------------------------------------------------------------------------

export interface OpHandlerDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any; rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> };
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  brand: string;
  resolveAssetUrl: (mediaId: string) => Promise<{ url: string; alt?: string } | null>;
  metrics?: CanvasMetrics;
}

// ----------------------------------------------------------------------------
// Result envelope returned to the route handler.
// ----------------------------------------------------------------------------

export type ApplyOpsResult =
  | { ok: true; response: ApplyOpsResponse; httpStatus: 200 }
  | { ok: false; httpStatus: number; code: string; message: string; details?: Record<string, unknown> };

// ----------------------------------------------------------------------------
// Main entry point
// ----------------------------------------------------------------------------

export async function applyEnvelope(
  deps: OpHandlerDeps,
  pageId: string,
  editorId: string,
  envelope: OpEnvelope,
): Promise<ApplyOpsResult> {
  const metrics: CanvasMetrics = deps.metrics ?? noopCanvasMetrics;
  const requestStart = process.hrtime.bigint();

  // Helper: record the same outcome against every op in the batch.
  // Cardinality is bounded by the canvas op-kinds enumeration in §5.3.
  function emitObservations(result: string): void {
    const elapsed = elapsedSeconds(requestStart);
    // Per-op duration is the batch wall-clock divided across ops; record
    // once per op with the same total so {op_kind} cardinality is useful
    // even when ops are coalesced.
    for (const op of envelope.ops) {
      metrics.observeOp({ opKind: op.kind, result, durationSeconds: elapsed });
    }
  }

  // 1. Idempotency check.
  const cached = await checkIdempotencyCache(deps, pageId, envelope.idempotencyKey);
  if (cached) {
    deps.logger.info('canvas.apply.idempotency_replay', { pageId, key: envelope.idempotencyKey });
    emitObservations(cached.ok ? 'idempotency_replay_ok' : 'idempotency_replay_err');
    return cached;
  }

  // 2. Resolve site + library + block_defs needed for pre-flight validation.
  const preflightStart = process.hrtime.bigint();
  const ctx = await loadValidationContext(deps, pageId);
  if ('error' in ctx) {
    metrics.observeRender({ phase: 'preflight', durationSeconds: elapsedSeconds(preflightStart) });
    emitObservations(ctx.error.ok ? 'ok' : ctx.error.code);
    return ctx.error;
  }

  // 3. Pre-flight content validation per op.
  const validationFail = preflightValidate(envelope, ctx);
  metrics.observeRender({ phase: 'preflight', durationSeconds: elapsedSeconds(preflightStart) });
  if (validationFail) {
    emitObservations(validationFail.ok ? 'ok' : validationFail.code);
    return cacheAndReturn(deps, pageId, envelope.idempotencyKey, validationFail);
  }

  // 3.b Save-time sanitisation: walk every block.update_field /
  // block.insert / brick.update_field / brick.insert op and run the
  // appropriate DOMPurify config on any field whose schema declares
  // format: "html" or format: "trusted-html". Mutates the op payload
  // in-place — the SQL function then writes the SANITISED value, never
  // the raw user input. Per spec-sites-wysiwyg-builder §7.1.
  const sanitisedOps = sanitiseOps(envelope.ops, ctx);

  // 4. Dispatch to canvas_apply_ops.
  const applyStart = process.hrtime.bigint();
  const rpc = await deps.supabase.rpc('canvas_apply_ops', {
    p_page_id: pageId,
    p_base_version: envelope.baseVersion,
    p_client_token: envelope.clientToken,
    p_editor_id: editorId,
    p_ops: sanitisedOps,
  });
  metrics.observeRender({ phase: 'apply', durationSeconds: elapsedSeconds(applyStart) });
  if (rpc.error) {
    deps.logger.error('canvas.apply.rpc_failed', { pageId, error: rpc.error.message });
    emitObservations('internal');
    return {
      ok: false,
      httpStatus: 500,
      code: 'internal',
      message: rpc.error.message,
    };
  }

  const data = rpc.data as { newVersion?: number; warnings?: ReadonlyArray<{ code: string; message: string }>; error?: { code: string; message: string; actualVersion?: number } } | null;
  if (!data) {
    emitObservations('internal');
    return { ok: false, httpStatus: 500, code: 'internal', message: 'canvas_apply_ops returned null' };
  }
  if (data.error) {
    if (data.error.code === 'canvas.lock_conflict') metrics.recordLockConflict();
    emitObservations(data.error.code);
    return mapDomainErrorToHttp(data.error);
  }
  if (typeof data.newVersion !== 'number') {
    emitObservations('internal');
    return { ok: false, httpStatus: 500, code: 'internal', message: 'canvas_apply_ops missing newVersion' };
  }

  // 5. Tree re-read + render.
  const renderStart = process.hrtime.bigint();
  const renderResult = await rerenderPage(deps, pageId);
  metrics.observeRender({ phase: 'render', durationSeconds: elapsedSeconds(renderStart) });
  if ('error' in renderResult) {
    emitObservations('internal');
    return renderResult.error;
  }

  const response: ApplyOpsResponse = {
    newVersion: data.newVersion,
    render: renderResult.render,
    warnings: data.warnings ?? [],
  };

  // 6. Cache the response for 1 hour (idempotency replay).
  await cacheResponse(deps, pageId, envelope.idempotencyKey, response, 200);

  emitObservations('ok');
  return { ok: true, response, httpStatus: 200 };
}

// ----------------------------------------------------------------------------
// Idempotency cache
// ----------------------------------------------------------------------------

async function checkIdempotencyCache(
  deps: OpHandlerDeps,
  pageId: string,
  idempotencyKey: string,
): Promise<ApplyOpsResult | null> {
  const res = await deps.supabase
    .from('canvas_idempotency')
    .select('response, http_status, expires_at')
    .eq('page_id', pageId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  const row = (res as { data: { response: unknown; http_status: number; expires_at: string } | null }).data;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  if (row.http_status === 200) {
    return { ok: true, response: row.response as ApplyOpsResponse, httpStatus: 200 };
  }
  // Cached error.
  const err = row.response as { code: string; message: string; details?: Record<string, unknown> };
  return {
    ok: false,
    httpStatus: row.http_status,
    code: err.code,
    message: err.message,
    ...(err.details ? { details: err.details } : {}),
  };
}

async function cacheResponse(
  deps: OpHandlerDeps,
  pageId: string,
  idempotencyKey: string,
  response: ApplyOpsResponse | { code: string; message: string; details?: Record<string, unknown> },
  httpStatus: number,
): Promise<void> {
  await deps.supabase
    .from('canvas_idempotency')
    .upsert(
      {
        page_id: pageId,
        idempotency_key: idempotencyKey,
        response,
        http_status: httpStatus,
      },
      { onConflict: 'page_id,idempotency_key' },
    );
}

function cacheAndReturn(
  deps: OpHandlerDeps,
  pageId: string,
  idempotencyKey: string,
  result: ApplyOpsResult,
): ApplyOpsResult {
  if (!result.ok) {
    // Fire-and-forget; error caching is best-effort.
    void cacheResponse(
      deps,
      pageId,
      idempotencyKey,
      { code: result.code, message: result.message, ...(result.details ? { details: result.details } : {}) },
      result.httpStatus,
    );
  }
  return result;
}

// ----------------------------------------------------------------------------
// Pre-flight schema validation
// ----------------------------------------------------------------------------

interface ValidationContext {
  page: PageRow;
  site: SiteRow;
  blockDefsByKey: Map<string, BlockDefRow>;
  blockDefsById: Map<string, BlockDefRow>;
  brickDefsByBlockAndKey: Map<string, BrickDefRow>;
}

async function loadValidationContext(
  deps: OpHandlerDeps,
  pageId: string,
): Promise<{ page: PageRow; site: SiteRow; blockDefsByKey: Map<string, BlockDefRow>; blockDefsById: Map<string, BlockDefRow>; brickDefsByBlockAndKey: Map<string, BrickDefRow> } | { error: ApplyOpsResult }> {
  const pageRes = await deps.supabase
    .from('pages')
    .select('id, site_id, composition_mode, wrapper_id, content, title, full_path, version, wysiwyg_locked')
    .eq('id', pageId)
    .maybeSingle();
  const page = (pageRes as { data: PageRow | null }).data;
  if (!page) {
    return { error: { ok: false, httpStatus: 404, code: 'not_found', message: 'page not found' } };
  }
  if (page.composition_mode !== 'blocks') {
    return { error: { ok: false, httpStatus: 409, code: 'canvas.invalid_composition_mode', message: 'page is not in blocks composition mode' } };
  }

  const siteRes = await deps.supabase
    .from('sites')
    .select('id, slug, templates_library_id')
    .eq('id', page.site_id)
    .maybeSingle();
  const site = (siteRes as { data: SiteRow | null }).data;
  if (!site || !site.templates_library_id) {
    return { error: { ok: false, httpStatus: 409, code: 'canvas.no_library', message: 'site has no templates library bound' } };
  }

  // Load all block_defs for the library — keyed both by id and by key for op resolution.
  const defsRes = await deps.supabase
    .from('templates_block_defs')
    .select('id, key, html, schema, has_bricks, thumbnail_url, canvas_validated')
    .eq('library_id', site.templates_library_id)
    .eq('is_current', true);
  const defs = ((defsRes as { data: BlockDefRow[] | null }).data ?? []);
  const blockDefsByKey = new Map<string, BlockDefRow>();
  const blockDefsById = new Map<string, BlockDefRow>();
  for (const d of defs) {
    blockDefsByKey.set(d.key, d);
    blockDefsById.set(d.id, d);
  }

  // Load brick_defs for those blocks.
  const blockDefIds = defs.map((d) => d.id);
  const brickDefsByBlockAndKey = new Map<string, BrickDefRow>();
  if (blockDefIds.length > 0) {
    const brickRes = await deps.supabase
      .from('templates_brick_defs')
      .select('id, key, html, schema, block_def_id')
      .in('block_def_id', blockDefIds);
    const bricks = ((brickRes as { data: BrickDefRow[] | null }).data ?? []);
    for (const b of bricks) {
      brickDefsByBlockAndKey.set(`${b.block_def_id}:${b.key}`, b);
    }
  }

  return { page, site, blockDefsByKey, blockDefsById, brickDefsByBlockAndKey };
}

/**
 * Walk each op and sanitise any string value bound for a field whose schema
 * declares `format: "html"` or `format: "trusted-html"`. Returns a new ops
 * array with sanitised values; never mutates the input. Per spec §7.1.
 *
 * Limitation: this only catches ops we can resolve a block_def schema for
 * (block.* with a known blockDefKey via insert OR via lookup-by-block-id
 * for update_field/set_variant). For brick.update_field we'd need to
 * resolve the brick_def schema; v1 conservatively re-sanitises with the
 * HTML config (no trusted-html bypass) for any string newValue/content
 * field whose path could plausibly contain HTML. The document-level pass
 * is the backstop.
 */
function sanitiseOps(ops: ReadonlyArray<CanvasOp>, ctx: ValidationContext): ReadonlyArray<CanvasOp> {
  return ops.map((op) => {
    if (op.kind === 'block.insert') {
      const def = ctx.blockDefsByKey.get(op.blockDefKey);
      if (!def) return op;
      const cleaned = sanitiseObjectByFormat(op.content, def.schema);
      return { ...op, content: cleaned };
    }
    if (op.kind === 'block.update_field') {
      // Need the block's def — preflight didn't fetch it. Defer to the
      // document-level backstop for this kind in v1; covered by §7.1
      // defense in depth. (Phase 2: pre-fetch the affected blocks at
      // preflight time + thread through.)
      if (typeof op.newValue === 'string') {
        return { ...op, newValue: sanitiseHtmlField(op.newValue) };
      }
      return op;
    }
    if (op.kind === 'brick.insert') {
      // brick_def schema not in ValidationContext (preflight skipped it).
      // Conservative pass: sanitise any string property value.
      if (op.content && typeof op.content === 'object') {
        const cleaned: Record<string, unknown> = { ...op.content };
        for (const [k, v] of Object.entries(cleaned)) {
          if (typeof v === 'string') cleaned[k] = sanitiseHtmlField(v);
        }
        return { ...op, content: cleaned };
      }
      return op;
    }
    if (op.kind === 'brick.update_field') {
      if (typeof op.newValue === 'string') {
        return { ...op, newValue: sanitiseHtmlField(op.newValue) };
      }
      return op;
    }
    if (op.kind === 'block.upsert_variant_content' || op.kind === 'brick.upsert_variant_content') {
      // Variant content goes through the same sanitisation as the default
      // payload. We don't have the def in scope (preflight didn't fetch
      // by id); apply the conservative HTML-only pass on every string
      // property. Document-level pass is the backstop.
      if (op.content && typeof op.content === 'object') {
        const cleaned: Record<string, unknown> = { ...op.content };
        for (const [k, v] of Object.entries(cleaned)) {
          if (typeof v === 'string') cleaned[k] = sanitiseHtmlField(v);
        }
        return { ...op, content: cleaned };
      }
      return op;
    }
    // block.move / block.delete / block.set_variant / brick.move /
    // brick.delete / preset.apply carry no user-supplied HTML.
    return op;
  });
}

function sanitiseObjectByFormat(value: Record<string, unknown>, schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  for (const [key, fieldValue] of Object.entries(out)) {
    if (typeof fieldValue !== 'string') continue;
    const fieldSchema = lookupSchema(schema, key);
    if (typeof fieldSchema !== 'object' || fieldSchema === null) continue;
    const fmt = (fieldSchema as { format?: string }).format;
    if (fmt === 'html') {
      out[key] = sanitiseHtmlField(fieldValue);
    } else if (fmt === 'trusted-html') {
      out[key] = sanitiseTrustedHtmlField(fieldValue);
    }
  }
  return out;
}

function preflightValidate(envelope: OpEnvelope, ctx: ValidationContext): ApplyOpsResult | null {
  for (let i = 0; i < envelope.ops.length; i++) {
    const op = envelope.ops[i];

    if (op.kind === 'block.insert') {
      const def = ctx.blockDefsByKey.get(op.blockDefKey);
      if (!def) {
        return validationError(`block_def with key '${op.blockDefKey}' not found in library`, i);
      }
      if (!def.canvas_validated) {
        return validationError(`block_def '${op.blockDefKey}' is not canvas_validated`, i, 'canvas.block_def_not_validated');
      }
      const r = validateContent(op.content, def.schema);
      if (!r.ok) return contentValidationError(r, i);
    } else if (op.kind === 'block.update_field') {
      // Need to resolve the block's def — we don't have the block in context yet, so
      // we walk by id via a lookup. For Phase 1 we'll trust the SQL function to
      // reject invalid blockId; schema validation here is best-effort: skip when
      // we can't resolve the block_def_id.
      // (A future optimisation: bulk-fetch the affected blocks at preflight time.)
    } else if (op.kind === 'brick.insert') {
      // Brick def is keyed by (block_def_id, key); we don't yet know the block_def_id
      // for a given pageBlockId without a fetch. Skip preflight on brick.insert for
      // Phase 1 — the SQL function rejects unknown brick_def_keys with a 23503.
    } else if (op.kind === 'preset.apply') {
      // Preset content is validated server-side at preset-save time; skip here.
    }
    // Other op kinds (block.move, block.delete, block.set_variant, brick.move,
    // brick.delete, brick.update_field) carry no schema-validatable content.
  }
  return null;
}

function validationError(message: string, index: number, code = 'canvas.field_validation'): ApplyOpsResult {
  return {
    ok: false,
    httpStatus: 400,
    code,
    message,
    details: { index },
  };
}

function contentValidationError(r: Exclude<ContentValidationResult, { ok: true }>, index: number): ApplyOpsResult {
  return {
    ok: false,
    httpStatus: 400,
    code: 'canvas.field_validation',
    message: 'content does not match block_def schema',
    details: { index, issues: r.issues },
  };
}

// ----------------------------------------------------------------------------
// Domain error → HTTP mapping (per spec §9)
// ----------------------------------------------------------------------------

function mapDomainErrorToHttp(err: { code: string; message: string; actualVersion?: number }): ApplyOpsResult {
  const status = STATUS_BY_CODE[err.code] ?? 500;
  const result: ApplyOpsResult = {
    ok: false,
    httpStatus: status,
    code: err.code,
    message: err.message,
    ...(err.actualVersion !== undefined ? { details: { actualVersion: err.actualVersion } } : {}),
  };
  return result;
}

const STATUS_BY_CODE: Record<string, number> = {
  'canvas.invalid_op': 400,
  'canvas.field_validation': 400,
  'canvas.dangling_ref': 400,
  'canvas.preset_validation': 400,
  'canvas.block_def_not_found': 400,
  'canvas.brick_def_not_found': 400,
  'canvas.block_def_not_validated': 400,
  'canvas.preset_not_found': 400,
  'canvas.preset_block_def_invalid': 400,
  'canvas.preset_brick_def_invalid': 400,
  'canvas.preset_wrong_site': 400,
  'canvas.no_library': 409,
  'canvas.invalid_composition_mode': 409,
  'canvas.version_conflict': 409,
  'canvas.lock_conflict': 409,
  'canvas.lock_not_held': 403,
  'canvas.cycle_detected': 422,
  'canvas.depth_exceeded': 422,
  'canvas.block_count_exceeded': 422,
  'canvas.unsafe_substitution': 422,
  'not_found': 404,
};

// ----------------------------------------------------------------------------
// Tree re-read + render
// ----------------------------------------------------------------------------

async function rerenderPage(
  deps: OpHandlerDeps,
  pageId: string,
): Promise<{ render: RenderResult } | { error: ApplyOpsResult }> {
  // Fetch the post-apply tree.
  const pageRes = await deps.supabase
    .from('pages')
    .select('id, site_id, composition_mode, wrapper_id, content, title, full_path, version, wysiwyg_locked')
    .eq('id', pageId)
    .maybeSingle();
  const page = (pageRes as { data: PageRow | null }).data;
  if (!page) {
    return { error: { ok: false, httpStatus: 500, code: 'internal', message: 'page disappeared after apply' } };
  }

  const siteRes = await deps.supabase
    .from('sites')
    .select('id, slug, templates_library_id')
    .eq('id', page.site_id)
    .maybeSingle();
  const site = (siteRes as { data: SiteRow | null }).data;
  if (!site) {
    return { error: { ok: false, httpStatus: 500, code: 'internal', message: 'site disappeared after apply' } };
  }

  const blocksRes = await deps.supabase
    .from('page_blocks')
    .select('id, page_id, block_def_id, parent_brick_id, sort_order, content, variant_key')
    .eq('page_id', pageId)
    .order('sort_order', { ascending: true });
  const blocks = ((blocksRes as { data: PageBlockRow[] | null }).data ?? []);

  const blockIds = blocks.map((b) => b.id);
  const bricks = blockIds.length === 0
    ? []
    : (((await deps.supabase
        .from('page_block_bricks')
        .select('id, page_block_id, brick_def_id, sort_order, content, variant_key')
        .in('page_block_id', blockIds)
        .order('sort_order', { ascending: true })) as { data: PageBrickRow[] | null }).data ?? []);

  const blockDefIds = Array.from(new Set(blocks.map((b) => b.block_def_id)));
  const blockDefs = new Map<string, BlockDefRow>();
  if (blockDefIds.length > 0) {
    const defsRes = await deps.supabase
      .from('templates_block_defs')
      .select('id, key, html, schema, has_bricks, thumbnail_url, canvas_validated')
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
      .select('id, key, html')
      .eq('id', page.wrapper_id)
      .maybeSingle();
    const w = (wrapRes as { data: WrapperRow | null }).data;
    if (w) wrappers.set(w.id, w);
  }

  // Build asset map.
  const assetIds = new Set<string>();
  function gather(value: unknown): void {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) { for (const v of value) gather(v); return; }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (typeof obj.id === 'string' && (obj.url !== undefined || obj.alt !== undefined)) {
        assetIds.add(obj.id);
      }
      for (const v of Object.values(obj)) gather(v);
    }
  }
  for (const b of blocks) gather(b.content);
  for (const b of bricks) gather(b.content);

  const assets = new Map<string, { url: string; alt?: string }>();
  for (const id of assetIds) {
    const resolved = await deps.resolveAssetUrl(id);
    if (resolved) assets.set(id, resolved);
  }

  // Build the tree.
  const bricksByBlock = new Map<string, PageBrickRow[]>();
  for (const b of bricks) {
    const arr = bricksByBlock.get(b.page_block_id) ?? [];
    arr.push(b);
    bricksByBlock.set(b.page_block_id, arr);
  }
  const blocksByBrick = new Map<string | null, PageBlockRow[]>();
  for (const b of blocks) {
    const key = b.parent_brick_id;
    const arr = blocksByBrick.get(key) ?? [];
    arr.push(b);
    blocksByBrick.set(key, arr);
  }

  function buildBlock(row: PageBlockRow) {
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
  function buildBrick(row: PageBrickRow) {
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

  const rawRender = renderPage({
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
    blockDefs: new Map(Array.from(blockDefs).map(([id, r]) => [id, {
      id: r.id, key: r.key, html: r.html, schema: r.schema, has_bricks: r.has_bricks, thumbnail_url: r.thumbnail_url,
    }])),
    brickDefs: new Map(Array.from(brickDefs).map(([id, r]) => [id, {
      id: r.id, key: r.key, html: r.html, schema: r.schema,
    }])),
    wrappers: new Map(Array.from(wrappers).map(([id, r]) => [id, { id: r.id, key: r.key, html: r.html }])),
    assets,
    context: { siteSlug: site.slug, brand: deps.brand, preview: true },
  });

  // Document-level backstop sanitisation pass on the final HTML.
  // Catches anything the save-time pass missed; preserves elements
  // stamped with data-trusted-html. Per spec §7.1.
  const sanitisedHtml = sanitiseDocument(rawRender.html);
  const renderResult: RenderResult = {
    ...rawRender,
    html: sanitisedHtml,
  };

  return { render: renderResult };
}
