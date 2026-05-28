/**
 * Content Keywords HTTP API.
 *
 * Thin layer over the Postgres RPCs in migrations/002_rpcs.sql.
 * State-changing endpoints support optimistic concurrency via If-Match
 * (numeric row_version, per spec §6.3).
 */

import type { Express, Request, Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ModuleContext } from '@gatewaze/shared';

let _supabase: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[content-keywords] SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required');
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

function actorId(req: Request): string | null {
  return (req as any).user?.id ?? null;
}

function mapDbError(err: any): { status: number; code: string; message: string; details?: any } {
  const code = err?.code ?? err?.sqlstate ?? null;
  const msg = err?.message ?? String(err);
  const lower = typeof msg === 'string' ? msg.toLowerCase() : '';
  if (code === '55006' || lower.includes('recompute_in_progress')) {
    const m = String(msg).match(/recompute_in_progress:([0-9a-f-]+)/);
    return { status: 409, code: 'recompute_in_progress', message: msg, details: { existing_job_id: m?.[1] } };
  }
  if (code === '22023' || lower.includes('missing_adapter')) return { status: 422, code: 'missing_adapter', message: msg };
  if (code === '23505') return { status: 409, code: 'conflict', message: msg };
  if (code === '23514' || code === '23502') return { status: 422, code: 'validation_error', message: msg };
  if (lower.includes('invalid_regex')) return { status: 422, code: 'invalid_regex', message: msg };
  return { status: 500, code: 'internal', message: msg };
}

function errorEnvelope(res: Response, m: { status: number; code: string; message: string; details?: any }) {
  return res.status(m.status).json({ error: { code: m.code, message: m.message, details: m.details ?? {} } });
}

function parseLimit(v: any, def = 50, max = 100) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.floor(n), max);
}

function encodeCursor(row: { created_at: string; id: string } | null): string | null {
  if (!row) return null;
  return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id })).toString('base64url');
}

function decodeCursor(s: string | undefined): { created_at: string; id: string } | null {
  if (!s) return null;
  try {
    const decoded = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (typeof decoded?.created_at === 'string' && typeof decoded?.id === 'string') return decoded;
  } catch {}
  return null;
}

// Validate a regex pattern by compile-testing it server-side (cheap).
async function compileTestRegex(sb: SupabaseClient, pattern: string, caseSensitive: boolean): Promise<string | null> {
  // Note: parameter binding for regex via supabase-js is awkward; we use a tiny RPC-less SELECT.
  const op = caseSensitive ? '~' : '~*';
  const { error } = await sb.rpc('ck_compile_test_regex', { p_pattern: pattern, p_case_sensitive: caseSensitive }).single();
  if (error) return error.message;
  return null;
}

export function registerRoutes(app: Express, _context?: ModuleContext) {
  // --------------------------------------------------------------------------
  // GET /api/content-keywords/rules
  // --------------------------------------------------------------------------
  app.get('/api/content-keywords/rules', async (req, res) => {
    try {
      const sb = supabase();
      const contentType = req.query.content_type as string | undefined;
      const isActiveParam = req.query.is_active as string | undefined;
      const limit = parseLimit(req.query.limit);
      const cursor = decodeCursor(req.query.cursor as string | undefined);

      let q = sb.from('content_keyword_rules').select('*');
      if (contentType) q = q.contains('content_types', [contentType]);
      if (isActiveParam !== 'all') q = q.eq('is_active', isActiveParam === 'false' ? false : true);
      if (cursor) {
        // Stable composite cursor: (created_at DESC, id DESC). Fetch rows strictly earlier.
        q = q.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
      }
      q = q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1);

      const { data, error } = await q;
      if (error) return errorEnvelope(res, mapDbError(error));
      const items = (data ?? []) as any[];
      const hasMore = items.length > limit;
      const page = hasMore ? items.slice(0, limit) : items;
      const next = hasMore ? encodeCursor(page[page.length - 1]) : null;
      res.json({ data: page, page: { next_cursor: next } });
    } catch (err: any) {
      errorEnvelope(res, mapDbError(err));
    }
  });

  // --------------------------------------------------------------------------
  // POST /api/content-keywords/rules
  // --------------------------------------------------------------------------
  app.post('/api/content-keywords/rules', async (req, res) => {
    try {
      const sb = supabase();
      const body = req.body ?? {};

      // Compile-test regex if needed.
      if (body.pattern_type === 'regex') {
        const err = await compileTestRegex(sb, body.pattern, !!body.case_sensitive);
        if (err) {
          return errorEnvelope(res, { status: 422, code: 'invalid_regex', message: err });
        }
      }

      const insert = {
        name: body.name,
        description: body.description ?? null,
        pattern: body.pattern,
        pattern_type: body.pattern_type ?? 'substring',
        case_sensitive: !!body.case_sensitive,
        content_types: body.content_types,
        sources: body.sources ?? null,
        fields: body.fields ?? ['any'],
        is_active: body.is_active ?? true,
        created_by: actorId(req),
      };

      const { data, error } = await sb
        .from('content_keyword_rules')
        .insert(insert)
        .select()
        .single();
      if (error) return errorEnvelope(res, mapDbError(error));

      res.status(201).json({ data });
    } catch (err: any) {
      errorEnvelope(res, mapDbError(err));
    }
  });

  // --------------------------------------------------------------------------
  // PATCH /api/content-keywords/rules/:id  (If-Match required)
  // --------------------------------------------------------------------------
  app.patch('/api/content-keywords/rules/:id', async (req, res) => {
    try {
      const sb = supabase();
      const id = req.params.id;
      const ifMatch = req.headers['if-match'];
      if (!ifMatch) {
        return errorEnvelope(res, { status: 409, code: 'if_match_required', message: 'If-Match header required' });
      }
      const expectedVersion = parseInt(String(ifMatch).replace(/"/g, ''), 10);
      if (!Number.isFinite(expectedVersion)) {
        return errorEnvelope(res, { status: 409, code: 'if_match_invalid', message: 'If-Match must be integer row_version' });
      }
      const body = req.body ?? {};
      delete body.id; delete body.created_by; delete body.created_at; delete body.row_version;

      if (body.pattern_type === 'regex' && body.pattern) {
        const err = await compileTestRegex(sb, body.pattern, !!body.case_sensitive);
        if (err) return errorEnvelope(res, { status: 422, code: 'invalid_regex', message: err });
      }

      const { data, error } = await sb
        .from('content_keyword_rules')
        .update(body)
        .eq('id', id)
        .eq('row_version', expectedVersion)
        .select()
        .single();
      if (error) return errorEnvelope(res, mapDbError(error));
      if (!data) return errorEnvelope(res, { status: 409, code: 'version_mismatch', message: 'row_version did not match' });
      res.json({ data });
    } catch (err: any) {
      errorEnvelope(res, mapDbError(err));
    }
  });

  // --------------------------------------------------------------------------
  // DELETE /api/content-keywords/rules/:id
  // --------------------------------------------------------------------------
  app.delete('/api/content-keywords/rules/:id', async (req, res) => {
    try {
      const sb = supabase();
      const { error } = await sb.from('content_keyword_rules').delete().eq('id', req.params.id);
      if (error) return errorEnvelope(res, mapDbError(error));
      res.status(204).end();
    } catch (err: any) {
      errorEnvelope(res, mapDbError(err));
    }
  });

  // --------------------------------------------------------------------------
  // POST /api/content-keywords/rules/:id/activate | /deactivate
  // --------------------------------------------------------------------------
  for (const action of ['activate', 'deactivate']) {
    app.post(`/api/content-keywords/rules/:id/${action}`, async (req, res) => {
      try {
        const sb = supabase();
        const { data, error } = await sb
          .from('content_keyword_rules')
          .update({ is_active: action === 'activate' })
          .eq('id', req.params.id)
          .select()
          .single();
        if (error) return errorEnvelope(res, mapDbError(error));
        res.json({ data });
      } catch (err: any) {
        errorEnvelope(res, mapDbError(err));
      }
    });
  }

  // --------------------------------------------------------------------------
  // POST /api/content-keywords/recompute
  // --------------------------------------------------------------------------
  app.post('/api/content-keywords/recompute', async (req, res) => {
    try {
      const sb = supabase();
      const { content_types, rule_ids, force } = req.body ?? {};

      // Create job row (will throw 55006 if a pending/running job overlaps).
      const { data: jobId, error: createErr } = await sb.rpc('ck_request_recompute', {
        p_content_types: content_types,
        p_rule_ids: rule_ids ?? null,
        p_trigger: 'manual',
        p_force: !!force,
      });
      if (createErr) return errorEnvelope(res, mapDbError(createErr));

      // Mark running, do the work inline (no separate BullMQ worker yet),
      // then mark complete. For a giant content table this would block
      // the request — fine for the current dataset; swap to BullMQ later.
      await sb.from('content_keyword_recompute_jobs')
        .update({ status: 'running', started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() })
        .eq('id', jobId);

      let processed = 0;
      let errors = 0;
      try {
        for (const ct of (content_types ?? [])) {
          // Enqueue stale + missing items, then drain.
          await sb.rpc('ck_scan_stale_and_missing', { p_content_type: ct, p_batch_size: 5000 });
        }
        // Drain whatever's queued.
        for (let pass = 0; pass < 50; pass++) {
          const { data: rows, error: drainErr } = await sb.rpc('ck_drain_queue', { p_batch_size: 200 });
          if (drainErr) throw drainErr;
          if (!rows || rows.length === 0) break;
          for (const row of rows) {
            try {
              if (row.op === 'delete') {
                await sb.from('content_keyword_item_state')
                  .delete().eq('content_type', row.content_type).eq('content_id', row.content_id);
              } else {
                const { error: evalErr } = await sb.rpc('ck_evaluate_item', {
                  p_content_type: row.content_type,
                  p_content_id: row.content_id,
                });
                if (evalErr) throw evalErr;
              }
              await sb.rpc('ck_complete_queue_row', {
                p_content_type: row.content_type,
                p_content_id: row.content_id,
              });
              processed++;
            } catch (rowErr: any) {
              errors++;
              await sb.rpc('ck_fail_queue_row', {
                p_content_type: row.content_type,
                p_content_id: row.content_id,
                p_error: String(rowErr?.message ?? rowErr).slice(0, 500),
              });
            }
          }
        }
        await sb.rpc('ck_refresh_adapter_stats', { p_content_type: null });
        await sb.from('content_keyword_recompute_jobs')
          .update({
            status: errors > 0 && errors > processed * 0.01 ? 'complete_with_errors' : 'complete',
            finished_at: new Date().toISOString(),
            rows_processed: processed,
          })
          .eq('id', jobId);
      } catch (workErr: any) {
        await sb.from('content_keyword_recompute_jobs')
          .update({
            status: 'failed',
            finished_at: new Date().toISOString(),
            error_message: String(workErr?.message ?? workErr).slice(0, 1000),
          })
          .eq('id', jobId);
        return errorEnvelope(res, mapDbError(workErr));
      }

      res.json({ data: { job_id: jobId, rows_processed: processed, errors } });
    } catch (err: any) {
      errorEnvelope(res, mapDbError(err));
    }
  });

  app.get('/api/content-keywords/recompute', async (_req, res) => {
    try {
      const sb = supabase();
      const { data, error } = await sb
        .from('content_keyword_recompute_jobs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) return errorEnvelope(res, mapDbError(error));
      res.json({ data });
    } catch (err: any) {
      errorEnvelope(res, mapDbError(err));
    }
  });

  app.get('/api/content-keywords/recompute/:id', async (req, res) => {
    try {
      const sb = supabase();
      const { data, error } = await sb
        .from('content_keyword_recompute_jobs')
        .select('*')
        .eq('id', req.params.id)
        .single();
      if (error) return errorEnvelope(res, mapDbError(error));
      res.json({ data });
    } catch (err: any) {
      errorEnvelope(res, mapDbError(err));
    }
  });

  // --------------------------------------------------------------------------
  // DELETE /api/content-keywords/recompute/:id
  // Cancels a pending or stuck running job. Refuses to delete completed
  // jobs (those exist for audit history — use ?force=1 to override).
  // --------------------------------------------------------------------------
  app.delete('/api/content-keywords/recompute/:id', async (req, res) => {
    try {
      const sb = supabase();
      const force = req.query.force === '1' || req.query.force === 'true';

      const { data: row, error: lookupErr } = await sb
        .from('content_keyword_recompute_jobs')
        .select('id, status')
        .eq('id', req.params.id)
        .maybeSingle();
      if (lookupErr) return errorEnvelope(res, mapDbError(lookupErr));
      if (!row) return res.status(404).json({ error: { code: 'not_found', message: `job ${req.params.id} not found` } });

      const isTerminal = ['complete', 'complete_with_errors', 'failed', 'cancelled'].includes(String(row.status));
      if (isTerminal && !force) {
        return res.status(409).json({
          error: {
            code: 'terminal_status',
            message: `job is in terminal status '${row.status}' — pass ?force=1 to delete anyway`,
          },
        });
      }

      const { error: delErr } = await sb
        .from('content_keyword_recompute_jobs')
        .delete()
        .eq('id', req.params.id);
      if (delErr) return errorEnvelope(res, mapDbError(delErr));

      res.json({ data: { deleted: req.params.id, was_status: row.status } });
    } catch (err: any) {
      errorEnvelope(res, mapDbError(err));
    }
  });

  // --------------------------------------------------------------------------
  // POST /api/content-keywords/recompute/clear-stuck
  // Convenience endpoint: deletes every job in 'pending' or 'running' status
  // whose heartbeat is older than 10 minutes (or has no heartbeat for any
  // pending job). Returns how many were cleared. Safe to spam.
  // --------------------------------------------------------------------------
  app.post('/api/content-keywords/recompute/clear-stuck', async (_req, res) => {
    try {
      const sb = supabase();
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      // Pending: no heartbeat ever, treat as stuck after any wait.
      const { data: pending } = await sb
        .from('content_keyword_recompute_jobs')
        .select('id')
        .eq('status', 'pending')
        .lt('created_at', tenMinAgo);

      // Running: stale heartbeat (worker was killed mid-run).
      const { data: stale } = await sb
        .from('content_keyword_recompute_jobs')
        .select('id')
        .eq('status', 'running')
        .or(`heartbeat_at.is.null,heartbeat_at.lt.${tenMinAgo}`);

      const ids = [...(pending ?? []), ...(stale ?? [])].map((r: any) => r.id);
      if (ids.length === 0) {
        return res.json({ data: { cleared: 0, ids: [] } });
      }

      const { error: delErr } = await sb
        .from('content_keyword_recompute_jobs')
        .delete()
        .in('id', ids);
      if (delErr) return errorEnvelope(res, mapDbError(delErr));

      res.json({ data: { cleared: ids.length, ids } });
    } catch (err: any) {
      errorEnvelope(res, mapDbError(err));
    }
  });

  // --------------------------------------------------------------------------
  // POST /api/content-keywords/preview-impact
  // --------------------------------------------------------------------------
  app.post('/api/content-keywords/preview-impact', async (req, res) => {
    try {
      const sb = supabase();
      const { content_types, delta, mode } = req.body ?? {};
      const { data, error } = await sb.rpc('ck_preview_impact', {
        p_content_types: content_types,
        p_delta: delta,
        p_mode: mode ?? 'approx',
      });
      if (error) return errorEnvelope(res, mapDbError(error));
      res.json({ data });
    } catch (err: any) {
      errorEnvelope(res, mapDbError(err));
    }
  });

  // --------------------------------------------------------------------------
  // GET /api/content-keywords/adapters
  // --------------------------------------------------------------------------
  app.get('/api/content-keywords/adapters', async (_req, res) => {
    try {
      const sb = supabase();
      const { data: adapters, error } = await sb
        .from('content_keyword_adapters')
        .select('*');
      if (error) return errorEnvelope(res, mapDbError(error));
      const { data: stats } = await sb.from('content_keyword_adapter_stats').select('*');
      const statsByType = new Map<string, any>((stats ?? []).map((s: any) => [s.content_type, s]));
      const merged = (adapters ?? []).map((a: any) => ({
        ...a,
        ...(statsByType.get(a.content_type) ?? { current_total_count: null, current_visible_count: null, stale_state_count: null, refreshed_at: null }),
      }));
      res.json({ data: merged });
    } catch (err: any) {
      errorEnvelope(res, mapDbError(err));
    }
  });

  app.post('/api/content-keywords/adapters/:content_type/refresh-stats', async (req, res) => {
    try {
      const sb = supabase();
      const { error } = await sb.rpc('ck_refresh_adapter_stats', { p_content_type: req.params.content_type });
      if (error) return errorEnvelope(res, mapDbError(error));
      res.status(202).json({ data: { content_type: req.params.content_type } });
    } catch (err: any) {
      errorEnvelope(res, mapDbError(err));
    }
  });
}
