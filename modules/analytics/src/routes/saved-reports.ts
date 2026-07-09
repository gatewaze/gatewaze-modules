/**
 * Saved report definitions — CRUD for the admin dashboard's saved
 * funnels (journeys/utm reuse the same table later).
 *
 * Definitions only; results are computed on demand via the reports
 * routes for whatever range the viewer selects.
 */

import type { Request, Response, Router } from 'express';

export interface SavedReportsSupabaseClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export interface SavedReportsRoutesDeps {
  supabase: SavedReportsSupabaseClient;
  logger: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  getUserId: (req: Request) => string | null;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;
const VALID_TYPES = new Set(['funnel', 'journey', 'utm']);

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/** Funnel definitions get shape-checked so the dashboard never renders
 *  garbage; other types pass through as opaque jsonb. */
function validateDefinition(type: string, def: unknown): string | null {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return 'definition must be an object';
  if (type === 'funnel') {
    const d = def as { steps?: unknown; window?: unknown };
    if (!Array.isArray(d.steps) || d.steps.length < 2 || d.steps.length > 8) return 'funnel needs 2-8 steps';
    for (const st of d.steps) {
      const s = st as { type?: unknown; value?: unknown };
      if ((s.type !== 'path' && s.type !== 'event') || typeof s.value !== 'string' || !s.value) {
        return 'each step needs type path|event and a non-empty value';
      }
    }
    if (d.window !== undefined && (typeof d.window !== 'number' || d.window < 1 || d.window > 24 * 60)) {
      return 'window must be 1..1440 minutes';
    }
  }
  return null;
}

export function createSavedReportsRoutes(deps: SavedReportsRoutesDeps) {
  async function list(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');
    const type = typeof req.query['type'] === 'string' ? (req.query['type'] as string) : undefined;

    let q = deps.supabase
      .from('analytics_saved_reports')
      .select('id, type, name, definition, created_at, updated_at')
      .eq('property_id', id)
      .order('created_at', { ascending: true });
    if (type && VALID_TYPES.has(type)) q = q.eq('type', type);
    const { data, error } = await q;
    if (error) {
      deps.logger.error('analytics.saved_reports.list_failed', { error: error.message });
      return sendError(res, 500, 'internal', 'failed to list saved reports');
    }
    res.json({ reports: data ?? [] });
  }

  async function create(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid');

    const body = req.body as { type?: unknown; name?: unknown; definition?: unknown } | undefined;
    const type = typeof body?.type === 'string' ? body.type : '';
    if (!VALID_TYPES.has(type)) return sendError(res, 400, 'validation_failed', `type must be one of ${[...VALID_TYPES].join(', ')}`);
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : '';
    if (!name) return sendError(res, 400, 'validation_failed', 'name required');
    const defError = validateDefinition(type, body?.definition);
    if (defError) return sendError(res, 400, 'validation_failed', defError);

    const { data, error } = await deps.supabase
      .from('analytics_saved_reports')
      .insert({ property_id: id, type, name, definition: body!.definition, created_by: userId })
      .select('id, type, name, definition, created_at, updated_at')
      .single();
    if (error) {
      deps.logger.error('analytics.saved_reports.create_failed', { error: error.message });
      return sendError(res, 500, 'internal', 'failed to save report');
    }
    res.status(201).json({ report: data });
  }

  async function remove(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    const reportId = req.params['reportId'];
    if (!id || !UUID_RE.test(id) || !reportId || !UUID_RE.test(reportId)) {
      return sendError(res, 400, 'validation_failed', 'ids must be uuids');
    }
    const { error } = await deps.supabase
      .from('analytics_saved_reports')
      .delete()
      .eq('id', reportId)
      .eq('property_id', id);
    if (error) {
      deps.logger.error('analytics.saved_reports.delete_failed', { error: error.message });
      return sendError(res, 500, 'internal', 'failed to delete saved report');
    }
    res.status(204).send();
  }

  return { list, create, remove };
}

export function mountSavedReportsRoutes(router: Router, routes: ReturnType<typeof createSavedReportsRoutes>): void {
  router.get('/properties/:id/saved-reports', routes.list);
  router.post('/properties/:id/saved-reports', routes.create);
  router.delete('/properties/:id/saved-reports/:reportId', routes.remove);
}
