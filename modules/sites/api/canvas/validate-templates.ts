/**
 * Bulk canvas-template validator endpoint.
 *
 * POST /api/admin/sites/:siteSlug/canvas-validate-templates
 *   Runs the canvas-template validator against every block_def in the
 *   site's bound library and writes back canvas_validated +
 *   canvas_validation_errors. Returns a summary so the SiteSourceTab can
 *   surface "12 of 14 templates valid; 2 errors".
 *
 * Per spec-sites-wysiwyg-builder §4.5 + §1.D.
 */

import type { Request, Response, Router } from 'express';
import { validateCanvasTemplate } from '../../lib/canvas-validate-template/index.js';

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

export interface ValidateTemplatesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any };
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

interface BlockDefRow {
  id: string;
  key: string;
  html: string;
  schema: Record<string, unknown>;
  has_bricks: boolean;
}

interface BrickDefRow {
  block_def_id: string;
  key: string;
}

export interface ValidateTemplatesSummary {
  totalBlockDefs: number;
  valid: number;
  invalid: number;
  perBlockDef: ReadonlyArray<{
    id: string;
    key: string;
    valid: boolean;
    errorCount: number;
  }>;
}

export function createValidateTemplatesRoute(deps: ValidateTemplatesDeps) {
  return async function validateTemplates(req: RequestWithUser, res: Response): Promise<void> {
    const userId = req.userId;
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const siteSlug = paramAs(req.params.siteSlug);
    if (!siteSlug) return sendError(res, 400, 'invalid_input', 'siteSlug required');

    // Resolve site → library_id.
    const siteRes = await deps.supabase
      .from('sites')
      .select('id, templates_library_id')
      .eq('slug', siteSlug)
      .maybeSingle();
    const site = (siteRes as { data: { id: string; templates_library_id: string | null } | null }).data;
    if (!site) return sendError(res, 404, 'not_found', `site '${siteSlug}' not found`);
    if (!site.templates_library_id) {
      return sendError(res, 409, 'canvas.no_library', 'site has no templates_library_id');
    }

    // Load all current block_defs in the library.
    const defsRes = await deps.supabase
      .from('templates_block_defs')
      .select('id, key, html, schema, has_bricks')
      .eq('library_id', site.templates_library_id)
      .eq('is_current', true);
    const blockDefs = ((defsRes as { data: BlockDefRow[] | null }).data ?? []);

    // Bulk-fetch brick keys for all has_bricks defs.
    const containerIds = blockDefs.filter((d) => d.has_bricks).map((d) => d.id);
    const bricksByBlock = new Map<string, string[]>();
    if (containerIds.length > 0) {
      const brickRes = await deps.supabase
        .from('templates_brick_defs')
        .select('block_def_id, key')
        .in('block_def_id', containerIds);
      for (const r of ((brickRes as { data: BrickDefRow[] | null }).data ?? [])) {
        const arr = bricksByBlock.get(r.block_def_id) ?? [];
        arr.push(r.key);
        bricksByBlock.set(r.block_def_id, arr);
      }
    }

    // Validate each + write back.
    const perBlockDef: ValidateTemplatesSummary['perBlockDef'][number][] = [];
    let valid = 0;
    let invalid = 0;
    for (const def of blockDefs) {
      const result = validateCanvasTemplate({
        html: def.html,
        schema: def.schema,
        brickDefKeys: bricksByBlock.get(def.id) ?? [],
      });
      const isValid = result.valid;
      const errorCount = isValid ? 0 : result.errors.length;
      if (isValid) valid++; else invalid++;

      await deps.supabase
        .from('templates_block_defs')
        .update({
          canvas_validated: isValid,
          canvas_validation_errors: isValid ? null : result.errors.map((e) => ({
            code: e.code,
            message: e.message,
            ...(e.detail !== undefined ? { detail: e.detail } : {}),
            ...(e.pos !== undefined ? { pos: e.pos } : {}),
          })),
        })
        .eq('id', def.id);

      perBlockDef.push({ id: def.id, key: def.key, valid: isValid, errorCount });
    }

    const summary: ValidateTemplatesSummary = {
      totalBlockDefs: blockDefs.length,
      valid,
      invalid,
      perBlockDef,
    };

    deps.logger.info('canvas.validate-templates.complete', {
      siteSlug, libraryId: site.templates_library_id,
      totalBlockDefs: summary.totalBlockDefs, valid, invalid,
    });

    res.status(200).json(summary);
  };
}

export function mountValidateTemplatesRoute(router: Router, handler: ReturnType<typeof createValidateTemplatesRoute>): void {
  router.post('/sites/:siteSlug/canvas-validate-templates', handler);
}
