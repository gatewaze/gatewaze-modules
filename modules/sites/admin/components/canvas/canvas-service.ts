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
  /** Brick keys when has_bricks=true. */
  brick_slots: ReadonlyArray<{ key: string; label: string }>;
}

export type ListBlockDefsResult =
  | { ok: true; blockDefs: ReadonlyArray<BlockDefSummary> }
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
        .select('id, key, name, description, thumbnail_url, has_bricks, schema')
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
