/**
 * Canvas presets API. Per spec-sites-wysiwyg-builder §6.6.
 *
 *   POST   /api/admin/sites/:siteSlug/canvas-presets
 *   GET    /api/admin/sites/:siteSlug/canvas-presets
 *   DELETE /api/admin/sites/:siteSlug/canvas-presets/:id
 *
 * Save snapshots a single page_blocks row + its page_block_bricks (and
 * their content) into page_block_presets.payload. Apply runs through the
 * existing `preset.apply` op (canvas_apply_ops.sql).
 *
 * Schema validation runs at save time AND apply time — drift between
 * save and apply surfaces as canvas.preset_validation when applying.
 */

import type { Request, Response, Router } from 'express';
import { validateContent } from './schema-validate.js';

interface RequestWithUser extends Request {
  userId?: string;
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

export interface PresetsRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any };
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

interface BlockRow {
  id: string;
  page_id: string;
  block_def_id: string;
  content: Record<string, unknown>;
  variant_key: string;
}

interface BrickRow {
  id: string;
  page_block_id: string;
  brick_def_id: string;
  content: Record<string, unknown>;
  sort_order: number;
}

interface BlockDefRow {
  id: string;
  key: string;
  schema: Record<string, unknown>;
  library_id: string;
}

interface BrickDefRow {
  id: string;
  key: string;
  schema: Record<string, unknown>;
}

interface PageRow {
  id: string;
  site_id: string;
}

interface SiteRow {
  id: string;
  slug: string;
  templates_library_id: string | null;
}

interface PresetRow {
  id: string;
  name: string;
  description: string | null;
  preview_image: string | null;
  payload: { block_def_key: string; bricks: Array<{ brick_def_key: string }> };
  created_at: string;
}

export interface SavePresetBody {
  name: string;
  description?: string;
  fromBlockId: string;
}

export interface PresetSummary {
  id: string;
  name: string;
  description: string | null;
  preview_image: string | null;
  /** The block_def_key — useful for grouping in the palette. */
  block_def_key: string;
  /** True when the block_def referenced by this preset is currently
   *  available + canvas_validated in the site's library. */
  applicable: boolean;
  created_at: string;
}

export function createPresetsRoutes(deps: PresetsRoutesDeps) {
  /**
   * POST /admin/sites/:siteSlug/canvas-presets
   * Body: { name, description?, fromBlockId }
   */
  async function savePreset(req: RequestWithUser, res: Response): Promise<void> {
    const userId = req.userId;
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const siteSlug = paramAs(req.params.siteSlug);
    if (!siteSlug) return sendError(res, 400, 'invalid_input', 'siteSlug required');

    const body = req.body as Partial<SavePresetBody>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const description = typeof body.description === 'string' ? body.description : null;
    const fromBlockId = typeof body.fromBlockId === 'string' ? body.fromBlockId : '';

    if (!name || name.length > 80) {
      return sendError(res, 400, 'invalid_input', 'name must be 1..80 chars');
    }
    if (!fromBlockId) {
      return sendError(res, 400, 'invalid_input', 'fromBlockId required');
    }

    // Resolve site → library_id.
    const siteRes = await deps.supabase
      .from('sites')
      .select('id, slug, templates_library_id')
      .eq('slug', siteSlug)
      .maybeSingle();
    const site = (siteRes as { data: SiteRow | null }).data;
    if (!site) return sendError(res, 404, 'not_found', `site '${siteSlug}' not found`);
    if (!site.templates_library_id) return sendError(res, 409, 'canvas.no_library', 'site has no templates library');

    // Resolve the source block + its def.
    const blockRes = await deps.supabase
      .from('page_blocks')
      .select('id, page_id, block_def_id, content, variant_key')
      .eq('id', fromBlockId)
      .maybeSingle();
    const block = (blockRes as { data: BlockRow | null }).data;
    if (!block) return sendError(res, 404, 'not_found', `block ${fromBlockId} not found`);

    // pages uses host_kind/host_id; the equivalent of "site_id" is host_id
    // for host_kind='site' rows. Re-shape into a PageRow for downstream use.
    const pageRes = await deps.supabase
      .from('pages')
      .select('id, host_id, host_kind')
      .eq('id', block.page_id)
      .eq('host_kind', 'site')
      .maybeSingle();
    const pageRaw = (pageRes as { data: { id: string; host_id: string; host_kind: string } | null }).data;
    const page = pageRaw ? ({ id: pageRaw.id, site_id: pageRaw.host_id } as PageRow) : null;
    if (!page || page.site_id !== site.id) {
      return sendError(res, 403, 'forbidden', 'block does not belong to this site');
    }

    const defRes = await deps.supabase
      .from('templates_block_defs')
      .select('id, key, schema, library_id')
      .eq('id', block.block_def_id)
      .maybeSingle();
    const def = (defRes as { data: BlockDefRow | null }).data;
    if (!def) return sendError(res, 500, 'internal', 'block_def missing');

    if (def.library_id !== site.templates_library_id) {
      return sendError(res, 403, 'forbidden', 'block_def does not belong to this site\'s library');
    }

    // Validate content against block_def schema.
    const v = validateContent(block.content, def.schema);
    if (!v.ok) {
      return sendError(res, 400, 'canvas.preset_validation', 'block content does not match block_def schema', { issues: v.issues });
    }

    // Resolve bricks.
    const brickRes = await deps.supabase
      .from('page_block_bricks')
      .select('id, page_block_id, brick_def_id, content, sort_order')
      .eq('page_block_id', block.id)
      .order('sort_order', { ascending: true });
    const bricks = (((brickRes as { data: BrickRow[] | null }).data) ?? []);

    let brickDefs: BrickDefRow[] = [];
    if (bricks.length > 0) {
      const brickDefIds = Array.from(new Set(bricks.map((b) => b.brick_def_id)));
      const brickDefRes = await deps.supabase
        .from('templates_brick_defs')
        .select('id, key, schema')
        .in('id', brickDefIds);
      brickDefs = (((brickDefRes as { data: BrickDefRow[] | null }).data) ?? []);
    }
    const brickDefById = new Map(brickDefs.map((d) => [d.id, d]));

    // Validate brick contents.
    for (const brick of bricks) {
      const brickDef = brickDefById.get(brick.brick_def_id);
      if (!brickDef) {
        return sendError(res, 500, 'internal', `brick_def ${brick.brick_def_id} missing`);
      }
      const bv = validateContent(brick.content, brickDef.schema);
      if (!bv.ok) {
        return sendError(res, 400, 'canvas.preset_validation', `brick '${brickDef.key}' content does not match brick_def schema`, { issues: bv.issues });
      }
    }

    // Build the payload.
    const payload = {
      block_def_key: def.key,
      content: block.content,
      bricks: bricks.map((brick) => {
        const brickDef = brickDefById.get(brick.brick_def_id);
        return {
          brick_def_key: brickDef?.key ?? '',
          content: brick.content,
        };
      }),
    };

    const insertRes = await deps.supabase
      .from('page_block_presets')
      .insert({
        site_id: site.id,
        name,
        description,
        payload,
        created_by: userId,
      })
      .select('id, name, description, preview_image, payload, created_at')
      .maybeSingle();
    const inserted = (insertRes as { data: PresetRow | null; error: { message: string } | null }).data;
    const insertErr = (insertRes as { error: { message: string } | null }).error;
    if (insertErr) {
      // Likely a UNIQUE (site_id, name) collision.
      if (insertErr.message.toLowerCase().includes('duplicate')) {
        return sendError(res, 409, 'canvas.preset_duplicate', `a preset named '${name}' already exists for this site`);
      }
      return sendError(res, 500, 'internal', insertErr.message);
    }
    if (!inserted) return sendError(res, 500, 'internal', 'preset insert returned no row');

    deps.logger.info('canvas.preset.saved', { siteSlug, name, blockDefKey: def.key });
    res.status(201).json({
      id: inserted.id,
      name: inserted.name,
      description: inserted.description,
      preview_image: inserted.preview_image,
      block_def_key: def.key,
      applicable: true,
      created_at: inserted.created_at,
    } satisfies PresetSummary);
  }

  /**
   * GET /admin/sites/:siteSlug/canvas-presets
   * Lists presets for the palette. Computes `applicable` by checking the
   * referenced block_def is still in the library + canvas_validated.
   */
  async function listPresets(req: RequestWithUser, res: Response): Promise<void> {
    const userId = req.userId;
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const siteSlug = paramAs(req.params.siteSlug);
    if (!siteSlug) return sendError(res, 400, 'invalid_input', 'siteSlug required');

    const siteRes = await deps.supabase
      .from('sites')
      .select('id, templates_library_id')
      .eq('slug', siteSlug)
      .maybeSingle();
    const site = (siteRes as { data: { id: string; templates_library_id: string | null } | null }).data;
    if (!site) return sendError(res, 404, 'not_found', `site '${siteSlug}' not found`);

    const presetsRes = await deps.supabase
      .from('page_block_presets')
      .select('id, name, description, preview_image, payload, created_at')
      .eq('site_id', site.id)
      .order('name', { ascending: true });
    const presets = (((presetsRes as { data: PresetRow[] | null }).data) ?? []);

    // Determine applicability — the block_def_key referenced must still
    // exist in the library + be canvas_validated.
    const validKeys = new Set<string>();
    if (site.templates_library_id && presets.length > 0) {
      const refKeys = Array.from(new Set(presets.map((p) => p.payload.block_def_key)));
      const defsRes = await deps.supabase
        .from('templates_block_defs')
        .select('key')
        .eq('library_id', site.templates_library_id)
        .eq('is_current', true)
        .eq('canvas_validated', true)
        .in('key', refKeys);
      for (const r of (((defsRes as { data: Array<{ key: string }> | null }).data) ?? [])) {
        validKeys.add(r.key);
      }
    }

    const out: PresetSummary[] = presets.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      preview_image: p.preview_image,
      block_def_key: p.payload.block_def_key,
      applicable: validKeys.has(p.payload.block_def_key),
      created_at: p.created_at,
    }));
    res.status(200).json(out);
  }

  /**
   * DELETE /admin/sites/:siteSlug/canvas-presets/:id
   */
  async function deletePreset(req: RequestWithUser, res: Response): Promise<void> {
    const userId = req.userId;
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const siteSlug = paramAs(req.params.siteSlug);
    const presetId = paramAs(req.params.id);
    if (!siteSlug || !presetId) return sendError(res, 400, 'invalid_input', 'siteSlug + id required');

    const siteRes = await deps.supabase
      .from('sites')
      .select('id')
      .eq('slug', siteSlug)
      .maybeSingle();
    const site = (siteRes as { data: { id: string } | null }).data;
    if (!site) return sendError(res, 404, 'not_found', 'site not found');

    await deps.supabase
      .from('page_block_presets')
      .delete()
      .eq('id', presetId)
      .eq('site_id', site.id);

    res.status(204).end();
  }

  return { savePreset, listPresets, deletePreset };
}

export function mountPresetsRoutes(router: Router, routes: ReturnType<typeof createPresetsRoutes>): void {
  router.post('/sites/:siteSlug/canvas-presets', routes.savePreset);
  router.get('/sites/:siteSlug/canvas-presets', routes.listPresets);
  router.delete('/sites/:siteSlug/canvas-presets/:id', routes.deletePreset);
}
