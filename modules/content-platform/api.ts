import type { Express, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import type { ModuleContext } from '@gatewaze/shared';

let _sb: ReturnType<typeof createClient> | null = null;
function sb() {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[content-platform] missing SUPABASE env');
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

const INBOX_DEFAULT_STATES = ['pending_review', 'auto_suppressed'];
const ALLOWED_PUBLISH_STATES = [
  'draft', 'pending_review', 'auto_suppressed', 'rejected', 'published', 'unpublished',
];

function arrayParam(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function decodeCursor(c: string | undefined): { ts: string; id: string } | null {
  if (!c) return null;
  try {
    const decoded = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (decoded?.ts && decoded?.id) return decoded;
  } catch { /* ignore */ }
  return null;
}

function encodeCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify({ ts, id })).toString('base64url');
}

export function registerRoutes(app: Express, _ctx?: ModuleContext) {
  // ──────────────────────────────────────────────────────────────────────────
  // Inbox list
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/api/admin/inbox/list', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
      const cursor = decodeCursor(typeof req.query.cursor === 'string' ? req.query.cursor : undefined);
      const contentTypes = arrayParam(req.query.content_type);
      const sourceKindsRaw = arrayParam(req.query.source_kind);
      const publishStates = arrayParam(req.query.publish_state) ?? INBOX_DEFAULT_STATES;
      const categories = arrayParam(req.query.category);
      const memberOnly = String(req.query.member_only ?? '') === 'true';
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const sort = String(req.query.sort ?? 'newest');
      const assignedTo = typeof req.query.assigned_to === 'string' ? req.query.assigned_to : null;

      const invalid = publishStates.find((s) => !ALLOWED_PUBLISH_STATES.includes(s));
      if (invalid) {
        return res.status(400).json({ error: { code: 'validation', message: `unknown publish_state: ${invalid}` } });
      }

      let q = sb()
        .from('content_triage_items')
        .select(`
          id, content_type, content_id, status, lifecycle_key,
          assigned_to, assigned_at, team_name, priority, created_at,
          metadata, applied_categories, suggested_categories,
          content_sources!left(source_kind, source_ref)
        `, { count: 'estimated' })
        .in('status', ['pending', 'changes_requested']);

      if (contentTypes && contentTypes.length) q = q.in('content_type', contentTypes);
      if (assignedTo) q = q.eq('assigned_to', assignedTo);

      if (cursor) {
        q = q.or(`created_at.lt.${cursor.ts},and(created_at.eq.${cursor.ts},id.lt.${cursor.id})`);
      }

      if (sort === 'oldest') {
        q = q.order('created_at', { ascending: true }).order('id', { ascending: true });
      } else {
        q = q.order('created_at', { ascending: false }).order('id', { ascending: false });
      }

      const { data, error, count } = await q.limit(limit + 1);
      if (error) {
        return res.status(500).json({ error: { code: 'internal', message: error.message } });
      }

      // Server-side filtering on JOIN'd columns + jsonb metadata that PostgREST
      // can't easily express. Cheap because we only have up to `limit + 1` rows.
      let rows = (data ?? []).filter((r: any) => {
        const meta = r.metadata ?? {};
        const sources = Array.isArray(r.content_sources) ? r.content_sources : [];
        const sourceKind = sources[0]?.source_kind ?? 'unknown';
        if (sourceKindsRaw && sourceKindsRaw.length) {
          if (!sourceKindsRaw.includes(sourceKind)) return false;
        } else {
          // Default: hide admin_ui (admin's own creations don't need triage view).
          if (sourceKind === 'admin_ui') return false;
        }
        if (publishStates.length && meta.publish_state && !publishStates.includes(meta.publish_state)) return false;
        const category = (Array.isArray(r.applied_categories) && r.applied_categories[0]) ?? meta.category;
        if (categories && categories.length && !categories.includes(category)) return false;
        if (memberOnly && category !== 'members') return false;
        if (search) {
          const hay = `${meta.title ?? ''} ${meta.subtitle ?? ''}`.toLowerCase();
          if (!hay.includes(search.toLowerCase())) return false;
        }
        return true;
      });

      const hasMore = rows.length > limit;
      if (hasMore) rows = rows.slice(0, limit);
      const last = rows[rows.length - 1];
      const nextCursor = hasMore && last ? encodeCursor(last.created_at, last.id) : null;

      const responseRows = rows.map((r: any) => {
        const meta = r.metadata ?? {};
        const sources = Array.isArray(r.content_sources) ? r.content_sources : [];
        const src = sources[0] ?? null;
        return {
          triage_item_id: r.id,
          content_type: r.content_type,
          content_id: r.content_id,
          publish_state: meta.publish_state ?? null,
          category: (Array.isArray(r.applied_categories) && r.applied_categories[0]) ?? meta.category ?? null,
          title: meta.title ?? null,
          subtitle: meta.subtitle ?? null,
          thumbnail_url: meta.thumbnail_url ?? null,
          source: src ? { kind: src.source_kind, ref: src.source_ref, meta: {} } : { kind: 'unknown', ref: null, meta: {} },
          matched_member_rules: Array.isArray(meta.matched_member_rules) ? meta.matched_member_rules : [],
          submitted_at: r.created_at,
          assigned_to: r.assigned_to,
          lifecycle_key: r.lifecycle_key,
        };
      });

      res.json({
        data: responseRows,
        page: { next_cursor: nextCursor, estimated_total: count ?? null },
      });
    } catch (err: any) {
      res.status(500).json({ error: { code: 'internal', message: err?.message ?? String(err) } });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Bulk actions
  // ──────────────────────────────────────────────────────────────────────────
  app.post('/api/admin/inbox/bulk', async (req: Request, res: Response) => {
    try {
      const { action, selection, params } = req.body ?? {};
      if (!action) return res.status(400).json({ error: { code: 'validation', message: 'action required' } });
      if (!selection?.mode) return res.status(400).json({ error: { code: 'validation', message: 'selection.mode required' } });

      const items: Array<{ triage_item_id: string; lifecycle_key?: number }> = [];
      if (selection.mode === 'ids') {
        if (!Array.isArray(selection.items)) {
          return res.status(400).json({ error: { code: 'validation', message: 'selection.items required for mode=ids' } });
        }
        for (const it of selection.items) {
          if (!it?.triage_item_id) {
            return res.status(400).json({ error: { code: 'validation', message: 'each item needs triage_item_id' } });
          }
          items.push({ triage_item_id: it.triage_item_id, lifecycle_key: it.lifecycle_key });
        }
      } else if (selection.mode === 'filter') {
        return res.status(501).json({ error: { code: 'not_implemented', message: 'mode=filter is not yet implemented; use mode=ids' } });
      } else {
        return res.status(400).json({ error: { code: 'validation', message: 'unknown selection.mode' } });
      }

      if (items.length > 1000) {
        return res.status(400).json({ error: { code: 'validation', message: 'max 1000 items per request' } });
      }

      let processed = 0;
      let failed = 0;
      const errors: any[] = [];

      for (const it of items) {
        const { data: row, error: lookupErr } = await sb()
          .from('content_triage_items')
          .select('id, content_type, content_id, status, lifecycle_key, applied_categories, assigned_to')
          .eq('id', it.triage_item_id)
          .single();
        if (lookupErr || !row) {
          failed++;
          errors.push({ triage_item_id: it.triage_item_id, code: 'not_found', message: lookupErr?.message ?? 'not found' });
          continue;
        }
        if (it.lifecycle_key != null && row.lifecycle_key !== it.lifecycle_key) {
          failed++;
          errors.push({
            triage_item_id: it.triage_item_id,
            code: 'conflict',
            message: 'lifecycle_key mismatch',
            current_state: {
              status: row.status,
              lifecycle_key: row.lifecycle_key,
              category: (row.applied_categories as any)?.[0] ?? null,
              assigned_to: row.assigned_to,
            },
          });
          continue;
        }

        try {
          if (action === 'approve') {
            const cats = Array.isArray(params?.categories) ? params.categories : null;
            const featured = !!params?.featured;
            const { error } = await sb().rpc('triage_approve', {
              p_item_id: row.id,
              p_categories: cats,
              p_featured: featured,
              p_actor_id: null,
            });
            if (error) throw error;
          } else if (action === 'reject') {
            const reason = String(params?.reason ?? '');
            if (!reason) throw new Error('reason required for reject');
            const { error } = await sb().rpc('triage_reject', {
              p_item_id: row.id,
              p_reason: reason,
              p_actor_id: null,
            });
            if (error) throw error;
          } else if (action === 'recategorize') {
            const cat = String(params?.category ?? '');
            if (!cat) throw new Error('category required for recategorize');
            const { error: rpcErr } = await sb().rpc('content_publish_state_set', {
              p_content_type: row.content_type,
              p_content_id: row.content_id,
              p_to: 'pending_review',
              p_actor: 'admin:ui',
              p_reason: `recategorize to ${cat}`,
            });
            // Best-effort recategorize: also UPDATE the row's category column directly
            // via a generic helper. For the events case, this is content_category.
            // Modules can register their own category column; this falls back to
            // updating content_triage_items.applied_categories which is universal.
            await sb().from('content_triage_items').update({
              applied_categories: [cat],
            }).eq('id', row.id);
            if (rpcErr && !String(rpcErr.message).includes('INVALID_STATE_TRANSITION')) throw rpcErr;
          } else if (action === 'assign') {
            const userId = String(params?.user_id ?? '');
            if (!userId) throw new Error('user_id required for assign');
            const { error } = await sb().rpc('triage_assign', {
              p_item_id: row.id,
              p_assignee: userId,
              p_actor_id: null,
            });
            if (error) throw error;
          } else if (action === 'reopen') {
            const { error } = await sb().rpc('triage_reopen', {
              p_item_id: row.id,
              p_actor_id: null,
            });
            if (error) throw error;
          } else {
            throw new Error(`unknown action: ${action}`);
          }
          processed++;
        } catch (err: any) {
          failed++;
          errors.push({
            triage_item_id: it.triage_item_id,
            code: 'internal',
            message: err?.message ?? String(err),
          });
        }
      }

      res.json({ data: { processed, failed, errors } });
    } catch (err: any) {
      res.status(500).json({ error: { code: 'internal', message: err?.message ?? String(err) } });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // "Why is this here?" — single-item explanation
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/api/admin/inbox/explain/:triage_item_id', async (req: Request, res: Response) => {
    try {
      const id = req.params.triage_item_id;
      const { data: row, error } = await sb()
        .from('content_triage_items')
        .select('*')
        .eq('id', id)
        .single();
      if (error || !row) {
        return res.status(404).json({ error: { code: 'not_found', message: error?.message ?? 'not found' } });
      }

      const { data: source } = await sb()
        .from('content_sources')
        .select('source_kind, source_ref, source_meta')
        .eq('content_type', row.content_type)
        .eq('content_id', row.content_id)
        .maybeSingle();

      const { data: keywordState } = await sb()
        .from('content_keyword_item_state')
        .select('is_visible, matched_rule_ids, evaluated_at')
        .eq('content_type', row.content_type)
        .eq('content_id', row.content_id)
        .maybeSingle();

      let matchedRules: any[] = [];
      if (keywordState?.matched_rule_ids?.length) {
        const { data: rules } = await sb()
          .from('content_keyword_rules')
          .select('id, name, pattern, metadata')
          .in('id', keywordState.matched_rule_ids);
        matchedRules = rules ?? [];
      }

      const { data: audit } = await sb()
        .from('content_publish_state_audit')
        .select('from_state, to_state, actor, reason, occurred_at')
        .eq('content_type', row.content_type)
        .eq('content_id', row.content_id)
        .order('occurred_at', { ascending: false })
        .limit(20);

      res.json({
        data: {
          triage: row,
          source: source ?? null,
          keyword_verdict: keywordState ?? null,
          matched_rules: matchedRules,
          state_history: audit ?? [],
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: { code: 'internal', message: err?.message ?? String(err) } });
    }
  });
}
