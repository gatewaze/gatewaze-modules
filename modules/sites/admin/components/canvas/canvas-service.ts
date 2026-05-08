/**
 * Thin client for the canvas API. Per spec-sites-wysiwyg-builder §6.
 *
 * Each method returns a discriminated-union result instead of throwing —
 * the React layer maps codes to toasts + UI affordances (e.g. version
 * conflict opens a "page changed elsewhere" modal).
 */

import { supabase } from '@/lib/supabase';
import type {
  ApplyOpsResponse,
  OpEnvelope,
} from '../../../lib/canvas-render/types.js';

const API_URL = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type CanvasError = {
  code: string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
};

export type ApplyResult =
  | { ok: true; response: ApplyOpsResponse }
  | { ok: false; error: CanvasError };

export type LockResult =
  | { ok: true; expiresAt: string; stolenFromTab?: string }
  | { ok: false; error: CanvasError };

export type RenderResult =
  | { ok: true; html: string; etag: string | null }
  | { ok: 'not-modified' }
  | { ok: false; error: CanvasError };

async function parseError(res: Response): Promise<CanvasError> {
  let body: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } = {};
  try { body = await res.json(); } catch { /* non-JSON */ }
  return {
    code: body.error?.code ?? `http_${res.status}`,
    message: body.error?.message ?? `Request failed (${res.status})`,
    status: res.status,
    ...(body.error?.details ? { details: body.error.details } : {}),
  };
}

export interface BlockDefSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  thumbnail_url: string | null;
  has_bricks: boolean;
  schema: Record<string, unknown>;
  /** Mustache template HTML — needed by the Puck client renderer. */
  html: string;
  /** 'website' | 'email' — channel discriminator. */
  theme_kind: 'website' | 'email';
  /** Brick keys when has_bricks=true. */
  brick_slots: ReadonlyArray<{ key: string; label: string }>;
}

export type ListBlockDefsResult =
  | { ok: true; blockDefs: ReadonlyArray<BlockDefSummary> }
  | { ok: false; error: CanvasError };

/**
 * Brick_def view returned by listBrickDefs. The Puck adapter needs the
 * parent_block_def_key + key to build Slot `allow` lists, plus the schema
 * to render the brick's field form.
 */
export interface BrickDefView {
  id: string;
  key: string;
  name: string;
  parent_block_def_id: string;
  parent_block_def_key: string;
  schema: Record<string, unknown>;
  /** Mustache template HTML for the brick body. */
  html: string;
  theme_kind: 'website' | 'email';
}

export type ListBrickDefsResult =
  | { ok: true; brickDefs: ReadonlyArray<BrickDefView> }
  | { ok: false; error: CanvasError };

/**
 * Full structured load of a blocks-mode page. Used by PuckCanvasEditor
 * to build initial PuckData and the diff baseline. Per
 * spec-builder-evaluation §3.3 (load path).
 *
 * Note: this duplicates a small amount of work that the legacy editor
 * does indirectly (it fetches rendered HTML + uses postMessage for
 * structure). Pulling the structured rows directly is cleaner for the
 * Puck path and keeps the diff baseline cache fresh.
 */
export interface PageTreeView {
  page: {
    id: string;
    wrapper_key: string | null;
    root_meta: Record<string, unknown>;
    wysiwyg_locked: boolean;
    version: number;
  };
  topLevel: ReadonlyArray<{
    id: string;
    block_def_id: string;
    block_def_key: string;
    parent_brick_id: string | null;
    sort_order: number;
    variant_key: string;
    has_bricks: boolean;
    content: Record<string, unknown>;
  }>;
  bricks: ReadonlyArray<{
    id: string;
    page_block_id: string;
    brick_def_id: string;
    brick_def_key: string;
    sort_order: number;
    variant_key: string;
    content: Record<string, unknown>;
  }>;
}

export type LoadPageTreeResult =
  | { ok: true; tree: PageTreeView }
  | { ok: false; error: CanvasError };

export interface PresetSummary {
  id: string;
  name: string;
  description: string | null;
  preview_image: string | null;
  block_def_key: string;
  applicable: boolean;
  created_at: string;
}

export type ListPresetsResult =
  | { ok: true; presets: ReadonlyArray<PresetSummary> }
  | { ok: false; error: CanvasError };

export type SavePresetResult =
  | { ok: true; preset: PresetSummary }
  | { ok: false; error: CanvasError };

export interface AbTestVariant {
  key: string;
  weight: number;
}

export interface AbTestSummary {
  id: string;
  name: string;
  status: 'draft' | 'running' | 'paused' | 'concluded';
  variants: ReadonlyArray<AbTestVariant>;
}

export interface BlockSelection {
  blockId: string;
  blockDefId: string;
  blockDefKey: string;
  blockDefSchema: Record<string, unknown>;
  content: Record<string, unknown>;
  variant_key: string;
  parentBrickId: string | null;
  /** sort_order within the cohort, used to compute neighbours for reorder. */
  sortOrder: number;
  /** When the block is the scope of an A/B test, the test summary. */
  abTest: AbTestSummary | null;
}

export type GetBlockResult =
  | { ok: true; selection: BlockSelection; cohort: ReadonlyArray<{ id: string; sort_order: number }> }
  | { ok: false; error: CanvasError };

export const CanvasService = {
  /** GET /api/admin/pages/:id/canvas/render?variants=… */
  async render(
    pageId: string,
    currentEtag: string | null,
    selectedBlockVariants?: ReadonlyMap<string, string>,
  ): Promise<RenderResult> {
    const headers = {
      ...(await authHeaders()),
      ...(currentEtag ? { 'If-None-Match': currentEtag } : {}),
    };
    let url = `${API_URL}/api/admin/pages/${encodeURIComponent(pageId)}/canvas/render`;
    if (selectedBlockVariants && selectedBlockVariants.size > 0) {
      const obj: Record<string, string> = {};
      for (const [k, v] of selectedBlockVariants) obj[k] = v;
      url += `?variants=${encodeURIComponent(JSON.stringify(obj))}`;
    }
    const res = await fetch(url, { method: 'GET', headers });
    if (res.status === 304) return { ok: 'not-modified' };
    if (!res.ok) return { ok: false, error: await parseError(res) };
    const html = await res.text();
    return { ok: true, html, etag: res.headers.get('ETag') };
  },

  /** POST /api/admin/pages/:id/canvas/lock */
  async acquireLock(pageId: string, clientToken: string): Promise<LockResult> {
    const res = await fetch(`${API_URL}/api/admin/pages/${encodeURIComponent(pageId)}/canvas/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ clientToken }),
    });
    if (!res.ok) return { ok: false, error: await parseError(res) };
    const body = await res.json() as { locked: boolean; expiresAt: string; stolenFromTab?: string };
    return body.stolenFromTab
      ? { ok: true, expiresAt: body.expiresAt, stolenFromTab: body.stolenFromTab }
      : { ok: true, expiresAt: body.expiresAt };
  },

  /** POST /api/admin/pages/:id/canvas/unlock — fire-and-forget */
  async releaseLock(pageId: string, clientToken: string): Promise<void> {
    try {
      await fetch(`${API_URL}/api/admin/pages/${encodeURIComponent(pageId)}/canvas/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ clientToken }),
        // Fail-fast: an unmount-time release that fails is fine, the lock
        // will reap itself after 90s.
        keepalive: true,
      });
    } catch { /* swallow — best-effort */ }
  },

  /**
   * List block_defs available in a site's bound library. Hits PostgREST
   * directly via the Supabase client — the GET /admin/sites/:siteSlug/
   * block-defs route is a Phase 2 cache layer; v1 reads the table directly.
   * Filters to is_current=true and canvas_validated=true so the palette
   * never offers an unusable block.
   */
  async listBlockDefs(libraryId: string): Promise<ListBlockDefsResult> {
    try {
      const { data, error } = await supabase
        .from('templates_block_defs')
        .select('id, key, name, description, thumbnail_url, has_bricks, schema, html, theme_kind')
        .eq('library_id', libraryId)
        .eq('is_current', true)
        .eq('canvas_validated', true)
        .order('name');
      if (error) {
        return { ok: false, error: { code: 'palette_fetch_failed', message: error.message, status: 500 } };
      }
      const defs = (data ?? []) as Array<{
        id: string;
        key: string;
        name: string;
        description: string | null;
        thumbnail_url: string | null;
        has_bricks: boolean;
        schema: Record<string, unknown>;
        html: string;
        theme_kind: 'website' | 'email';
      }>;

      // Bulk-fetch brick slots for the has_bricks defs.
      const containerIds = defs.filter((d) => d.has_bricks).map((d) => d.id);
      const brickByBlock = new Map<string, Array<{ key: string; label: string }>>();
      if (containerIds.length > 0) {
        const { data: brickRows } = await supabase
          .from('templates_brick_defs')
          .select('block_def_id, key, name, sort_order')
          .in('block_def_id', containerIds)
          .order('sort_order', { ascending: true });
        for (const r of (brickRows ?? []) as Array<{ block_def_id: string; key: string; name: string }>) {
          const arr = brickByBlock.get(r.block_def_id) ?? [];
          arr.push({ key: r.key, label: r.name });
          brickByBlock.set(r.block_def_id, arr);
        }
      }

      const result: BlockDefSummary[] = defs.map((d) => ({
        id: d.id,
        key: d.key,
        name: d.name,
        description: d.description,
        thumbnail_url: d.thumbnail_url,
        has_bricks: d.has_bricks,
        schema: d.schema,
        html: d.html ?? '',
        theme_kind: d.theme_kind ?? 'website',
        brick_slots: brickByBlock.get(d.id) ?? [],
      }));
      return { ok: true, blockDefs: result };
    } catch (err) {
      return { ok: false, error: { code: 'palette_fetch_failed', message: err instanceof Error ? err.message : String(err), status: 500 } };
    }
  },

  /**
   * Fetch a single block + its block_def schema + the cohort it lives in
   * (siblings sharing the same parent_brick_id) for the move up/down ops.
   */
  async getBlock(blockId: string): Promise<GetBlockResult> {
    try {
      const { data: block, error: blockErr } = await supabase
        .from('page_blocks')
        .select('id, page_id, block_def_id, parent_brick_id, sort_order, content, variant_key')
        .eq('id', blockId)
        .maybeSingle();
      if (blockErr || !block) {
        return { ok: false, error: { code: 'block_not_found', message: blockErr?.message ?? 'block not found', status: 404 } };
      }
      const row = block as {
        id: string; page_id: string; block_def_id: string; parent_brick_id: string | null;
        sort_order: number; content: Record<string, unknown>; variant_key: string;
      };
      const { data: defRow, error: defErr } = await supabase
        .from('templates_block_defs')
        .select('id, key, schema')
        .eq('id', row.block_def_id)
        .maybeSingle();
      if (defErr || !defRow) {
        return { ok: false, error: { code: 'block_def_not_found', message: defErr?.message ?? 'block_def not found', status: 500 } };
      }
      const def = defRow as { id: string; key: string; schema: Record<string, unknown> };

      let cohortQuery = supabase
        .from('page_blocks')
        .select('id, sort_order')
        .eq('page_id', row.page_id)
        .order('sort_order', { ascending: true });
      cohortQuery = row.parent_brick_id === null
        ? cohortQuery.is('parent_brick_id', null)
        : cohortQuery.eq('parent_brick_id', row.parent_brick_id);
      const { data: cohort } = await cohortQuery;

      // Look up the A/B test for this block (block_instance scope), if any.
      const { data: testRow } = await supabase
        .from('templates_ab_tests')
        .select('id, name, status, variants')
        .eq('scope_kind', 'block_instance')
        .eq('scope_id', blockId)
        .maybeSingle();
      const abTest = testRow
        ? {
            id: (testRow as { id: string }).id,
            name: (testRow as { name: string }).name,
            status: (testRow as { status: AbTestSummary['status'] }).status,
            variants: ((testRow as { variants: ReadonlyArray<AbTestVariant> }).variants) ?? [],
          } satisfies AbTestSummary
        : null;

      return {
        ok: true,
        selection: {
          blockId: row.id,
          blockDefId: def.id,
          blockDefKey: def.key,
          blockDefSchema: def.schema,
          content: row.content,
          variant_key: row.variant_key,
          parentBrickId: row.parent_brick_id,
          sortOrder: row.sort_order,
          abTest,
        },
        cohort: (cohort ?? []) as Array<{ id: string; sort_order: number }>,
      };
    } catch (err) {
      return { ok: false, error: { code: 'block_fetch_failed', message: err instanceof Error ? err.message : String(err), status: 500 } };
    }
  },

  /** GET /api/admin/sites/:siteSlug/canvas-presets */
  async listPresets(siteSlug: string): Promise<ListPresetsResult> {
    const res = await fetch(`${API_URL}/api/admin/sites/${encodeURIComponent(siteSlug)}/canvas-presets`, {
      method: 'GET',
      headers: await authHeaders(),
    });
    if (!res.ok) return { ok: false, error: await parseError(res) };
    const presets = await res.json() as PresetSummary[];
    return { ok: true, presets };
  },

  /** POST /api/admin/sites/:siteSlug/canvas-presets */
  async savePreset(siteSlug: string, args: { name: string; description?: string; fromBlockId: string }): Promise<SavePresetResult> {
    const res = await fetch(`${API_URL}/api/admin/sites/${encodeURIComponent(siteSlug)}/canvas-presets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(args),
    });
    if (!res.ok) return { ok: false, error: await parseError(res) };
    return { ok: true, preset: await res.json() as PresetSummary };
  },

  /** DELETE /api/admin/sites/:siteSlug/canvas-presets/:id */
  async deletePreset(siteSlug: string, presetId: string): Promise<{ ok: true } | { ok: false; error: CanvasError }> {
    const res = await fetch(`${API_URL}/api/admin/sites/${encodeURIComponent(siteSlug)}/canvas-presets/${encodeURIComponent(presetId)}`, {
      method: 'DELETE',
      headers: await authHeaders(),
    });
    if (!res.ok && res.status !== 204) return { ok: false, error: await parseError(res) };
    return { ok: true };
  },

  /**
   * List brick_defs for a library, for the Puck adapter's slot allowlists.
   * Mirrors listBlockDefs's PostgREST-direct pattern.
   */
  async listBrickDefs(libraryId: string): Promise<ListBrickDefsResult> {
    try {
      // brick_defs are linked to block_defs; we need the parent block's key.
      // templates_brick_defs has no theme_kind OR is_current column —
      // bricks inherit both from their parent block_def. We pull both
      // via the templates_block_defs join and filter on the parent's
      // is_current=true (so deprecated parent's bricks don't surface).
      const { data, error } = await supabase
        .from('templates_brick_defs')
        .select('id, key, name, schema, html, block_def_id, templates_block_defs!inner(key, library_id, theme_kind, is_current)')
        .eq('templates_block_defs.library_id', libraryId)
        .eq('templates_block_defs.is_current', true)
        .order('name');
      if (error) {
        return { ok: false, error: { code: 'brick_defs_fetch_failed', message: error.message, status: 500 } };
      }
      type Row = {
        id: string;
        key: string;
        name: string;
        schema: Record<string, unknown>;
        html: string;
        block_def_id: string;
        templates_block_defs: { key: string; library_id: string; theme_kind: 'website' | 'email'; is_current: boolean };
      };
      const rows = (data ?? []) as ReadonlyArray<Row>;
      const brickDefs: BrickDefView[] = rows.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        schema: r.schema,
        html: r.html ?? '',
        // Bricks have no own theme_kind column — inherit from parent block.
        theme_kind: r.templates_block_defs.theme_kind ?? 'website',
        parent_block_def_id: r.block_def_id,
        parent_block_def_key: r.templates_block_defs.key,
      }));
      return { ok: true, brickDefs };
    } catch (err) {
      return {
        ok: false,
        error: { code: 'brick_defs_fetch_failed', message: err instanceof Error ? err.message : String(err), status: 500 },
      };
    }
  },

  /**
   * Load the full structured tree for a page. PostgREST-direct so it
   * picks up the same RLS as the rest of the canvas surface.
   *
   * Three queries (page + page_blocks + page_block_bricks) — kept simple
   * and parallelised. The query count doesn't grow with tree size.
   */
  async loadPageTree(pageId: string): Promise<LoadPageTreeResult> {
    try {
      // First fetch page + blocks (page_block_bricks needs the block ids).
      const [pageRes, blocksRes] = await Promise.all([
        supabase
          .from('pages')
          .select('id, wrapper_id, content, version, wysiwyg_locked, templates_wrappers!pages_wrapper_id_fkey(key)')
          .eq('id', pageId)
          .maybeSingle(),
        supabase
          .from('page_blocks')
          .select('id, block_def_id, parent_brick_id, sort_order, variant_key, content, templates_block_defs!inner(key, has_bricks)')
          .eq('page_id', pageId)
          .order('sort_order', { ascending: true }),
      ]);

      const blockIdsForBricks = (blocksRes.data ?? [])
        .filter((b) => (b as { templates_block_defs: { has_bricks: boolean } }).templates_block_defs.has_bricks)
        .map((b) => (b as { id: string }).id);
      const bricksRes = blockIdsForBricks.length > 0
        ? await supabase
            .from('page_block_bricks')
            .select('id, page_block_id, brick_def_id, sort_order, variant_key, content, templates_brick_defs!inner(key)')
            .in('page_block_id', blockIdsForBricks)
            .order('sort_order', { ascending: true })
        : { data: [] as Array<unknown>, error: null as { message: string } | null };

      if (pageRes.error || !pageRes.data) {
        return { ok: false, error: { code: 'page_not_found', message: pageRes.error?.message ?? 'page not found', status: 404 } };
      }
      if (blocksRes.error) {
        return { ok: false, error: { code: 'blocks_fetch_failed', message: blocksRes.error.message, status: 500 } };
      }
      if (bricksRes.error) {
        return { ok: false, error: { code: 'bricks_fetch_failed', message: bricksRes.error.message, status: 500 } };
      }

      const pageRow = pageRes.data as {
        id: string;
        wrapper_id: string | null;
        content: Record<string, unknown> | null;
        version: number;
        wysiwyg_locked: boolean;
        templates_wrappers: { key: string } | null;
      };
      const blockRows = (blocksRes.data ?? []) as ReadonlyArray<{
        id: string;
        block_def_id: string;
        parent_brick_id: string | null;
        sort_order: number;
        variant_key: string;
        content: Record<string, unknown>;
        templates_block_defs: { key: string; has_bricks: boolean };
      }>;
      const brickRows = (bricksRes.data ?? []) as ReadonlyArray<{
        id: string;
        page_block_id: string;
        brick_def_id: string;
        sort_order: number;
        variant_key: string;
        content: Record<string, unknown>;
        templates_brick_defs: { key: string };
      }>;

      return {
        ok: true,
        tree: {
          page: {
            id: pageRow.id,
            wrapper_key: pageRow.templates_wrappers?.key ?? null,
            root_meta: pageRow.content ?? {},
            wysiwyg_locked: pageRow.wysiwyg_locked,
            version: pageRow.version,
          },
          topLevel: blockRows.map((r) => ({
            id: r.id,
            block_def_id: r.block_def_id,
            block_def_key: r.templates_block_defs.key,
            parent_brick_id: r.parent_brick_id,
            sort_order: r.sort_order,
            variant_key: r.variant_key,
            has_bricks: r.templates_block_defs.has_bricks,
            content: r.content,
          })),
          bricks: brickRows.map((r) => ({
            id: r.id,
            page_block_id: r.page_block_id,
            brick_def_id: r.brick_def_id,
            brick_def_key: r.templates_brick_defs.key,
            sort_order: r.sort_order,
            variant_key: r.variant_key,
            content: r.content,
          })),
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: { code: 'page_tree_fetch_failed', message: err instanceof Error ? err.message : String(err), status: 500 },
      };
    }
  },

  /** POST /api/admin/pages/:id/canvas */
  async applyOps(pageId: string, envelope: OpEnvelope): Promise<ApplyResult> {
    const res = await fetch(`${API_URL}/api/admin/pages/${encodeURIComponent(pageId)}/canvas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': envelope.idempotencyKey,
        ...(await authHeaders()),
      },
      body: JSON.stringify(envelope),
    });
    if (!res.ok) return { ok: false, error: await parseError(res) };
    const body = await res.json() as ApplyOpsResponse;
    return { ok: true, response: body };
  },
};
