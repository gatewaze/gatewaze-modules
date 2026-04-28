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

const INBOX_DEFAULT_STATES = ['pending_review'];
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

/**
 * Sort comparator for the inbox. Future events (event_start >= now) come
 * first ordered ASC (soonest first); past events come after ordered DESC
 * (most recent first). Rows without event_start fall through to created_at
 * DESC at the bottom.
 */
function smartEventSort(rows: Array<{ event_start: string | null; submitted_at: string }>) {
  const nowMs = Date.now();
  return rows.slice().sort((a, b) => {
    const aMs = a.event_start ? Date.parse(a.event_start) : NaN;
    const bMs = b.event_start ? Date.parse(b.event_start) : NaN;
    const aHas = !Number.isNaN(aMs);
    const bHas = !Number.isNaN(bMs);
    // Items without event_start sink to the bottom, ordered by submitted_at DESC.
    if (!aHas && !bHas) return Date.parse(b.submitted_at) - Date.parse(a.submitted_at);
    if (!aHas) return 1;
    if (!bHas) return -1;
    const aFuture = aMs >= nowMs;
    const bFuture = bMs >= nowMs;
    if (aFuture && !bFuture) return -1;
    if (!aFuture && bFuture) return 1;
    if (aFuture && bFuture) return aMs - bMs;       // future ASC (soonest first)
    return bMs - aMs;                                // past DESC (most recent first)
  });
}

interface ContentListInput {
  limit: number;
  cursor: { ts: string; id: string } | null;
  contentTypes?: string[];
  sourceKindsRaw?: string[];
  publishStates: string[];
  categories?: string[];
  memberOnly: boolean;
  search: string;
  sort: string;
}

interface MatchedRule {
  id: string;
  name: string;
  kind?: string;
}

/**
 * Look up the live keyword-evaluation state for a batch of content items
 * and return matched rules per (content_type, content_id) key.
 *
 * The list endpoints used to read `metadata.matched_rules` from the
 * triage row, but that is a snapshot taken at insertion time — for
 * adapters that evaluate keywords AFTER the triage row exists (or not at
 * all on insert) the snapshot is null and the listing showed "no match"
 * even though `content_keyword_item_state` had matches. The drawer's
 * /explain endpoint already reads from the live state, which is why the
 * detail view disagreed with the listing. This helper makes the listing
 * use the same source of truth.
 *
 * Two batched queries: one for state rows, one for rule names+metadata.
 * Returns an empty map if there's nothing to look up so callers can call
 * unconditionally.
 */
async function loadMatchedRulesByKey(
  types: string[],
  ids: string[],
): Promise<Map<string, MatchedRule[]>> {
  const out = new Map<string, MatchedRule[]>();
  if (types.length === 0 || ids.length === 0) return out;

  const { data: states } = await sb()
    .from('content_keyword_item_state')
    .select('content_type, content_id, matched_rule_ids')
    .in('content_type', types)
    .in('content_id', ids);

  const stateRows = (states ?? []) as Array<{
    content_type: string;
    content_id: string;
    matched_rule_ids: string[] | null;
  }>;

  const allRuleIds = new Set<string>();
  for (const s of stateRows) {
    for (const id of s.matched_rule_ids ?? []) allRuleIds.add(id);
  }

  const rulesById = new Map<string, { id: string; name: string; metadata: any }>();
  if (allRuleIds.size > 0) {
    const { data: rules } = await sb()
      .from('content_keyword_rules')
      .select('id, name, metadata')
      .in('id', Array.from(allRuleIds));
    for (const r of rules ?? []) {
      rulesById.set((r as any).id, r as any);
    }
  }

  for (const s of stateRows) {
    const ruleIds = s.matched_rule_ids ?? [];
    if (ruleIds.length === 0) continue;
    const rules: MatchedRule[] = [];
    for (const id of ruleIds) {
      const rule = rulesById.get(id);
      if (!rule) continue;
      rules.push({
        id: rule.id,
        name: rule.name,
        kind: rule.metadata?.kind,
      });
    }
    out.set(`${s.content_type}::${s.content_id}`, rules);
  }
  return out;
}

/**
 * List path for non-pending states. Queries the underlying content tables
 * directly via the publish-adapter registry, since closed/auto-suppressed
 * items don't have open triage rows.
 *
 * Currently iterates each registered adapter, queries its table, and merges
 * results in memory. Acceptable at small scale; replace with a UNION-based
 * RPC if cross-type performance becomes a concern.
 */
async function listFromContentTables(
  _req: Request,
  res: Response,
  input: ContentListInput,
) {
  try {
    // Resolve registered adapters
    const { data: adapters, error: adErr } = await sb()
      .from('content_publish_adapters')
      .select('content_type, table_name, publish_state_col, inbox_preview_fn');
    if (adErr) {
      return res.status(500).json({ error: { code: 'internal', message: adErr.message } });
    }

    const targetAdapters = (adapters ?? []).filter((a: any) =>
      !input.contentTypes || input.contentTypes.includes(a.content_type)
    );

    // Per-adapter queries — each fetches up to (limit+1) rows; we'll merge + sort.
    const allRows: any[] = [];
    let estimatedTotal = 0;
    for (const ad of targetAdapters) {
      // Note: PostgREST .from() expects the table name without schema.
      // table_name comes back as 'public.events' (regclass) — strip schema.
      const tableName = String(ad.table_name).replace(/^public\./, '');
      let q = sb()
        .from(tableName)
        .select('id, publish_state, content_category, created_at, updated_at, event_title, event_link, event_logo, screenshot_url, event_city, event_country_code, event_start, event_id, event_slug, scraper_id', { count: 'estimated' })
        .in('publish_state', input.publishStates);
      if (input.categories && input.categories.length) {
        q = q.in('content_category', input.categories);
      }
      if (input.memberOnly) q = q.eq('content_category', 'members');
      if (input.search) q = q.ilike('event_title', `%${input.search}%`);

      // Cursor-based pagination on (created_at desc, id desc)
      if (input.cursor) {
        q = q.or(`created_at.lt.${input.cursor.ts},and(created_at.eq.${input.cursor.ts},id.lt.${input.cursor.id})`);
      }
      if (input.sort === 'oldest') {
        q = q.order('created_at', { ascending: true }).order('id', { ascending: true });
      } else {
        q = q.order('created_at', { ascending: false }).order('id', { ascending: false });
      }
      const { data, error: rowErr, count } = await q.limit(input.limit + 1);
      if (rowErr) continue; // skip table on error rather than failing the whole list

      estimatedTotal += count ?? 0;
      for (const r of data ?? []) {
        allRows.push({ adapter: ad, row: r });
      }
    }

    // Sort merged + slice to limit + 1 (so caller knows if there's more)
    allRows.sort((a, b) => {
      const cmp = String(b.row.created_at).localeCompare(String(a.row.created_at));
      return cmp !== 0 ? cmp : String(b.row.id).localeCompare(String(a.row.id));
    });
    const paged = allRows.slice(0, input.limit + 1);
    const hasMore = paged.length > input.limit;
    const visible = hasMore ? paged.slice(0, input.limit) : paged;

    // Optional: source_kind filter via content_sources lookup
    let sourcesByKey = new Map<string, any>();
    if (visible.length > 0) {
      const types = Array.from(new Set(visible.map((v: any) => v.adapter.content_type)));
      const ids = Array.from(new Set(visible.map((v: any) => v.row.id)));
      const { data: sources } = await sb()
        .from('content_sources')
        .select('content_type, content_id, source_kind, source_ref, source_meta')
        .in('content_type', types)
        .in('content_id', ids);
      for (const s of sources ?? []) {
        sourcesByKey.set(`${(s as any).content_type}::${(s as any).content_id}`, s);
      }
    }

    const filtered = visible.filter((v: any) => {
      const sourceKind = sourcesByKey.get(`${v.adapter.content_type}::${v.row.id}`)?.source_kind ?? 'unknown';
      if (input.sourceKindsRaw && input.sourceKindsRaw.length) {
        if (!input.sourceKindsRaw.includes(sourceKind)) return false;
      }
      return true;
    });

    const matchedRulesByKey = await loadMatchedRulesByKey(
      Array.from(new Set(filtered.map((v: any) => v.adapter.content_type))),
      Array.from(new Set(filtered.map((v: any) => v.row.id))),
    );

    const responseRows = filtered.map((v: any) => {
      const r = v.row;
      const src = sourcesByKey.get(`${v.adapter.content_type}::${r.id}`) ?? null;
      const subtitle = [r.event_city, r.event_country_code, r.event_start ? String(r.event_start).slice(0, 10) : null]
        .filter(Boolean).join(' · ');
      const matched = matchedRulesByKey.get(`${v.adapter.content_type}::${r.id}`) ?? [];
      return {
        triage_item_id: `${v.adapter.content_type}:${r.id}`,  // synthetic id (no triage row exists)
        content_type: v.adapter.content_type,
        content_id: r.id,
        publish_state: r.publish_state,
        category: r.content_category ?? null,
        title: r.event_title ?? null,
        subtitle: subtitle || null,
        thumbnail_url: r.event_logo || r.screenshot_url || null,
        source_url: r.event_link ?? null,
        event_start: r.event_start ?? null,
        portal_url: r.event_slug ? `/events/${r.event_slug}` : (r.event_id ? `/e/${r.event_id}` : null),
        source: src ? { kind: src.source_kind, ref: src.source_ref, meta: {} } : { kind: 'unknown', ref: null, meta: {} },
        matched_rules: matched,
        matched_member_rules: matched.filter((m) => m.kind === 'membership'),
        submitted_at: r.created_at,
        assigned_to: null,
        lifecycle_key: 0,
      };
    });

    const last = responseRows[responseRows.length - 1];
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({ ts: last.submitted_at, id: last.content_id })).toString('base64url')
      : null;

    return res.json({
      data: smartEventSort(responseRows),
      page: { next_cursor: nextCursor, estimated_total: estimatedTotal },
    });
  } catch (err: any) {
    return res.status(500).json({ error: { code: 'internal', message: err?.message ?? String(err) } });
  }
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

      // Decide which data source to query. Pending review items live in
      // content_triage_items (open triage rows). Other states live on the
      // underlying content tables — for those we query directly via the
      // adapter registry. Mixing both states in one filter is unusual; we
      // route on the primary state.
      const isPendingOnly = publishStates.length === 1 && publishStates[0] === 'pending_review';
      const isMixedDefault = publishStates.length === 2 &&
        publishStates.includes('pending_review') && publishStates.includes('auto_suppressed');

      if (!isPendingOnly && !isMixedDefault) {
        return await listFromContentTables(req, res, {
          limit, cursor, contentTypes, sourceKindsRaw, publishStates,
          categories, memberOnly, search, sort,
        });
      }

      let q = sb()
        .from('content_triage_items')
        .select(`
          id, content_type, content_id, status, lifecycle_key,
          assigned_to, assigned_at, team_name, priority, created_at,
          metadata, applied_categories, suggested_categories
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

      // Fetch matching content_sources rows in one batch (no FK exists between
      // these tables; both are keyed on the composite (content_type, content_id),
      // so PostgREST can't infer the join).
      const triageRows = data ?? [];
      const sourcesByKey = new Map<string, { source_kind: string; source_ref: string | null; source_meta: any }>();
      if (triageRows.length > 0) {
        const types = Array.from(new Set(triageRows.map((r: any) => r.content_type)));
        const ids = Array.from(new Set(triageRows.map((r: any) => r.content_id)));
        const { data: sources } = await sb()
          .from('content_sources')
          .select('content_type, content_id, source_kind, source_ref, source_meta')
          .in('content_type', types)
          .in('content_id', ids);
        for (const s of sources ?? []) {
          sourcesByKey.set(`${(s as any).content_type}::${(s as any).content_id}`, s as any);
        }
      }

      // Server-side filtering on jsonb metadata + source kind that PostgREST
      // can't easily express. Cheap because we only have up to `limit + 1` rows.
      let rows = triageRows.filter((r: any) => {
        const meta = r.metadata ?? {};
        const src = sourcesByKey.get(`${r.content_type}::${r.content_id}`);
        const sourceKind = src?.source_kind ?? 'unknown';
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

      const matchedRulesByKey = await loadMatchedRulesByKey(
        Array.from(new Set(rows.map((r: any) => r.content_type))),
        Array.from(new Set(rows.map((r: any) => r.content_id))),
      );

      const responseRows = rows.map((r: any) => {
        const meta = r.metadata ?? {};
        const src = sourcesByKey.get(`${r.content_type}::${r.content_id}`) ?? null;
        // Prefer the live keyword state. The triage row's metadata may
        // hold an older snapshot (or none at all if the adapter inserts
        // before keyword evaluation runs), which is what produced the
        // "no match" / detail-view-disagreement bug.
        const liveMatches = matchedRulesByKey.get(`${r.content_type}::${r.content_id}`);
        const matched: MatchedRule[] = liveMatches && liveMatches.length > 0
          ? liveMatches
          : (Array.isArray(meta.matched_rules) ? meta.matched_rules : []);
        return {
          triage_item_id: r.id,
          content_type: r.content_type,
          content_id: r.content_id,
          publish_state: meta.publish_state ?? null,
          category: (Array.isArray(r.applied_categories) && r.applied_categories[0]) ?? meta.category ?? null,
          title: meta.title ?? null,
          subtitle: meta.subtitle ?? null,
          thumbnail_url: meta.thumbnail_url ?? null,
          source_url: meta.source_url ?? null,
          event_start: meta.event_start ?? null,
          portal_url: meta.event_slug
            ? `/events/${meta.event_slug}`
            : (meta.event_id ? `/e/${meta.event_id}` : null),
          source: src ? { kind: src.source_kind, ref: src.source_ref, meta: {} } : { kind: 'unknown', ref: null, meta: {} },
          matched_rules: matched,
          matched_member_rules: matched.filter((m: any) => m?.kind === 'membership'),
          submitted_at: r.created_at,
          assigned_to: r.assigned_to,
          lifecycle_key: r.lifecycle_key,
        };
      });

      res.json({
        data: smartEventSort(responseRows),
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
      // Resolve the calling admin's Supabase Auth user id from the
      // Authorization header. The triage_items_reviewed_consistency
      // CHECK requires reviewed_by IS NOT NULL on approved/rejected
      // rows, and triage_check_permission's user-context branch needs
      // the actor uuid to evaluate assignee/team rules. Without it,
      // every approve/reject would either FORBIDDEN or violate the
      // constraint. The header is optional only because action="reopen"
      // and recategorize don't write reviewed_by.
      let actorUserId: string | null = null;
      const authHeader = req.headers.authorization;
      if (authHeader) {
        const token = authHeader.replace(/^Bearer\s+/i, '');
        try {
          const { data, error: authErr } = await sb().auth.getUser(token);
          if (!authErr && data?.user?.id) actorUserId = data.user.id;
        } catch {
          // fall through — actorUserId stays null
        }
      }

      const { action, selection, params } = req.body ?? {};
      if (!action) return res.status(400).json({ error: { code: 'validation', message: 'action required' } });
      if (!selection?.mode) return res.status(400).json({ error: { code: 'validation', message: 'selection.mode required' } });
      if ((action === 'approve' || action === 'reject') && !actorUserId) {
        return res.status(401).json({ error: { code: 'unauthenticated', message: 'approve/reject requires a valid Supabase session' } });
      }

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
        // Synthetic IDs (no triage row, e.g. rows that came from the content
        // table directly) take the form '<content_type>:<uuid>'. Detect and
        // route through content_publish_state_set instead of triage_*.
        if (it.triage_item_id.includes(':')) {
          const [contentType, contentId] = it.triage_item_id.split(':');
          try {
            let target: string | null = null;
            if (action === 'set_state') {
              target = String(params?.target_state ?? '');
              if (!target) throw new Error('target_state required for set_state on synthetic id');
            } else if (action === 'approve') {
              target = 'published';
            } else if (action === 'reject') {
              target = 'rejected';
            } else if (action === 'reopen') {
              target = 'pending_review';
            } else {
              throw new Error(`action ${action} unsupported on synthetic id`);
            }
            const reason = String(params?.reason ?? params?.notes ?? `admin_ui:${action}`);
            const { error: rpcErr } = await sb().rpc('content_publish_state_set', {
              p_content_type: contentType,
              p_content_id: contentId,
              p_to: target,
              p_actor: 'admin:ui',
              p_reason: reason,
            });
            if (rpcErr) throw rpcErr;
            processed++;
          } catch (err: any) {
            failed++;
            errors.push({
              triage_item_id: it.triage_item_id,
              code: 'internal',
              message: err?.message ?? String(err),
            });
          }
          continue;
        }

        const { data: row, error: lookupErr } = await sb()
          .from('content_triage_items')
          .select('id, content_type, content_id, status, lifecycle_key, applied_categories, assigned_to, updated_at')
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
          if (action === 'set_state') {
            // Real triage row + set_state: route to triage_approve/reject when
            // target maps to a triage outcome; otherwise fall back to RPC.
            const target = String(params?.target_state ?? '');
            if (target === 'published') {
              const { error } = await sb().rpc('triage_approve', {
                p_item_id: row.id, p_actor_id: actorUserId, p_expected_updated_at: (row as any).updated_at ?? null,
                p_applied_categories: null, p_featured: false, p_notes: null,
              });
              if (error) throw error;
            } else if (target === 'rejected') {
              const { error } = await sb().rpc('triage_reject', {
                p_item_id: row.id, p_actor_id: actorUserId, p_expected_updated_at: (row as any).updated_at ?? null,
                p_reason: String(params?.reason ?? 'admin_ui:reject'),
              });
              if (error) throw error;
            } else {
              const { error: rpcErr } = await sb().rpc('content_publish_state_set', {
                p_content_type: row.content_type, p_content_id: row.content_id,
                p_to: target, p_actor: 'admin:ui', p_reason: 'admin_ui:set_state',
              });
              if (rpcErr) throw rpcErr;
            }
            processed++;
            continue;
          }
          if (action === 'approve') {
            const cats = Array.isArray(params?.categories) ? params.categories : null;
            const featured = !!params?.featured;
            const { error } = await sb().rpc('triage_approve', {
              p_item_id: row.id,
              p_actor_id: actorUserId,
              p_expected_updated_at: (row as any).updated_at ?? null,
              p_applied_categories: cats,
              p_featured: featured,
              p_notes: null,
            });
            if (error) throw error;
          } else if (action === 'reject') {
            const reason = String(params?.reason ?? '');
            if (!reason) throw new Error('reason required for reject');
            const { error } = await sb().rpc('triage_reject', {
              p_item_id: row.id,
              p_actor_id: actorUserId,
              p_expected_updated_at: (row as any).updated_at ?? null,
              p_reason: reason,
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
              p_actor_id: actorUserId,
              p_expected_updated_at: (row as any).updated_at ?? null,
              p_assigned_to: userId,
              p_team_name: null,
            });
            if (error) throw error;
          } else if (action === 'reopen') {
            const { error } = await sb().rpc('triage_reopen', {
              p_item_id: row.id,
              p_actor_id: actorUserId,
              p_expected_updated_at: (row as any).updated_at ?? null,
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
