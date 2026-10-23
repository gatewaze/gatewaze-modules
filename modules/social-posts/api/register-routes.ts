/**
 * Admin API for social posts. Bearer token → is_admin() evaluated as the
 * caller (the predicate RLS uses), then the service-role client does the work.
 * Same gate as content-sources and content-platform.
 *
 *   GET   /api/admin/social-posts/pool            curated items (?types=&q=&limit=)
 *   POST  /api/admin/social-posts/generate        { platform, format, items, instructions } → post text
 *   GET   /api/admin/social-posts/drafts          drafts (?status=)
 *   GET   /api/admin/social-posts/drafts/:id      one draft with its source items
 *   POST  /api/admin/social-posts/drafts          save a new draft
 *   PATCH /api/admin/social-posts/drafts/:id      edit body / format / status
 *
 * Nothing here posts to a network.
 */

import type { Express, Request, Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { checkItemCount, isFormat, isPlatform, MAX_INSTRUCTIONS_CHARS, mentionsIn } from '../lib/formats.js';
import { listPool, loadItems, loadMembers, parseItemRefs } from '../lib/pool.js';
import { isPoolType, POOL_TYPES, type PoolType } from '../lib/pool-types.js';
import { generatePost, GenerateError, loadRunChat } from '../lib/generate.js';
import { ALL_STATUSES, MAX_SOURCES, parseDraftCreate, parseDraftPatch } from '../lib/drafts.js';
import { createRateLimiter } from '../lib/rate-limit.js';

let _sb: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[social-posts] missing SUPABASE env');
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

function fail(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

// is_admin() must run AS the caller so auth.uid() resolves to them (the
// content-platform module documents why a per-call header on .rpc() is not
// enough). Returns the caller's user id, or sends the failure and returns null.
async function requireAdmin(req: Request, res: Response): Promise<string | null> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      fail(res, 401, 'unauthorized', 'Missing bearer token');
      return null;
    }
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      fail(res, 500, 'server_misconfigured', 'Auth not configured');
      return null;
    }
    const asUser = createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: authHeader } } });
    const [{ data: isAdmin, error }, { data: userData, error: userErr }] = await Promise.all([asUser.rpc('is_admin'), asUser.auth.getUser()]);
    if (userErr || (error && isAuthError(error))) {
      // An expired or bad token: 401 so the client refreshes its session.
      fail(res, 401, 'unauthorized', 'Session expired or invalid');
      return null;
    }
    if (error) {
      // The check itself failed (database down, bad config): not a refusal.
      console.error('[social-posts] is_admin check failed:', error.message);
      fail(res, 500, 'internal', 'Auth check failed');
      return null;
    }
    if (isAdmin !== true) {
      fail(res, 403, 'forbidden', 'Admin privileges required');
      return null;
    }
    const uid = userData?.user?.id;
    if (!uid) {
      fail(res, 401, 'unauthorized', 'Could not resolve the caller');
      return null;
    }
    return uid;
  } catch (e) {
    console.error('[social-posts] requireAdmin failed:', e instanceof Error ? e.message : e);
    if (!res.headersSent) fail(res, 500, 'internal', 'Auth check failed');
    return null;
  }
}

/** PostgREST answers a bad or expired JWT with PGRST30x / HTTP 401. */
function isAuthError(e: { code?: string; status?: number; message?: string }): boolean {
  return /^PGRST30\d$/.test(String(e.code ?? '')) || e.status === 401 || /jwt/i.test(String(e.message ?? ''));
}

function internal(res: Response, where: string, e: unknown) {
  const cause = e instanceof Error && e.cause ? (e.cause as { message?: string }).message ?? e.cause : '';
  console.error(`[social-posts] ${where}:`, e instanceof Error ? e.message : e, cause);
  if (!res.headersSent) fail(res, 500, 'internal', 'Unexpected error');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRAFT_COLUMNS = 'id, platform, format, status, body, hashtags, mentions, instructions, ai_model, generated_at, scheduled_for, posted_at, external_url, created_by, created_at, updated_at';

export function registerRoutes(app: Express, _context?: unknown) {
  // Each call costs money and the use case's daily cap is shared by every
  // admin, so one admin can't spend it in a burst.
  const generateLimiter = createRateLimiter({ max: 10, windowMs: 60_000 });

  app.get('/api/admin/social-posts/pool', async (req: Request, res: Response) => {
    const uid = await requireAdmin(req, res);
    if (!uid) return;
    try {
      const rawTypes = typeof req.query.types === 'string' && req.query.types
        ? req.query.types.split(',').map((t) => t.trim())
        : [...POOL_TYPES];
      const types: PoolType[] = rawTypes.filter(isPoolType);
      if (types.length === 0) return fail(res, 400, 'validation', `types must be some of ${POOL_TYPES.join(', ')}`);
      const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '40'), 10) || 40, 1), 100);
      res.json(await listPool(sb(), { types, search, limit }));
    } catch (e) {
      internal(res, 'pool', e);
    }
  });

  app.post('/api/admin/social-posts/generate', async (req: Request, res: Response) => {
    const uid = await requireAdmin(req, res);
    if (!uid) return;
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const platform = b.platform ?? 'linkedin';
      if (!isPlatform(platform)) return fail(res, 400, 'validation', 'unknown platform');
      if (!isFormat(b.format)) return fail(res, 400, 'validation', 'unknown format');
      const refs = parseItemRefs(b.items, MAX_SOURCES);
      if (!refs.ok) return fail(res, 400, 'validation', refs.error);
      const countError = checkItemCount(b.format, refs.refs.length);
      if (countError) return fail(res, 400, 'validation', countError);
      if (b.instructions != null && (typeof b.instructions !== 'string' || b.instructions.length > MAX_INSTRUCTIONS_CHARS)) {
        return fail(res, 400, 'validation', `instructions must be text of at most ${MAX_INSTRUCTIONS_CHARS} characters`);
      }
      const instructions = typeof b.instructions === 'string' && b.instructions.trim() ? b.instructions.trim() : null;

      const limited = generateLimiter.take(uid);
      if (!limited.ok) {
        res.setHeader('Retry-After', String(limited.retryAfterSec));
        return fail(res, 429, 'rate_limited', `Too many drafts in a minute. Try again in ${limited.retryAfterSec}s.`);
      }

      const { items, missing } = await loadItems(sb(), refs.refs);
      if (missing.length) {
        return fail(res, 404, 'not_found', `${missing.length === 1 ? 'An item is' : `${missing.length} items are`} no longer published. Refresh the list and pick again.`);
      }

      let runChat;
      try {
        runChat = await loadRunChat();
      } catch (e) {
        console.error('[social-posts] loadRunChat failed:', e instanceof Error ? e.message : e);
        return fail(res, 503, 'ai_unavailable', 'The AI module is not available on this deployment.');
      }

      const post = await generatePost(runChat, sb(), { platform, format: b.format, items, instructions, userId: uid });
      res.json({
        text: post.text,
        hashtags: post.hashtags,
        mentions: post.mentions,
        warnings: post.warnings,
        model: post.model,
        items: items.map((i) => ({ content_type: i.contentType, content_id: i.contentId, title: i.title, url: i.url })),
      });
    } catch (e) {
      if (e instanceof GenerateError) {
        if (e.status >= 500) {
          const cause = e.cause instanceof Error ? e.cause.message : e.cause;
          console.error('[social-posts] generate:', e.code, e.message, cause ?? '');
        }
        return fail(res, e.status, e.code, e.message);
      }
      internal(res, 'generate', e);
    }
  });

  app.get('/api/admin/social-posts/drafts', async (req: Request, res: Response) => {
    const uid = await requireAdmin(req, res);
    if (!uid) return;
    try {
      const status = typeof req.query.status === 'string' && req.query.status ? req.query.status.split(',') : null;
      if (status && !status.every((s) => (ALL_STATUSES as readonly string[]).includes(s))) {
        return fail(res, 400, 'validation', `status must be some of ${ALL_STATUSES.join(', ')}`);
      }
      let q = sb().from('social_post_drafts').select(`${DRAFT_COLUMNS}, sources:social_post_draft_sources(content_type, content_id, position, title, url)`);
      q = status ? q.in('status', status) : q.neq('status', 'archived');
      const { data, error } = await q.order('updated_at', { ascending: false }).limit(100);
      if (error) return internal(res, 'drafts list', error);
      res.json({ drafts: data ?? [] });
    } catch (e) {
      internal(res, 'drafts list', e);
    }
  });

  app.get('/api/admin/social-posts/drafts/:id', async (req: Request, res: Response) => {
    const uid = await requireAdmin(req, res);
    if (!uid) return;
    try {
      const id = String(req.params.id);
      if (!UUID.test(id)) return fail(res, 400, 'validation', 'id must be a uuid');
      const { data, error } = await sb().from('social_post_drafts')
        .select(`${DRAFT_COLUMNS}, sources:social_post_draft_sources(content_type, content_id, position, title, url)`)
        .eq('id', id).maybeSingle();
      if (error) return internal(res, 'draft get', error);
      if (!data) return fail(res, 404, 'not_found', 'Draft not found');
      res.json({ draft: data });
    } catch (e) {
      internal(res, 'draft get', e);
    }
  });

  app.post('/api/admin/social-posts/drafts', async (req: Request, res: Response) => {
    const uid = await requireAdmin(req, res);
    if (!uid) return;
    try {
      const parsed = parseDraftCreate(req.body);
      if (!parsed.ok) return fail(res, 400, 'validation', parsed.error);
      const d = parsed.value;
      // Snapshot each source's title and link as it is now. Only published
      // items can be linked, the same rule as generation.
      // strictMembers: a failed member lookup is a 500, not a draft saved with no mentions.
      const { items, missing } = await loadItems(sb(), d.sources, undefined, { strictMembers: true });
      if (missing.length) return fail(res, 404, 'not_found', 'A source item is no longer published.');
      // Mentions are derived here from the text and the sources' member
      // matches, never taken from the client, so a later poster only tags
      // companies the content-keywords rules matched.
      const mentions = mentionsIn(d.body, items);

      const { data: draft, error } = await sb().from('social_post_drafts').insert({
        platform: d.platform,
        format: d.format,
        status: d.status,
        body: d.body,
        hashtags: d.hashtags,
        mentions,
        instructions: d.instructions,
        ai_model: d.ai_model,
        generated_at: d.generated ? new Date().toISOString() : null,
        created_by: uid,
        updated_by: uid,
      }).select('id').single<{ id: string }>();
      if (error || !draft) return internal(res, 'draft insert', error);

      const { error: srcErr } = await sb().from('social_post_draft_sources').insert(items.map((i, position) => ({
        draft_id: draft.id,
        content_type: i.contentType,
        content_id: i.contentId,
        position,
        title: i.title.slice(0, 500),
        url: i.url,
      })));
      if (srcErr) {
        // Don't leave a draft that has lost its sources.
        const { error: delErr } = await sb().from('social_post_drafts').delete().eq('id', draft.id);
        if (delErr) console.error(`[social-posts] could not remove draft ${draft.id} after its sources failed to save:`, delErr.message);
        return internal(res, 'draft sources insert', srcErr);
      }
      res.status(201).json({ id: draft.id, mentions });
    } catch (e) {
      internal(res, 'draft create', e);
    }
  });

  app.patch('/api/admin/social-posts/drafts/:id', async (req: Request, res: Response) => {
    const uid = await requireAdmin(req, res);
    if (!uid) return;
    try {
      const id = String(req.params.id);
      if (!UUID.test(id)) return fail(res, 400, 'validation', 'id must be a uuid');
      const { data: existing, error: getErr } = await sb().from('social_post_drafts')
        .select('id, platform, status, sources:social_post_draft_sources(content_type, content_id)')
        .eq('id', id).maybeSingle<{ id: string; platform: string; status: string; sources: Array<{ content_type: PoolType; content_id: string }> | null }>();
      if (getErr) return internal(res, 'draft patch lookup', getErr);
      if (!existing) return fail(res, 404, 'not_found', 'Draft not found');
      const row = existing;
      if (row.status === 'scheduled' || row.status === 'posted') {
        return fail(res, 409, 'locked', `A ${row.status} post can't be edited here.`);
      }
      if (!isPlatform(row.platform)) return fail(res, 409, 'unsupported', 'This draft is for a platform this version does not support.');
      const parsed = parseDraftPatch(req.body, row.platform);
      if (!parsed.ok) return fail(res, 400, 'validation', parsed.error);
      const { regenerated, ...fields } = parsed.value;
      const update: Record<string, unknown> = { ...fields, updated_by: uid };
      if (regenerated) update.generated_at = new Date().toISOString();
      if (parsed.value.body !== undefined) {
        // Re-derive mentions from the new text and the sources' current member matches.
        const refs = (row.sources ?? []).map((r) => ({ contentType: r.content_type, contentId: r.content_id }));
        const members = await loadMembers(sb(), refs, { strict: true });
        update.mentions = mentionsIn(parsed.value.body, refs.map((r) => ({ members: members.get(`${r.contentType}::${r.contentId}`) ?? [] })));
      }
      const { data, error } = await sb().from('social_post_drafts')
        .update(update)
        .eq('id', id)
        .in('status', ['draft', 'ready', 'archived'])
        .select(DRAFT_COLUMNS).maybeSingle();
      if (error) return internal(res, 'draft patch', error);
      if (!data) return fail(res, 409, 'locked', 'The draft changed state while you were editing. Reload it.');
      res.json({ draft: data });
    } catch (e) {
      internal(res, 'draft patch', e);
    }
  });
}
