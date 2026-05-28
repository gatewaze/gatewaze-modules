/**
 * Content Triage HTTP API.
 *
 * Thin layer over the Postgres RPCs defined in migration 002. The API's
 * job is: extract the session user, pass through request bodies, and map
 * SQLSTATE codes to HTTP (see spec §11.1).
 *
 * State-changing endpoints require an `Idempotency-Key` header and an
 * `expectedUpdatedAt` field for optimistic concurrency.
 */

import type { Express, Request, Response } from 'express';
import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import type { ModuleContext } from '@gatewaze/shared';

function initSupabase(_projectRoot: string) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[content-triage] SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key, { auth: { persistSession: false } });
}

function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

function canonicalBody(obj: unknown): string {
  // Sorted-keys JSON, null fields stripped. Used for request_hash.
  const strip = (v: any): any => {
    if (v === null || v === undefined) return undefined;
    if (Array.isArray(v)) return v.map(strip);
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        const vv = strip(v[k]);
        if (vv !== undefined) out[k] = vv;
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(strip(obj));
}

// Resolve the session user id. We trust upstream middleware that populates
// req.user.id for authenticated admin requests; bail if missing.
function actorId(req: Request): string {
  const u = (req as any).user;
  if (!u?.id) throw Object.assign(new Error('UNAUTHENTICATED'), { httpStatus: 401, code: 'UNAUTHENTICATED' });
  return u.id;
}

// Map SQLSTATE + message from PostgREST error shape to HTTP.
function mapDbError(err: any): { status: number; code: string; message: string } {
  const code = err?.code ?? err?.sqlstate ?? null;
  const msg = err?.message ?? String(err);
  const includes = (s: string) => typeof msg === 'string' && msg.includes(s);
  if (code === 'P0002' || includes('NOT_FOUND')) return { status: 404, code: 'NOT_FOUND', message: msg };
  if (code === 'P0003' || includes('CONFLICT')) return { status: 409, code: 'CONFLICT', message: msg };
  if (code === '23505' && includes('IDEMPOTENCY_KEY_REUSED')) return { status: 409, code: 'IDEMPOTENCY_KEY_REUSED', message: msg };
  if (code === '23505') return { status: 409, code: 'CONFLICT', message: msg };
  if (code === '23503') return { status: 400, code: 'VALIDATION_ERROR', message: msg };
  if (code === '23514' || includes('VALIDATION_ERROR')) return { status: 400, code: 'VALIDATION_ERROR', message: msg };
  if (code === '42501' || includes('FORBIDDEN')) return { status: 403, code: 'FORBIDDEN', message: msg };
  if (includes('ALREADY_TERMINAL')) return { status: 409, code: 'ALREADY_TERMINAL', message: msg };
  if (includes('ADAPTER_NOT_REGISTERED')) return { status: 400, code: 'VALIDATION_ERROR', message: msg };
  return { status: 500, code: 'INTERNAL', message: msg };
}

function errorEnvelope(res: Response, mapped: { status: number; code: string; message: string }) {
  return res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
}

export function registerRoutes(app: Express, _context?: ModuleContext) {
  const projectRoot = process.cwd();

  // --------------------------------------------------------------------------
  // POST /api/triage/items — submit
  // --------------------------------------------------------------------------
  app.post('/api/triage/items', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const uid = actorId(req);
      const idemKey = (req.headers['idempotency-key'] as string | undefined) ?? null;
      const b = req.body ?? {};
      if (!b.contentType || !b.contentId || !b.source) {
        return errorEnvelope(res, { status: 400, code: 'VALIDATION_ERROR', message: 'contentType, contentId, source required' });
      }
      const mode = (b.mode ?? 'review') as 'auto_publish' | 'auto_approve' | 'review';
      if (!['auto_publish', 'auto_approve', 'review'].includes(mode)) {
        return errorEnvelope(res, { status: 400, code: 'VALIDATION_ERROR', message: 'invalid mode' });
      }
      const reqHash = idemKey ? sha256(canonicalBody(b)) : null;

      const { data, error } = await supabase.rpc('triage_submit', {
        p_content_type: b.contentType,
        p_content_id: b.contentId,
        p_source: b.source,
        p_source_ref: b.sourceRef ?? null,
        p_mode: mode,
        p_suggested_categories: b.suggestedCategories ?? null,
        p_suggested_from: b.suggestedFrom ?? null,
        p_auto_approved_reason: b.autoApprovedReason ?? null,
        p_priority: b.priority ?? null,
        p_metadata: b.metadata ?? {},
        p_actor_id: uid,
        p_idempotency_key: idemKey,
        p_request_hash: reqHash,
      });
      if (error) return errorEnvelope(res, mapDbError(error));
      const row = Array.isArray(data) ? data[0] : data;
      const status = row?.status === 'created' ? 201 : 200;
      res.status(status).json({
        status: row?.status,
        itemId: row?.item_id,
        lifecycleKey: row?.lifecycle_key,
      });
    } catch (err: any) {
      if (err?.httpStatus) return errorEnvelope(res, { status: err.httpStatus, code: err.code, message: err.message });
      errorEnvelope(res, { status: 500, code: 'INTERNAL', message: err?.message ?? String(err) });
    }
  });

  // --------------------------------------------------------------------------
  // GET /api/triage/items — queue list
  // --------------------------------------------------------------------------
  app.get('/api/triage/items', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const qs = req.query as Record<string, string | undefined>;
      const limit = Math.min(parseInt(qs.limit ?? '50', 10), 200);
      let q = supabase.from('content_triage_items').select('*', { count: 'exact' });

      if (qs.status) q = q.eq('status', qs.status);
      if (qs.contentType) q = q.eq('content_type', qs.contentType);
      if (qs.source) q = q.eq('source', qs.source);
      if (qs.team) q = q.eq('team_name', qs.team);
      if (qs.assignedTo === 'me') q = q.eq('assigned_to', actorId(req));
      else if (qs.assignedTo === 'unassigned') q = q.is('assigned_to', null);
      else if (qs.assignedTo) q = q.eq('assigned_to', qs.assignedTo);

      // Cursor pagination: base64url({ createdAt, id })
      if (qs.cursor) {
        try {
          const parsed = JSON.parse(Buffer.from(qs.cursor, 'base64url').toString('utf8'));
          if (parsed.createdAt && parsed.id) {
            q = q.or(`created_at.lt.${parsed.createdAt},and(created_at.eq.${parsed.createdAt},id.lt.${parsed.id})`);
          }
        } catch { /* ignore malformed cursor */ }
      }
      q = q.order('priority', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit);

      const { data, error } = await q;
      if (error) return errorEnvelope(res, mapDbError(error));
      const items = data ?? [];
      const last = items[items.length - 1];
      const nextCursor = items.length === limit && last
        ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString('base64url')
        : null;
      res.json({ items, nextCursor });
    } catch (err: any) {
      if (err?.httpStatus) return errorEnvelope(res, { status: err.httpStatus, code: err.code, message: err.message });
      errorEnvelope(res, { status: 500, code: 'INTERNAL', message: err?.message ?? String(err) });
    }
  });

  // --------------------------------------------------------------------------
  // GET /api/triage/items/:id — detail with recent events
  // --------------------------------------------------------------------------
  app.get('/api/triage/items/:id', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data: item, error } = await supabase.from('content_triage_items')
        .select('*').eq('id', req.params.id).single();
      if (error || !item) return errorEnvelope(res, { status: 404, code: 'NOT_FOUND', message: 'item not found' });
      const { data: events } = await supabase.from('content_triage_events')
        .select('*').eq('item_id', req.params.id)
        .order('created_at', { ascending: false }).limit(50);
      const { data: notifs } = await supabase.from('content_triage_notifications')
        .select('channel, sent_status, sent_at, read_at, notification_type')
        .eq('item_id', req.params.id);
      res.json({ item, events: events ?? [], notifications: notifs ?? [] });
    } catch (err: any) {
      errorEnvelope(res, { status: 500, code: 'INTERNAL', message: err?.message ?? String(err) });
    }
  });

  // --------------------------------------------------------------------------
  // POST /api/triage/items/:id/approve | reject | request-changes | reopen
  // --------------------------------------------------------------------------
  const stateChange = (
    rpc: 'triage_approve' | 'triage_reject' | 'triage_request_changes' | 'triage_reopen',
    bodyShape: (b: any) => Record<string, unknown>,
  ) => async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const uid = actorId(req);
      const b = req.body ?? {};
      if (!b.expectedUpdatedAt) {
        return errorEnvelope(res, { status: 400, code: 'VALIDATION_ERROR', message: 'expectedUpdatedAt required' });
      }
      const params = {
        p_item_id: req.params.id,
        p_actor_id: uid,
        p_expected_updated_at: b.expectedUpdatedAt,
        ...bodyShape(b),
      };
      const { data, error } = await supabase.rpc(rpc, params);
      if (error) return errorEnvelope(res, mapDbError(error));
      const row = Array.isArray(data) ? data[0] : data;
      res.json({ status: row?.status, itemId: row?.item_id, updatedAt: row?.updated_at, lifecycleKey: row?.lifecycle_key });
    } catch (err: any) {
      if (err?.httpStatus) return errorEnvelope(res, { status: err.httpStatus, code: err.code, message: err.message });
      errorEnvelope(res, { status: 500, code: 'INTERNAL', message: err?.message ?? String(err) });
    }
  };

  app.post('/api/triage/items/:id/approve', stateChange('triage_approve', (b) => ({
    p_applied_categories: b.appliedCategories ?? [],
    p_featured: !!b.featured,
    p_notes: b.notes ?? null,
  })));
  app.post('/api/triage/items/:id/reject', stateChange('triage_reject', (b) => ({
    p_reason: b.reason ?? '',
  })));
  app.post('/api/triage/items/:id/request-changes', stateChange('triage_request_changes', (b) => ({
    p_notes: b.notes ?? '',
  })));
  app.post('/api/triage/items/:id/reopen', stateChange('triage_reopen', () => ({})));

  // --------------------------------------------------------------------------
  // POST /api/triage/items/:id/assign
  // --------------------------------------------------------------------------
  app.post('/api/triage/items/:id/assign', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const uid = actorId(req);
      const b = req.body ?? {};
      if (!b.expectedUpdatedAt) {
        return errorEnvelope(res, { status: 400, code: 'VALIDATION_ERROR', message: 'expectedUpdatedAt required' });
      }
      const { data, error } = await supabase.rpc('triage_assign', {
        p_item_id: req.params.id,
        p_actor_id: uid,
        p_expected_updated_at: b.expectedUpdatedAt,
        p_assigned_to: b.assignedTo ?? null,
        p_team_name: b.team ?? null,
      });
      if (error) return errorEnvelope(res, mapDbError(error));
      const row = Array.isArray(data) ? data[0] : data;
      res.json({ status: row?.status, itemId: row?.item_id, updatedAt: row?.updated_at });
    } catch (err: any) {
      if (err?.httpStatus) return errorEnvelope(res, { status: err.httpStatus, code: err.code, message: err.message });
      errorEnvelope(res, { status: 500, code: 'INTERNAL', message: err?.message ?? String(err) });
    }
  });

  // --------------------------------------------------------------------------
  // GET /api/triage/my-queue, /my-queue/count — dashboard badge + view
  // --------------------------------------------------------------------------
  app.get('/api/triage/my-queue/count', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const uid = actorId(req);
      const { count, error } = await supabase.from('content_triage_items')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
        .eq('assigned_to', uid);
      if (error) return errorEnvelope(res, mapDbError(error));
      res.json({ count: count ?? 0 });
    } catch (err: any) {
      if (err?.httpStatus) return errorEnvelope(res, { status: err.httpStatus, code: err.code, message: err.message });
      errorEnvelope(res, { status: 500, code: 'INTERNAL', message: err?.message ?? String(err) });
    }
  });

  // --------------------------------------------------------------------------
  // GET /api/triage/notifications — in-app bell feed
  // --------------------------------------------------------------------------
  app.get('/api/triage/notifications', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const uid = actorId(req);
      const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10), 200);
      const { data, error } = await supabase.from('content_triage_notifications')
        .select('*')
        .eq('recipient_id', uid)
        .eq('channel', 'in_app')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) return errorEnvelope(res, mapDbError(error));
      res.json({ notifications: data ?? [] });
    } catch (err: any) {
      if (err?.httpStatus) return errorEnvelope(res, { status: err.httpStatus, code: err.code, message: err.message });
      errorEnvelope(res, { status: 500, code: 'INTERNAL', message: err?.message ?? String(err) });
    }
  });

  app.post('/api/triage/notifications/:id/read', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const uid = actorId(req);
      const { error } = await supabase.from('content_triage_notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .eq('recipient_id', uid);
      if (error) return errorEnvelope(res, mapDbError(error));
      res.json({ ok: true });
    } catch (err: any) {
      if (err?.httpStatus) return errorEnvelope(res, { status: err.httpStatus, code: err.code, message: err.message });
      errorEnvelope(res, { status: 500, code: 'INTERNAL', message: err?.message ?? String(err) });
    }
  });

  // --------------------------------------------------------------------------
  // Routes CRUD (admin, gated by content-triage.manage via RLS)
  // --------------------------------------------------------------------------
  app.get('/api/triage/routes', async (_req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data, error } = await supabase.from('content_triage_routes')
        .select('*').order('priority', { ascending: false });
      if (error) return errorEnvelope(res, mapDbError(error));
      res.json({ routes: data ?? [] });
    } catch (err: any) {
      errorEnvelope(res, { status: 500, code: 'INTERNAL', message: err?.message ?? String(err) });
    }
  });

  app.post('/api/triage/routes', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data, error } = await supabase.from('content_triage_routes')
        .insert(req.body).select('*').single();
      if (error) return errorEnvelope(res, mapDbError(error));
      res.status(201).json({ route: data });
    } catch (err: any) {
      errorEnvelope(res, { status: 500, code: 'INTERNAL', message: err?.message ?? String(err) });
    }
  });

  app.patch('/api/triage/routes/:id', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data, error } = await supabase.from('content_triage_routes')
        .update(req.body).eq('id', req.params.id).select('*').single();
      if (error) return errorEnvelope(res, mapDbError(error));
      res.json({ route: data });
    } catch (err: any) {
      errorEnvelope(res, { status: 500, code: 'INTERNAL', message: err?.message ?? String(err) });
    }
  });

  app.delete('/api/triage/routes/:id', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { error } = await supabase.from('content_triage_routes').delete().eq('id', req.params.id);
      if (error) return errorEnvelope(res, mapDbError(error));
      res.status(204).end();
    } catch (err: any) {
      errorEnvelope(res, { status: 500, code: 'INTERNAL', message: err?.message ?? String(err) });
    }
  });

  // --------------------------------------------------------------------------
  // User prefs
  // --------------------------------------------------------------------------
  app.get('/api/triage/prefs', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const uid = actorId(req);
      const { data } = await supabase.from('content_triage_user_prefs').select('*').eq('user_id', uid).maybeSingle();
      res.json({ prefs: data ?? { user_id: uid } });
    } catch (err: any) {
      if (err?.httpStatus) return errorEnvelope(res, { status: err.httpStatus, code: err.code, message: err.message });
      errorEnvelope(res, { status: 500, code: 'INTERNAL', message: err?.message ?? String(err) });
    }
  });

  app.patch('/api/triage/prefs', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const uid = actorId(req);
      const { data, error } = await supabase.from('content_triage_user_prefs')
        .upsert({ user_id: uid, ...req.body }, { onConflict: 'user_id' })
        .select('*').single();
      if (error) return errorEnvelope(res, mapDbError(error));
      res.json({ prefs: data });
    } catch (err: any) {
      if (err?.httpStatus) return errorEnvelope(res, { status: err.httpStatus, code: err.code, message: err.message });
      errorEnvelope(res, { status: 500, code: 'INTERNAL', message: err?.message ?? String(err) });
    }
  });

  // --------------------------------------------------------------------------
  // Stats (minimal v1)
  // --------------------------------------------------------------------------
  app.get('/api/triage/stats', async (_req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const counts = await Promise.all(
        (['pending', 'approved', 'rejected', 'changes_requested'] as const).map(async (s) => {
          const { count } = await supabase.from('content_triage_items')
            .select('id', { count: 'exact', head: true })
            .eq('status', s);
          return [s, count ?? 0] as const;
        })
      );
      res.json({
        byStatus: Object.fromEntries(counts),
      });
    } catch (err: any) {
      errorEnvelope(res, { status: 500, code: 'INTERNAL', message: err?.message ?? String(err) });
    }
  });
}
