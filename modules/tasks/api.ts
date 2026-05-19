/**
 * Admin API routes for the tasks module (spec §6).
 *
 * Mounted at /api/admin/tasks/*.
 *
 * The handlers in this file are pragmatic implementations using a
 * shared supabase client + zod validation. They rely on Postgres RLS
 * (§3.12) for access control; the handler functions add input
 * validation and shape the response envelope.
 *
 * The full surface area is large; we group handlers by resource into
 * the ./api/ subdirectory and register them all here.
 */

import type { Express, Request, Response, NextFunction } from 'express';
import type { ModuleContext } from '@gatewaze/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

// We use a lazy require for the supabase client so this module loads
// even in environments that haven't installed @supabase/supabase-js
// (e.g., docs/site builds). At runtime in the API server, the env is
// configured by the platform.
let _supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('tasks: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { createClient } = require('@supabase/supabase-js');
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase!;
}

// Set a per-request supabase client that propagates the user's JWT
// so RLS policies fire correctly. Falls back to the service-role
// client if the request has no JWT (admin worker-tier calls).
function supabaseFor(req: Request): SupabaseClient {
  const auth = req.header('authorization');
  if (!auth?.startsWith('Bearer ')) return getSupabase();
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  if (!url) return getSupabase();
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { createClient } = require('@supabase/supabase-js');
  return createClient(url, process.env.SUPABASE_ANON_KEY ?? '', {
    global: { headers: { authorization: auth } },
    auth: { persistSession: false },
  });
}

function newRequestId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  const requestId = (res.req as Request).header('x-request-id') ?? newRequestId();
  res.setHeader('x-request-id', requestId);
  res.status(status).json({
    error: { code, message, ...(details ? { details } : {}) },
    meta: { request_id: requestId },
  });
}

function sendSuccess<T>(res: Response, data: T, pagination?: { cursor: string | null; limit: number }): void {
  const requestId = (res.req as Request).header('x-request-id') ?? newRequestId();
  res.setHeader('x-request-id', requestId);
  res.status(200).json({
    data,
    meta: { request_id: requestId, ...(pagination ? { pagination } : {}) },
  });
}

// Map Postgres trigger errors to API codes.
function mapPgError(err: { code?: string; message?: string; details?: string }): { status: number; code: string; message: string; details?: Record<string, unknown> } {
  const msg = err.message ?? '';
  if (msg.includes('dependency_blocked')) {
    let details: Record<string, unknown> | undefined;
    try { if (err.details) details = JSON.parse(err.details); } catch { /* */ }
    return { status: 409, code: 'DEPENDENCY_BLOCKED', message: 'Cannot move task to non-done status while blockers are open.', details };
  }
  if (msg.includes('cycle_detected')) {
    let details: Record<string, unknown> | undefined;
    try { if (err.details) details = JSON.parse(err.details); } catch { /* */ }
    return { status: 400, code: 'CYCLE_DETECTED', message: 'Dependency edge would create a cycle.', details };
  }
  if (msg.includes('parent_cycle_detected')) {
    return { status: 400, code: 'PARENT_CYCLE_DETECTED', message: 'Reparent would create a parent-chain cycle.' };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: msg || 'Internal error' };
}

// Helper to wrap async handlers and route Postgres errors to API errors.
type Handler = (req: Request, res: Response, ctx: HandlerCtx) => Promise<void>;
interface HandlerCtx {
  supabase: SupabaseClient;
  userId: string | null;
}

// Caches the (authUserId → admin_profile.id) lookup for the lifetime
// of the process. admin_profile.id is what every task table FKs to;
// the JWT `sub` is the raw auth user id, not the profile id.
const adminProfileIdCache = new Map<string, string>();

async function resolveAdminProfileId(
  supabase: SupabaseClient,
  authUserId: string,
): Promise<string | null> {
  const cached = adminProfileIdCache.get(authUserId);
  if (cached) return cached;
  const { data } = await supabase
    .from('admin_profiles')
    .select('id')
    .eq('user_id', authUserId)
    .maybeSingle();
  if (data?.id) {
    adminProfileIdCache.set(authUserId, data.id);
    return data.id;
  }
  return null;
}

function wrap(handler: Handler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const supabase = supabaseFor(req);
      // Extract auth user id from JWT (the JWT sub claim is the
      // Supabase auth user uuid), then resolve to the admin_profile.id
      // that all task tables FK to.
      let authUserId: string | null = null;
      const auth = req.header('authorization');
      if (auth?.startsWith('Bearer ')) {
        try {
          const payload = JSON.parse(
            Buffer.from(auth.slice(7).split('.')[1] ?? '', 'base64').toString('utf-8'),
          );
          authUserId = payload.sub ?? null;
        } catch {
          /* unparseable JWT; rely on RLS */
        }
      }
      const userId = authUserId
        ? await resolveAdminProfileId(supabase, authUserId)
        : null;
      await handler(req, res, { supabase, userId });
    } catch (e) {
      const err = e as { code?: string; message?: string; details?: string };
      const mapped = mapPgError(err);
      sendError(res, mapped.status, mapped.code, mapped.message, mapped.details);
      next();
    }
  };
}

export function registerRoutes(app: Express, _context?: ModuleContext): void {
  // ---- People (admin profiles for assignment + @mention) ---------
  // Returns the platform's admin_profiles with display name + avatar
  // for assignee pickers and @-mention autocompletes. Limited to
  // 500 — boards with more admins than that are an org-scale problem
  // we'll solve when we hit it.
  app.get('/api/admin/tasks/people', wrap(async (_req, res, ctx) => {
    const { data, error } = await ctx.supabase
      .from('admin_profiles')
      .select('id, display_name, email, avatar_url')
      .order('display_name', { ascending: true })
      .limit(500);
    if (error) throw error;
    sendSuccess(res, data ?? []);
  }));

  // ---- Boards -----------------------------------------------------
  app.get('/api/admin/tasks/boards', wrap(async (_req, res, ctx) => {
    const { data, error } = await ctx.supabase
      .from('task_boards')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    sendSuccess(res, data);
  }));

  app.post('/api/admin/tasks/boards', wrap(async (req, res, ctx) => {
    const body = req.body as Record<string, unknown>;
    if (!body.name || !body.slug) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'name and slug are required');
    }
    const { data: board, error } = await ctx.supabase
      .from('task_boards')
      .insert({
        name: body.name,
        slug: body.slug,
        description: body.description ?? null,
        color: body.color ?? null,
        icon: body.icon ?? null,
        dependency_mode: body.dependency_mode ?? 'soft',
        parent_completion: body.parent_completion ?? 'manual',
        created_by: ctx.userId,
      })
      .select()
      .single();
    if (error) throw error;
    // Seed default statuses.
    const statuses = (body.default_statuses as Array<Record<string, unknown>>) ?? [
      { name: 'Backlog', color: '#94A3B8', is_default: true },
      { name: 'Todo', color: '#3B82F6' },
      { name: 'Doing', color: '#F59E0B' },
      { name: 'Done', color: '#10B981', is_done_state: true },
    ];
    const { data: statusRows, error: sErr } = await ctx.supabase.from('board_statuses').insert(
      statuses.map((s, idx) => ({
        board_id: board.id,
        name: s.name,
        color: s.color ?? null,
        sort_index: idx,
        is_done_state: !!s.is_done_state,
        is_default: !!s.is_default || idx === 0,
      })),
    ).select();
    if (sErr) throw sErr;
    // Add caller as owner.
    if (ctx.userId) {
      await ctx.supabase.from('board_members').insert({
        board_id: board.id,
        admin_profile_id: ctx.userId,
        role: 'owner',
        added_by: ctx.userId,
      });
    }
    sendSuccess(res, { board, statuses: statusRows });
  }));

  app.get('/api/admin/tasks/boards/:id', wrap(async (req, res, ctx) => {
    const [board, statuses, customFields, members] = await Promise.all([
      ctx.supabase.from('task_boards').select('*').eq('id', req.params.id).single(),
      ctx.supabase.from('board_statuses').select('*').eq('board_id', req.params.id).order('sort_index'),
      ctx.supabase.from('board_custom_fields').select('*').eq('board_id', req.params.id).order('sort_index'),
      ctx.supabase.from('board_members').select('*').eq('board_id', req.params.id),
    ]);
    if (board.error) throw board.error;
    sendSuccess(res, {
      board: board.data,
      statuses: statuses.data ?? [],
      custom_fields: customFields.data ?? [],
      members: members.data ?? [],
    });
  }));

  app.patch('/api/admin/tasks/boards/:id', wrap(async (req, res, ctx) => {
    const allowed = ['name', 'slug', 'description', 'color', 'icon', 'dependency_mode', 'parent_completion', 'kanban_includes', 'realtime_enabled', 'time_zone', 'archived'];
    const patch: Record<string, unknown> = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    if ('archived' in patch) {
      patch.archived_at = patch.archived ? new Date().toISOString() : null;
    }
    const { data, error } = await ctx.supabase
      .from('task_boards')
      .update(patch)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    sendSuccess(res, data);
  }));

  // ---- Statuses + custom fields ------------------------------------
  app.post('/api/admin/tasks/boards/:id/statuses', wrap(async (req, res, ctx) => {
    const body = req.body as Record<string, unknown>;
    const { data, error } = await ctx.supabase.from('board_statuses').insert({
      board_id: req.params.id,
      name: body.name,
      color: body.color ?? null,
      sort_index: body.sort_index ?? 0,
      is_done_state: !!body.is_done_state,
      is_default: !!body.is_default,
    }).select().single();
    if (error) throw error;
    sendSuccess(res, data);
  }));

  app.patch('/api/admin/tasks/boards/:bid/statuses/:sid', wrap(async (req, res, ctx) => {
    const allowed = ['name', 'color', 'sort_index', 'is_done_state', 'is_default'];
    const patch: Record<string, unknown> = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    const { data, error } = await ctx.supabase
      .from('board_statuses')
      .update(patch)
      .eq('id', req.params.sid)
      .select().single();
    if (error) throw error;
    sendSuccess(res, data);
  }));

  app.delete('/api/admin/tasks/boards/:bid/statuses/:sid', wrap(async (req, res, ctx) => {
    // Refuse if any task references this status.
    const { count } = await ctx.supabase
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('status_id', req.params.sid);
    if ((count ?? 0) > 0) {
      return sendError(res, 409, 'STATUS_IN_USE', `${count} task(s) still use this status; reassign them first.`);
    }
    const { error } = await ctx.supabase.from('board_statuses').delete().eq('id', req.params.sid);
    if (error) throw error;
    sendSuccess(res, { deleted: true });
  }));

  app.post('/api/admin/tasks/boards/:id/custom-fields', wrap(async (req, res, ctx) => {
    const body = req.body as Record<string, unknown>;
    const { data, error } = await ctx.supabase.from('board_custom_fields').insert({
      board_id: req.params.id,
      key: body.key,
      label: body.label,
      field_type: body.field_type,
      options: body.options ?? null,
      required: !!body.required,
      sort_index: body.sort_index ?? 0,
    }).select().single();
    if (error) throw error;
    sendSuccess(res, data);
  }));

  // ---- Tasks (CRUD + list views) ----------------------------------
  app.get('/api/admin/tasks/boards/:id/tasks', wrap(async (req, res, ctx) => {
    const view = (req.query.view as string) ?? 'flat';
    const hideDone = req.query.hide_done !== 'false';
    let q = ctx.supabase
      .from('tasks')
      .select('*')
      .eq('board_id', req.params.id)
      .is('deleted_at', null);
    if (hideDone) q = q.eq('is_done', false);
    if (view === 'calendar') {
      const from = req.query.due_from as string | undefined;
      const to = req.query.due_to as string | undefined;
      if (from) q = q.gte('due_date', from);
      if (to) q = q.lte('due_date', to);
      q = q.not('due_date', 'is', null);
    }
    if (req.query.assignee) {
      const ids = Array.isArray(req.query.assignee) ? req.query.assignee : [req.query.assignee];
      q = q.in('assignee_id', ids as string[]);
    }
    if (req.query.status) {
      const ids = Array.isArray(req.query.status) ? req.query.status : [req.query.status];
      q = q.in('status_id', ids as string[]);
    }
    q = q.order('sort_index');
    const { data: tasks, error } = await q;
    if (error) throw error;
    const [statuses, customFields] = await Promise.all([
      ctx.supabase.from('board_statuses').select('*').eq('board_id', req.params.id).order('sort_index'),
      ctx.supabase.from('board_custom_fields').select('*').eq('board_id', req.params.id).order('sort_index'),
    ]);
    if (view === 'tree') {
      const { tasksToTree } = await import('./lib/tree.js');
      const tree = tasksToTree((tasks ?? []) as never);
      sendSuccess(res, {
        tasks: tree,
        statuses: statuses.data ?? [],
        custom_fields: customFields.data ?? [],
        is_truncated: (tasks?.length ?? 0) >= 5000,
      });
    } else if (view === 'kanban') {
      const byStatus = new Map<string, unknown[]>();
      for (const s of statuses.data ?? []) byStatus.set(s.id, []);
      for (const t of tasks ?? []) {
        const key = t.status_id ?? '';
        if (byStatus.has(key)) byStatus.get(key)!.push(t);
      }
      sendSuccess(res, {
        columns: (statuses.data ?? []).map(s => ({ status: s, tasks: byStatus.get(s.id) ?? [] })),
      });
    } else {
      sendSuccess(res, { tasks, statuses: statuses.data ?? [], custom_fields: customFields.data ?? [] });
    }
  }));

  app.post('/api/admin/tasks/boards/:id/tasks', wrap(async (req, res, ctx) => {
    const body = req.body as Record<string, unknown>;
    if (!body.title) return sendError(res, 400, 'VALIDATION_ERROR', 'title is required');
    // Compute sort_index from after/before, or use initial.
    const { initial, between, after } = await import('./lib/sort-index.js');
    let sortIndex: string;
    if (body.after_task_id || body.before_task_id) {
      const ids = [body.after_task_id, body.before_task_id].filter(Boolean) as string[];
      const { data: neighbours } = await ctx.supabase
        .from('tasks')
        .select('id, sort_index, parent_task_id')
        .in('id', ids);
      const a = neighbours?.find(n => n.id === body.after_task_id)?.sort_index ?? null;
      const b = neighbours?.find(n => n.id === body.before_task_id)?.sort_index ?? null;
      sortIndex = between(a, b);
    } else {
      // Place at end of parent (or root).
      const parent = (body.parent_task_id as string | null) ?? null;
      const { data: last } = await ctx.supabase
        .from('tasks')
        .select('sort_index')
        .eq('board_id', req.params.id)
        .is('deleted_at', null)
        .is('parent_task_id', parent === null ? null : undefined)
        .order('sort_index', { ascending: false })
        .limit(1)
        .maybeSingle();
      sortIndex = last?.sort_index ? after(last.sort_index) : initial();
    }

    const insertRow: Record<string, unknown> = {
      board_id: req.params.id,
      parent_task_id: body.parent_task_id ?? null,
      title: body.title,
      description: body.description ?? null,
      status_id: body.status_id ?? null,
      assignee_id: body.assignee_id ?? null,
      priority: body.priority ?? null,
      estimate_hours: body.estimate_hours ?? null,
      start_date: body.start_date ?? null,
      due_date: body.due_date ?? null,
      sort_index: sortIndex,
      recurrence_rule: body.recurrence_rule ?? null,
      created_by: ctx.userId,
    };
    // If status_id absent, use board's default.
    if (!insertRow.status_id) {
      const { data: defaultStatus } = await ctx.supabase
        .from('board_statuses')
        .select('id')
        .eq('board_id', req.params.id)
        .eq('is_default', true)
        .maybeSingle();
      if (defaultStatus) insertRow.status_id = defaultStatus.id;
    }
    const { data: task, error } = await ctx.supabase.from('tasks').insert(insertRow).select().single();
    if (error) throw error;

    // Custom field values.
    if (Array.isArray(body.custom_field_values)) {
      const values = (body.custom_field_values as Array<{ field_id: string; value: unknown }>).map(v => ({
        task_id: task.id,
        field_id: v.field_id,
        value: v.value,
      }));
      if (values.length > 0) await ctx.supabase.from('task_field_values').insert(values);
    }
    // Links.
    if (Array.isArray(body.links)) {
      const links = (body.links as Array<{ entity_type: string; entity_id: string }>).map(l => ({
        task_id: task.id,
        entity_type: l.entity_type,
        entity_id: l.entity_id,
        created_by: ctx.userId,
      }));
      if (links.length > 0) await ctx.supabase.from('task_links').insert(links);
    }
    // Initial activity row.
    await ctx.supabase.from('task_activity').insert({
      task_id: task.id,
      actor_id: ctx.userId,
      event_type: 'created',
      payload: { title: task.title },
    });
    sendSuccess(res, { task });
  }));

  app.get('/api/admin/tasks/tasks/:id', wrap(async (req, res, ctx) => {
    const [task, fields, links, deps] = await Promise.all([
      ctx.supabase.from('tasks').select('*').eq('id', req.params.id).single(),
      ctx.supabase.from('task_field_values').select('*').eq('task_id', req.params.id),
      ctx.supabase.from('task_links').select('*').eq('task_id', req.params.id),
      ctx.supabase.from('task_dependencies').select('*').or(`blocker_id.eq.${req.params.id},blocked_id.eq.${req.params.id}`),
    ]);
    if (task.error) throw task.error;
    sendSuccess(res, {
      task: task.data,
      custom_field_values: fields.data ?? [],
      links: links.data ?? [],
      dependencies: deps.data ?? [],
    });
  }));

  app.patch('/api/admin/tasks/tasks/:id', wrap(async (req, res, ctx) => {
    const allowed = ['title', 'description', 'status_id', 'assignee_id', 'priority', 'estimate_hours', 'start_date', 'due_date', 'recurrence_rule'];
    const patch: Record<string, unknown> = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    const { data, error } = await ctx.supabase.from('tasks').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    // Custom field values upsert.
    if (Array.isArray(req.body.custom_field_values)) {
      const values = req.body.custom_field_values.map((v: { field_id: string; value: unknown }) => ({
        task_id: req.params.id,
        field_id: v.field_id,
        value: v.value,
      }));
      if (values.length > 0) await ctx.supabase.from('task_field_values').upsert(values);
    }
    sendSuccess(res, { task: data });
  }));

  app.delete('/api/admin/tasks/tasks/:id', wrap(async (req, res, ctx) => {
    const { error } = await ctx.supabase
      .from('tasks')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) throw error;
    sendSuccess(res, { deleted: true });
  }));

  app.post('/api/admin/tasks/tasks/:id/restore', wrap(async (req, res, ctx) => {
    const { error } = await ctx.supabase
      .from('tasks')
      .update({ deleted_at: null })
      .eq('id', req.params.id);
    if (error) throw error;
    sendSuccess(res, { restored: true });
  }));

  app.post('/api/admin/tasks/tasks/:id/reorder', wrap(async (req, res, ctx) => {
    const { between } = await import('./lib/sort-index.js');
    const { after_task_id, before_task_id } = req.body as { after_task_id?: string; before_task_id?: string };
    const ids = [after_task_id, before_task_id].filter(Boolean) as string[];
    const { data: neighbours } = await ctx.supabase
      .from('tasks')
      .select('id, sort_index, parent_task_id')
      .in('id', ids);
    // Validate neighbours share a parent.
    if (neighbours && neighbours.length === 2) {
      if (neighbours[0]!.parent_task_id !== neighbours[1]!.parent_task_id) {
        return sendError(res, 400, 'INVALID_SORT_INDEX', 'reorder neighbours must share the same parent');
      }
    }
    const a = neighbours?.find(n => n.id === after_task_id)?.sort_index ?? null;
    const b = neighbours?.find(n => n.id === before_task_id)?.sort_index ?? null;
    const newSort = between(a, b);
    const { data, error } = await ctx.supabase
      .from('tasks')
      .update({ sort_index: newSort })
      .eq('id', req.params.id)
      .select('id, sort_index')
      .single();
    if (error) throw error;
    await ctx.supabase.from('task_activity').insert({
      task_id: req.params.id,
      actor_id: ctx.userId,
      event_type: 'reordered',
      payload: { new_sort_index: newSort },
    });
    sendSuccess(res, { task: data });
  }));

  app.post('/api/admin/tasks/tasks/:id/reparent', wrap(async (req, res, ctx) => {
    const { between } = await import('./lib/sort-index.js');
    const { new_parent_id, after_task_id, before_task_id } = req.body as {
      new_parent_id: string | null;
      after_task_id?: string | null;
      before_task_id?: string | null;
    };
    const ids = [after_task_id, before_task_id].filter(Boolean) as string[];
    const { data: neighbours } = ids.length
      ? await ctx.supabase.from('tasks').select('id, sort_index').in('id', ids)
      : { data: null };
    const a = neighbours?.find(n => n.id === after_task_id)?.sort_index ?? null;
    const b = neighbours?.find(n => n.id === before_task_id)?.sort_index ?? null;
    const newSort = between(a, b);
    const { data, error } = await ctx.supabase
      .from('tasks')
      .update({ parent_task_id: new_parent_id, sort_index: newSort })
      .eq('id', req.params.id)
      .select('id, parent_task_id, sort_index')
      .single();
    if (error) throw error;
    sendSuccess(res, { task: data });
  }));

  // ---- Dependencies -----------------------------------------------
  app.post('/api/admin/tasks/tasks/:id/dependencies', wrap(async (req, res, ctx) => {
    const { blocker_id } = req.body as { blocker_id: string };
    if (!blocker_id) return sendError(res, 400, 'VALIDATION_ERROR', 'blocker_id is required');
    const { error } = await ctx.supabase.from('task_dependencies').insert({
      blocker_id,
      blocked_id: req.params.id,
      created_by: ctx.userId,
    });
    if (error) throw error;
    await ctx.supabase.from('task_activity').insert({
      task_id: req.params.id,
      actor_id: ctx.userId,
      event_type: 'dependency_added',
      payload: { blocker_id },
    });
    sendSuccess(res, { added: true });
  }));

  app.delete('/api/admin/tasks/tasks/:id/dependencies/:blockerId', wrap(async (req, res, ctx) => {
    const { error } = await ctx.supabase
      .from('task_dependencies')
      .delete()
      .eq('blocked_id', req.params.id)
      .eq('blocker_id', req.params.blockerId);
    if (error) throw error;
    sendSuccess(res, { removed: true });
  }));

  // ---- Links ------------------------------------------------------
  app.post('/api/admin/tasks/tasks/:id/links', wrap(async (req, res, ctx) => {
    const { entity_type, entity_id } = req.body as { entity_type: string; entity_id: string };
    // Application-level FK validation (§6.14).
    const targetTable: Record<string, string> = {
      events: 'events',
      speakers: 'speakers',
      content_items: 'content_items',
      lists: 'lists',
      pipelines: 'pipelines',
      forms: 'forms',
    };
    const t = targetTable[entity_type];
    if (!t) return sendError(res, 400, 'VALIDATION_ERROR', 'unknown entity_type');
    const { count } = await ctx.supabase.from(t).select('id', { count: 'exact', head: true }).eq('id', entity_id);
    if (!count) return sendError(res, 404, 'LINK_TARGET_NOT_FOUND', `${entity_type}:${entity_id} does not exist`);
    const { data, error } = await ctx.supabase.from('task_links').insert({
      task_id: req.params.id,
      entity_type,
      entity_id,
      created_by: ctx.userId,
    }).select().single();
    if (error) throw error;
    await ctx.supabase.from('task_activity').insert({
      task_id: req.params.id,
      actor_id: ctx.userId,
      event_type: 'link_added',
      payload: { entity_type, entity_id },
    });
    sendSuccess(res, { link: data });
  }));

  app.delete('/api/admin/tasks/tasks/:id/links/:linkId', wrap(async (req, res, ctx) => {
    const { error } = await ctx.supabase
      .from('task_links')
      .delete()
      .eq('id', req.params.linkId)
      .eq('task_id', req.params.id);
    if (error) throw error;
    sendSuccess(res, { removed: true });
  }));

  app.get('/api/admin/tasks/by-entity/:entityType/:entityId', wrap(async (req, res, ctx) => {
    const { data, error } = await ctx.supabase
      .from('task_links')
      .select('task_id, tasks(*)')
      .eq('entity_type', req.params.entityType)
      .eq('entity_id', req.params.entityId);
    if (error) throw error;
    sendSuccess(res, { tasks: (data ?? []).map((l: { tasks?: unknown }) => l.tasks).filter(Boolean) });
  }));

  // ---- Comments ---------------------------------------------------
  app.get('/api/admin/tasks/tasks/:id/comments', wrap(async (req, res, ctx) => {
    const { data, error } = await ctx.supabase
      .from('task_comments')
      .select('*')
      .eq('task_id', req.params.id)
      .is('deleted_at', null)
      .order('created_at');
    if (error) throw error;
    sendSuccess(res, data);
  }));

  app.post('/api/admin/tasks/tasks/:id/comments', wrap(async (req, res, ctx) => {
    const { body } = req.body as { body: string };
    if (!body) return sendError(res, 400, 'VALIDATION_ERROR', 'body is required');
    // Parse @[Name](user:uuid) mentions.
    const mentions: string[] = [];
    const mentionRe = /@\[[^\]]*\]\(user:([0-9a-f-]{36})\)/g;
    let m;
    while ((m = mentionRe.exec(body))) mentions.push(m[1]!);
    const { data, error } = await ctx.supabase.from('task_comments').insert({
      task_id: req.params.id,
      author_id: ctx.userId,
      body,
      mentions,
    }).select().single();
    if (error) throw error;
    sendSuccess(res, data);
  }));

  app.delete('/api/admin/tasks/tasks/:id/comments/:commentId', wrap(async (req, res, ctx) => {
    const { error } = await ctx.supabase
      .from('task_comments')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', req.params.commentId);
    if (error) throw error;
    sendSuccess(res, { deleted: true });
  }));

  // ---- Activity (unified comments + activity feed) ----------------
  app.get('/api/admin/tasks/tasks/:id/activity', wrap(async (req, res, ctx) => {
    const [activity, comments] = await Promise.all([
      ctx.supabase
        .from('task_activity')
        .select('*')
        .eq('task_id', req.params.id)
        .order('occurred_at', { ascending: false })
        .limit(50),
      ctx.supabase
        .from('task_comments')
        .select('*')
        .eq('task_id', req.params.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);
    if (activity.error) throw activity.error;
    if (comments.error) throw comments.error;
    const items = [
      ...(activity.data ?? []).map(a => ({ kind: 'activity' as const, occurred_at: a.occurred_at, activity: a })),
      ...(comments.data ?? []).map(c => ({ kind: 'comment' as const, occurred_at: c.created_at, comment: c })),
    ].sort((a, b) => (a.occurred_at > b.occurred_at ? -1 : 1));
    sendSuccess(res, { items });
  }));

  // ---- Notifications ----------------------------------------------
  app.get('/api/admin/tasks/notifications', wrap(async (req, res, ctx) => {
    let q = ctx.supabase.from('task_notifications').select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (req.query.unread_only === 'true') q = q.is('read_at', null);
    if (req.query.kind) q = q.eq('kind', req.query.kind as string);
    const { data, error } = await q;
    if (error) throw error;
    sendSuccess(res, { items: data ?? [] });
  }));

  app.get('/api/admin/tasks/notifications/unread-count', wrap(async (_req, res, ctx) => {
    const { count } = await ctx.supabase
      .from('task_notifications')
      .select('id', { count: 'exact', head: true })
      .is('read_at', null);
    sendSuccess(res, { count: count ?? 0 });
  }));

  app.post('/api/admin/tasks/notifications/mark-read', wrap(async (req, res, ctx) => {
    const ids = (req.body.ids as string[] | undefined) ?? null;
    const all = req.body.all === true;
    let q = ctx.supabase.from('task_notifications').update({ read_at: new Date().toISOString() });
    if (!all && ids?.length) q = q.in('id', ids);
    const { error } = await q;
    if (error) throw error;
    sendSuccess(res, { marked: true });
  }));

  app.get('/api/admin/tasks/preferences', wrap(async (req, res, ctx) => {
    if (!ctx.userId) return sendError(res, 401, 'UNAUTHORIZED', 'user required');
    const { data } = await ctx.supabase
      .from('task_user_prefs')
      .select('*')
      .eq('admin_profile_id', ctx.userId)
      .maybeSingle();
    sendSuccess(res, data ?? {
      admin_profile_id: ctx.userId,
      in_app_enabled: true,
      email_enabled: true,
      email_cadence: 'daily',
      notify_on_assignment: true,
      notify_on_mention: true,
      notify_on_due_soon: true,
      notify_on_followed_change: true,
      due_soon_lead_hours: 24,
    });
  }));

  app.patch('/api/admin/tasks/preferences', wrap(async (req, res, ctx) => {
    if (!ctx.userId) return sendError(res, 401, 'UNAUTHORIZED', 'user required');
    const allowed = ['in_app_enabled', 'email_enabled', 'email_cadence', 'notify_on_assignment', 'notify_on_mention', 'notify_on_due_soon', 'notify_on_followed_change', 'due_soon_lead_hours', 'time_zone'];
    const patch: Record<string, unknown> = { admin_profile_id: ctx.userId };
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    const { data, error } = await ctx.supabase
      .from('task_user_prefs')
      .upsert(patch)
      .select().single();
    if (error) throw error;
    sendSuccess(res, data);
  }));

  // ---- Webhooks ---------------------------------------------------
  app.get('/api/admin/tasks/boards/:id/webhooks', wrap(async (req, res, ctx) => {
    const { redactUrl } = await import('./lib/encrypt.js');
    const { data, error } = await ctx.supabase
      .from('board_webhooks')
      .select('id, board_id, kind, url, events, include_description, active, last_success_at, last_failure_at, failure_count, created_at')
      .eq('board_id', req.params.id);
    if (error) throw error;
    const items = (data ?? []).map(w => ({ ...w, url: redactUrl(w.url, w.kind) }));
    sendSuccess(res, items);
  }));

  app.post('/api/admin/tasks/boards/:id/webhooks', wrap(async (req, res, ctx) => {
    const { encrypt } = await import('./lib/encrypt.js');
    const body = req.body as Record<string, unknown>;
    const { data, error } = await ctx.supabase.from('board_webhooks').insert({
      board_id: req.params.id,
      kind: body.kind,
      url: encrypt(body.url as string),
      secret: encrypt((body.secret as string) ?? null),
      events: body.events ?? [],
      include_description: body.include_description !== false,
      created_by: ctx.userId,
    }).select().single();
    if (error) throw error;
    sendSuccess(res, { webhook: { ...data, secret: undefined } });
  }));

  app.delete('/api/admin/tasks/boards/:id/webhooks/:wid', wrap(async (req, res, ctx) => {
    const { error } = await ctx.supabase.from('board_webhooks').delete().eq('id', req.params.wid);
    if (error) throw error;
    sendSuccess(res, { deleted: true });
  }));
}
