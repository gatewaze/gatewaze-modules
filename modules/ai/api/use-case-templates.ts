// @ts-nocheck — depends on express + supabase resolved at host install.

/**
 * spec-ai-mcp-extensions.md §API — use-case templates CRUD.
 *
 *   GET    /admin/use-case-templates
 *   POST   /admin/use-case-templates              (operator-defined; reserved names blocked by DB trigger)
 *   GET    /admin/use-case-templates/:id
 *   PATCH  /admin/use-case-templates/:id          (409 if is_builtin)
 *   DELETE /admin/use-case-templates/:id          (409 if is_builtin OR in-use)
 */

import type { Router, Request, Response } from 'express';

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

interface MountDeps { supabase: SupabaseLike }

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const WRITE_FIELDS = new Set([
  'display_name', 'description',
  'suggested_provider', 'suggested_model',
  'suggested_allowed_web_tools', 'suggested_allowed_mcp_server_names',
  'goose_runtime_overrides',
  'hint_recipe_file_pattern', 'hint_skill_dir_pattern',
]);

function pickFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (WRITE_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

function sendError(res: Response, status: number, code: string, message: string, details?: unknown): void {
  res.status(status).json({ error: { code, message, ...(details !== undefined && { details }) } });
}

export function mountUseCaseTemplateRoutes(router: Router, deps: MountDeps): void {
  router.get('/admin/use-case-templates', async (_req: Request, res: Response): Promise<void> => {
    const result = await deps.supabase
      .from('ai_use_case_templates')
      .select('*')
      .order('is_builtin', { ascending: false })
      .order('name', { ascending: true });
    if (result.error) return sendError(res, 500, 'internal_error', result.error.message);
    res.status(200).json({ templates: result.data ?? [] });
  });

  router.get('/admin/use-case-templates/:id', async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'bad_request', 'id required');
    const result = await deps.supabase
      .from('ai_use_case_templates')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (result.error) return sendError(res, 500, 'internal_error', result.error.message);
    if (!result.data) return sendError(res, 404, 'not_found', 'template not found');
    res.status(200).json(result.data);
  });

  router.post('/admin/use-case-templates', async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = body.name;
    const display_name = body.display_name;
    const description = body.description;
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      return sendError(res, 400, 'validation_error', 'name must match ^[a-z][a-z0-9]*(-[a-z0-9]+)*$');
    }
    if (typeof display_name !== 'string' || display_name.length === 0) {
      return sendError(res, 400, 'validation_error', 'display_name required');
    }
    if (typeof description !== 'string' || description.length === 0) {
      return sendError(res, 400, 'validation_error', 'description required');
    }
    const row = {
      name,
      display_name,
      description,
      is_builtin: false,
      ...pickFields(body),
    };
    const result = await deps.supabase
      .from('ai_use_case_templates')
      .insert(row)
      .select('*')
      .maybeSingle();
    if (result.error) {
      const msg = String(result.error.message ?? '');
      if (msg.includes('reserved for built-in')) {
        return sendError(res, 409, 'reserved_name', msg);
      }
      if (msg.includes('duplicate key') || msg.includes('templates_name_key')) {
        return sendError(res, 409, 'name_conflict', `name '${name}' already exists`);
      }
      return sendError(res, 500, 'internal_error', msg);
    }
    res.status(201).json(result.data);
  });

  router.patch('/admin/use-case-templates/:id', async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'bad_request', 'id required');
    const existing = await deps.supabase
      .from('ai_use_case_templates')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (existing.error) return sendError(res, 500, 'internal_error', existing.error.message);
    if (!existing.data) return sendError(res, 404, 'not_found', 'template not found');
    if (existing.data.is_builtin) {
      return sendError(res, 409, 'immutable_field', 'built-in templates are immutable');
    }
    const update = pickFields(req.body);
    if (Object.keys(update).length === 0) {
      return sendError(res, 400, 'bad_request', 'no updatable fields supplied');
    }
    const result = await deps.supabase
      .from('ai_use_case_templates')
      .update(update)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (result.error) return sendError(res, 500, 'internal_error', result.error.message);
    res.status(200).json(result.data);
  });

  router.delete('/admin/use-case-templates/:id', async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!id) return sendError(res, 400, 'bad_request', 'id required');
    const existing = await deps.supabase
      .from('ai_use_case_templates')
      .select('is_builtin')
      .eq('id', id)
      .maybeSingle();
    if (existing.error) return sendError(res, 500, 'internal_error', existing.error.message);
    if (!existing.data) return sendError(res, 404, 'not_found', 'template not found');
    if (existing.data.is_builtin) {
      return sendError(res, 409, 'immutable_field', 'built-in templates cannot be deleted');
    }
    const refs = await deps.supabase
      .from('ai_use_cases')
      .select('id', { count: 'exact', head: true })
      .eq('template_id', id);
    if (refs.error) return sendError(res, 500, 'internal_error', refs.error.message);
    if ((refs.count ?? 0) > 0) {
      return sendError(res, 409, 'in_use', `${refs.count} use case(s) still reference this template`);
    }
    const result = await deps.supabase
      .from('ai_use_case_templates')
      .delete()
      .eq('id', id);
    if (result.error) return sendError(res, 500, 'internal_error', result.error.message);
    res.status(204).send();
  });
}
