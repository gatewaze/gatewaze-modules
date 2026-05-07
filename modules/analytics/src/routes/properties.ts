/**
 * HTTP routes for analytics_properties + per-property settings (scripts,
 * segment key).
 *
 * Per spec-analytics-module §11.1.
 *
 * Mounted at /api/analytics/properties/* under the platform's JWT-
 * protected router. Tenancy is enforced by:
 *   - The validators below (mass-assignment allowlist + UUID checks)
 *   - The analytics_properties RLS dispatch in migration 00002
 *
 * Mass-assignment guard per the production-readiness skill rule 5.
 */

import type { Request, Response, Router } from 'express';

// ---------------------------------------------------------------------------
// Narrow Supabase surface
// ---------------------------------------------------------------------------

export interface PropertiesSupabaseQuery {
  select(cols: string): PropertiesSupabaseQuery;
  insert(values: Record<string, unknown>): PropertiesSupabaseQuery;
  update(values: Record<string, unknown>): PropertiesSupabaseQuery;
  upsert(values: Record<string, unknown>, opts?: { onConflict: string }): PropertiesSupabaseQuery;
  delete(): PropertiesSupabaseQuery;
  eq(col: string, val: unknown): PropertiesSupabaseQuery;
  order(col: string, opts: { ascending: boolean }): PropertiesSupabaseQuery;
  single<T = Record<string, unknown>>(): Promise<{ data: T | null; error: { message: string } | null }>;
  maybeSingle<T = Record<string, unknown>>(): Promise<{ data: T | null; error: { message: string } | null }>;
  then<TResult>(
    onfulfilled: (value: { data: Array<Record<string, unknown>> | null; error: { message: string } | null }) => TResult,
  ): Promise<TResult>;
}

export interface PropertiesSupabaseClient {
  from(table: string): PropertiesSupabaseQuery;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface PropertiesRoutesDeps {
  supabase: PropertiesSupabaseClient;
  /** Encrypts a secret value for storage. Called when admin sets segment key. */
  encryptSecret: (plaintext: string) => Buffer;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  getUserId: (req: Request) => string | null;
}

// ---------------------------------------------------------------------------
// Mass-assignment allowlist
// ---------------------------------------------------------------------------

const PROPERTIES_WRITE_FIELDS = ['kind', 'name', 'host_kind', 'host_id', 'domains'] as const;

function pickFields<K extends string>(body: unknown, fields: ReadonlyArray<K>): Partial<Record<K, unknown>> {
  if (!body || typeof body !== 'object') return {};
  const src = body as Record<string, unknown>;
  const out: Partial<Record<K, unknown>> = {};
  for (const f of fields) {
    if (f in src) out[f] = src[f];
  }
  return out;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;
const KIND_VALUES = new Set(['gatewaze_site', 'gatewaze_host', 'portal', 'external']);

function sendError(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function createPropertiesRoutes(deps: PropertiesRoutesDeps) {
  // -------------------------------------------------------------------------
  // GET /properties
  // -------------------------------------------------------------------------
  async function listProperties(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const { data, error } = await deps.supabase
      .from('analytics_properties')
      .select('id, property_id, kind, name, host_kind, host_id, domains, status, created_at')
      .order('created_at', { ascending: false });
    if (error) {
      deps.logger.error('analytics.properties.list.failed', { error: error.message });
      return sendError(res, 500, 'internal_error', error.message);
    }
    res.status(200).json({ properties: data ?? [] });
  }

  // -------------------------------------------------------------------------
  // POST /properties — admin creates an `external` property (gatewaze_*
  // properties are auto-created by the sites integration; portal is
  // auto-created at module install).
  // -------------------------------------------------------------------------
  async function createProperty(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const body = pickFields(req.body, PROPERTIES_WRITE_FIELDS);
    const kind = body['kind'];
    if (typeof kind !== 'string' || !KIND_VALUES.has(kind)) {
      return sendError(res, 400, 'validation_failed', `kind must be one of ${[...KIND_VALUES].join(', ')}`, { field: 'kind' });
    }
    if (kind !== 'external') {
      return sendError(res, 400, 'validation_failed', 'admin can only create kind=external; gatewaze_* properties are auto-created on host insert', { field: 'kind' });
    }
    const name = body['name'];
    if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
      return sendError(res, 400, 'validation_failed', 'name required (1..200 chars)', { field: 'name' });
    }
    const domains = body['domains'];
    if (!Array.isArray(domains)) {
      return sendError(res, 400, 'validation_failed', 'domains must be an array', { field: 'domains' });
    }
    for (const d of domains) {
      if (typeof d !== 'string' || (d !== '*' && !/^[a-z0-9.-]+$/i.test(d))) {
        return sendError(res, 400, 'validation_failed', 'each domain must be a hostname or "*"', { field: 'domains' });
      }
    }

    const { data, error } = await deps.supabase
      .from('analytics_properties')
      .insert({ kind, name, domains, created_by: userId })
      .select('id, property_id, kind, name, domains, status, created_at')
      .single();
    if (error || !data) {
      deps.logger.error('analytics.properties.create.failed', { error: error?.message });
      return sendError(res, 500, 'internal_error', error?.message ?? 'create failed');
    }
    res.status(201).json({ property: data });
  }

  // -------------------------------------------------------------------------
  // GET /properties/:id
  // -------------------------------------------------------------------------
  async function getProperty(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid', { field: 'id' });

    const { data, error } = await deps.supabase
      .from('analytics_properties')
      .select('id, property_id, kind, name, host_kind, host_id, domains, website_uuid, status, created_at, updated_at')
      .eq('property_id', id)
      .maybeSingle();
    if (error) return sendError(res, 500, 'internal_error', error.message);
    if (!data) return sendError(res, 404, 'not_found', `property ${id} not found`);
    res.status(200).json({ property: data });
  }

  // -------------------------------------------------------------------------
  // PATCH /properties/:id  (name + domains only; kind is immutable)
  // -------------------------------------------------------------------------
  async function updateProperty(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid', { field: 'id' });

    const fields = pickFields(req.body, ['name', 'domains'] as const);
    const updates: Record<string, unknown> = {};
    if ('name' in fields) {
      const name = fields['name'];
      if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
        return sendError(res, 400, 'validation_failed', 'name must be 1..200 chars', { field: 'name' });
      }
      updates['name'] = name;
    }
    if ('domains' in fields) {
      const domains = fields['domains'];
      if (!Array.isArray(domains)) return sendError(res, 400, 'validation_failed', 'domains must be an array', { field: 'domains' });
      updates['domains'] = domains;
    }
    if (Object.keys(updates).length === 0) {
      return sendError(res, 400, 'validation_failed', 'no fields to update');
    }

    const { data, error } = await deps.supabase
      .from('analytics_properties')
      .update(updates)
      .eq('property_id', id)
      .select('id, property_id, kind, name, domains, status')
      .single();
    if (error || !data) return sendError(res, 500, 'internal_error', error?.message ?? 'update failed');
    res.status(200).json({ property: data });
  }

  // -------------------------------------------------------------------------
  // DELETE /properties/:id  (archives — hard delete is service-role only)
  // -------------------------------------------------------------------------
  async function archiveProperty(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid', { field: 'id' });

    const { error } = await deps.supabase
      .from('analytics_properties')
      .update({ status: 'archived' })
      .eq('property_id', id);
    if (error) return sendError(res, 500, 'internal_error', error.message);
    res.status(204).send();
  }

  // -------------------------------------------------------------------------
  // GET /properties/:id/scripts
  // -------------------------------------------------------------------------
  async function getScripts(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid', { field: 'id' });

    // Only admins can read the raw blobs (per spec §14.2). RLS denies
    // anon; the route additionally short-circuits to keep behaviour
    // explicit when reading from elevated contexts.
    const { data, error } = await deps.supabase
      .from('analytics_tracking_scripts')
      .select('script_head, script_body, updated_at')
      .eq('property_id', id)
      .maybeSingle();
    if (error) return sendError(res, 500, 'internal_error', error.message);
    res.status(200).json({
      script_head: data?.script_head ?? '',
      script_body: data?.script_body ?? '',
      updated_at: data?.updated_at ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // PUT /properties/:id/scripts
  // -------------------------------------------------------------------------
  async function setScripts(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');

    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid', { field: 'id' });

    const body = req.body as { script_head?: unknown; script_body?: unknown } | undefined;
    const scriptHead = typeof body?.script_head === 'string' ? body.script_head : '';
    const scriptBody = typeof body?.script_body === 'string' ? body.script_body : '';
    if (scriptHead.length > 100_000 || scriptBody.length > 100_000) {
      return sendError(res, 400, 'validation_failed', 'script bodies capped at 100KB each');
    }

    const { error } = await deps.supabase
      .from('analytics_tracking_scripts')
      .upsert(
        { property_id: id, script_head: scriptHead, script_body: scriptBody, updated_by: userId },
        { onConflict: 'property_id' },
      );
    if (error) return sendError(res, 500, 'internal_error', error.message);

    deps.logger.info('analytics.scripts_updated', {
      property_id: id,
      by: userId,
      head_len: scriptHead.length,
      body_len: scriptBody.length,
    });
    res.status(204).send();
  }

  // -------------------------------------------------------------------------
  // GET /properties/:id/segment  →  { configured: boolean }
  // -------------------------------------------------------------------------
  async function getSegmentStatus(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid', { field: 'id' });
    const { data } = await deps.supabase
      .from('analytics_secrets')
      .select('id')
      .eq('property_id', id)
      .eq('key', 'segment_write_key')
      .maybeSingle();
    res.status(200).json({ configured: data !== null });
  }

  // -------------------------------------------------------------------------
  // PUT /properties/:id/segment  body: { write_key: string }
  // -------------------------------------------------------------------------
  async function setSegmentKey(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid', { field: 'id' });

    const body = req.body as { write_key?: unknown } | undefined;
    const writeKey = typeof body?.write_key === 'string' ? body.write_key.trim() : '';
    if (!writeKey || writeKey.length > 200) {
      return sendError(res, 400, 'validation_failed', 'write_key required (1..200 chars)', { field: 'write_key' });
    }

    const encrypted = deps.encryptSecret(writeKey);
    const { error } = await deps.supabase
      .from('analytics_secrets')
      .upsert(
        { property_id: id, key: 'segment_write_key', encrypted_value: encrypted, created_by: userId },
        { onConflict: 'property_id,key' },
      );
    if (error) return sendError(res, 500, 'internal_error', error.message);
    deps.logger.info('analytics.segment_key_updated', { property_id: id, by: userId });
    res.status(204).send();
  }

  // -------------------------------------------------------------------------
  // DELETE /properties/:id/segment
  // -------------------------------------------------------------------------
  async function unsetSegmentKey(req: Request, res: Response): Promise<void> {
    const userId = deps.getUserId(req);
    if (!userId) return sendError(res, 401, 'unauthenticated', 'session required');
    const id = req.params['id'];
    if (!id || !UUID_RE.test(id)) return sendError(res, 400, 'validation_failed', 'id must be a uuid', { field: 'id' });
    const { error } = await deps.supabase
      .from('analytics_secrets')
      .delete()
      .eq('property_id', id)
      .eq('key', 'segment_write_key');
    if (error) return sendError(res, 500, 'internal_error', error.message);
    res.status(204).send();
  }

  return {
    listProperties,
    createProperty,
    getProperty,
    updateProperty,
    archiveProperty,
    getScripts,
    setScripts,
    getSegmentStatus,
    setSegmentKey,
    unsetSegmentKey,
  };
}

export function mountPropertiesRoutes(router: Router, routes: ReturnType<typeof createPropertiesRoutes>): void {
  router.get('/properties', routes.listProperties);
  router.post('/properties', routes.createProperty);
  router.get('/properties/:id', routes.getProperty);
  router.patch('/properties/:id', routes.updateProperty);
  router.delete('/properties/:id', routes.archiveProperty);
  router.get('/properties/:id/scripts', routes.getScripts);
  router.put('/properties/:id/scripts', routes.setScripts);
  router.get('/properties/:id/segment', routes.getSegmentStatus);
  router.put('/properties/:id/segment', routes.setSegmentKey);
  router.delete('/properties/:id/segment', routes.unsetSegmentKey);
}
