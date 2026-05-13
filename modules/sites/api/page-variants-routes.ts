/**
 * Page-variants admin endpoints — CRUD on `page_variants` (per-field
 * overlays on `pages.content` keyed by `match_context`).
 *
 * Per spec-aaif-theme-deliverable §5.2 + the data model added in
 * sites/migrations/037_site_personas_and_page_variants.sql.
 *
 *   GET    /admin/pages/:pageId/variants                — list
 *   POST   /admin/pages/:pageId/variants                — create
 *   PATCH  /admin/pages/:pageId/variants/:variantId     — update
 *   DELETE /admin/pages/:pageId/variants/:variantId     — delete
 *
 * Notes:
 *   - `match_context` arrives as a JSON object; values may be scalars
 *     (string/number/boolean) for `eq` semantics or arrays of strings
 *     for OR-of-values (§5.2.1 multi-value matching).
 *   - `value` is whatever shape the field at `field_path` expects —
 *     server doesn't validate it against the page's content schema
 *     (that would require loading the schema row + JSON Schema
 *     compiler on every write). The publish-time validator catches
 *     malformed overlays; editor UX surfaces parse errors live.
 *   - `field_path` shape is enforced (must parse via `parseFieldPath`
 *     from walk-page-variants); empty / malformed paths return 400.
 */

import type { Request, Response, Router } from 'express';
import { parseFieldPath } from '../lib/runtime/walk-page-variants.js';

interface RequestWithUser extends Request {
  user?: { id: string };
}

interface ErrorEnvelope {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

const FIELD_PATH_MAX_LEN = 500;
const VALUE_MAX_BYTES = 100_000; // 100 KB; oversized variants are rejected so a runaway editor can't pin the page row.

interface PageVariantInput {
  field_path: string;
  match_context: Record<string, unknown>;
  value: unknown;
  priority?: number;
  persona_id?: string | null;
}

function paramAs(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return undefined;
}

function validateVariantPayload(
  body: unknown,
  partial: boolean,
): { ok: true; value: PageVariantInput } | { ok: false; reason: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'request body must be an object' };
  }
  const obj = body as Record<string, unknown>;
  const out: Partial<PageVariantInput> = {};

  if ('field_path' in obj || !partial) {
    if (typeof obj.field_path !== 'string') {
      return { ok: false, reason: 'field_path required (string)' };
    }
    const fp = obj.field_path.trim();
    if (fp.length === 0 || fp.length > FIELD_PATH_MAX_LEN) {
      return { ok: false, reason: `field_path must be 1..${FIELD_PATH_MAX_LEN} chars` };
    }
    if (!parseFieldPath(fp)) {
      return { ok: false, reason: `field_path syntax invalid: ${JSON.stringify(fp)}` };
    }
    out.field_path = fp;
  }

  if ('match_context' in obj || !partial) {
    if (!obj.match_context || typeof obj.match_context !== 'object' || Array.isArray(obj.match_context)) {
      return { ok: false, reason: 'match_context must be an object' };
    }
    // Validate every axis value is a scalar or array-of-strings.
    for (const [axis, v] of Object.entries(obj.match_context as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          if (typeof item !== 'string') {
            return { ok: false, reason: `match_context.${axis} array values must be strings` };
          }
        }
        continue;
      }
      return { ok: false, reason: `match_context.${axis} must be scalar or array-of-strings` };
    }
    out.match_context = obj.match_context as Record<string, unknown>;
  }

  if ('value' in obj || !partial) {
    if (obj.value === undefined) {
      return { ok: false, reason: 'value required (any JSON)' };
    }
    // Size guard.
    let serialized: string;
    try {
      serialized = JSON.stringify(obj.value);
    } catch (err) {
      return {
        ok: false,
        reason: `value not JSON-serialisable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (serialized.length > VALUE_MAX_BYTES) {
      return { ok: false, reason: `value exceeds ${VALUE_MAX_BYTES} bytes` };
    }
    out.value = obj.value;
  }

  if ('priority' in obj) {
    if (typeof obj.priority !== 'number' || !Number.isInteger(obj.priority)) {
      return { ok: false, reason: 'priority must be an integer' };
    }
    if (obj.priority < 0 || obj.priority > 10_000) {
      return { ok: false, reason: 'priority must be 0..10000' };
    }
    out.priority = obj.priority;
  }

  if ('persona_id' in obj) {
    if (obj.persona_id === null) {
      out.persona_id = null;
    } else if (typeof obj.persona_id === 'string' && /^[0-9a-f-]{36}$/i.test(obj.persona_id)) {
      out.persona_id = obj.persona_id;
    } else {
      return { ok: false, reason: 'persona_id must be a uuid or null' };
    }
  }

  return { ok: true, value: out as PageVariantInput };
}

export interface PageVariantsRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any };
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export function createPageVariantsRoutes(deps: PageVariantsRoutesDeps) {
  const { supabase, logger } = deps;

  async function listVariants(req: RequestWithUser, res: Response): Promise<void> {
    const pageId = paramAs(req.params.pageId);
    if (!pageId) {
      res.status(400).json({ error: 'missing_page_id', message: 'page id required' } satisfies ErrorEnvelope);
      return;
    }
    const result = await supabase
      .from('page_variants')
      .select('id, page_id, field_path, match_context, value, priority, persona_id, created_at, updated_at')
      .eq('page_id', pageId)
      .order('field_path', { ascending: true })
      .order('priority', { ascending: true });

    if (result.error) {
      res.status(500).json({ error: 'internal', message: String(result.error.message ?? '') } satisfies ErrorEnvelope);
      return;
    }
    res.status(200).json({ variants: result.data ?? [] });
  }

  async function createVariant(req: RequestWithUser, res: Response): Promise<void> {
    const pageId = paramAs(req.params.pageId);
    if (!pageId) {
      res.status(400).json({ error: 'missing_page_id', message: 'page id required' } satisfies ErrorEnvelope);
      return;
    }
    const validated = validateVariantPayload(req.body, /* partial */ false);
    if (!validated.ok) {
      res.status(400).json({ error: 'invalid_input', message: validated.reason } satisfies ErrorEnvelope);
      return;
    }
    const v = validated.value;
    const result = await supabase
      .from('page_variants')
      .insert({
        page_id: pageId,
        field_path: v.field_path,
        match_context: v.match_context,
        value: v.value,
        priority: v.priority ?? 100,
        persona_id: v.persona_id ?? null,
        created_by: req.user?.id ?? null,
      })
      .select('id, page_id, field_path, match_context, value, priority, persona_id, created_at, updated_at')
      .single();

    if (result.error) {
      const msg = String(result.error.message ?? '');
      // Duplicate (page_id, field_path, match_context) — surfaces as a
      // unique violation. Tell the editor they already have a variant
      // for this combination.
      if (msg.includes('unique') || msg.includes('UNIQUE') || msg.includes('duplicate key')) {
        res.status(409).json({
          error: 'duplicate_variant',
          message: 'a variant for this field + match_context already exists; update it instead',
        } satisfies ErrorEnvelope);
        return;
      }
      logger.warn('createVariant.db_error', { pageId, error: msg });
      res.status(500).json({ error: 'internal', message: msg } satisfies ErrorEnvelope);
      return;
    }
    res.status(201).json(result.data);
  }

  async function updateVariant(req: RequestWithUser, res: Response): Promise<void> {
    const pageId = paramAs(req.params.pageId);
    const variantId = paramAs(req.params.variantId);
    if (!pageId || !variantId) {
      res.status(400).json({ error: 'missing_params', message: 'page id and variant id required' } satisfies ErrorEnvelope);
      return;
    }
    const validated = validateVariantPayload(req.body, /* partial */ true);
    if (!validated.ok) {
      res.status(400).json({ error: 'invalid_input', message: validated.reason } satisfies ErrorEnvelope);
      return;
    }
    const v = validated.value;
    const patch: Record<string, unknown> = {};
    if (v.field_path !== undefined) patch.field_path = v.field_path;
    if (v.match_context !== undefined) patch.match_context = v.match_context;
    if (v.value !== undefined) patch.value = v.value;
    if (v.priority !== undefined) patch.priority = v.priority;
    if (v.persona_id !== undefined) patch.persona_id = v.persona_id;
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'empty_patch', message: 'no fields to update' } satisfies ErrorEnvelope);
      return;
    }

    const result = await supabase
      .from('page_variants')
      .update(patch)
      .eq('page_id', pageId)
      .eq('id', variantId)
      .select('id, page_id, field_path, match_context, value, priority, persona_id, created_at, updated_at')
      .maybeSingle();

    if (result.error) {
      const msg = String(result.error.message ?? '');
      if (msg.includes('unique') || msg.includes('UNIQUE') || msg.includes('duplicate key')) {
        res.status(409).json({
          error: 'duplicate_variant',
          message: 'another variant already targets this field + match_context',
        } satisfies ErrorEnvelope);
        return;
      }
      res.status(500).json({ error: 'internal', message: msg } satisfies ErrorEnvelope);
      return;
    }
    if (!result.data) {
      res.status(404).json({ error: 'not_found', message: 'variant not found' } satisfies ErrorEnvelope);
      return;
    }
    res.status(200).json(result.data);
  }

  async function deleteVariant(req: RequestWithUser, res: Response): Promise<void> {
    const pageId = paramAs(req.params.pageId);
    const variantId = paramAs(req.params.variantId);
    if (!pageId || !variantId) {
      res.status(400).json({ error: 'missing_params', message: 'page id and variant id required' } satisfies ErrorEnvelope);
      return;
    }
    const result = await supabase
      .from('page_variants')
      .delete()
      .eq('page_id', pageId)
      .eq('id', variantId)
      .select('id')
      .maybeSingle();

    if (result.error) {
      res.status(500).json({ error: 'internal', message: String(result.error.message ?? '') } satisfies ErrorEnvelope);
      return;
    }
    if (!result.data) {
      res.status(404).json({ error: 'not_found', message: 'variant not found' } satisfies ErrorEnvelope);
      return;
    }
    res.status(204).end();
  }

  return { listVariants, createVariant, updateVariant, deleteVariant };
}

export function mountPageVariantsRoutes(router: Router, routes: ReturnType<typeof createPageVariantsRoutes>): void {
  router.get('/pages/:pageId/variants', routes.listVariants);
  router.post('/pages/:pageId/variants', routes.createVariant);
  router.patch('/pages/:pageId/variants/:variantId', routes.updateVariant);
  router.delete('/pages/:pageId/variants/:variantId', routes.deleteVariant);
}
