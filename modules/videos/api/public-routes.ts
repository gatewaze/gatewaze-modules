// @ts-nocheck — supabase-js + express resolved at module-host install time.

/**
 * Public read-only videos API (no JWT). All endpoints filter to
 * status='published' AND visibility='public' and set the CDN cache headers.
 *
 *   GET /api/videos                 — list published (published_at DESC)
 *     ?limit ?offset ?channel_id ?topic ?category ?search ?sort ?order
 *   GET /api/videos/:id             — single video
 *   GET /api/videos/:id.md          — markdown representation (agent-discoverable)
 */

import { createHash } from 'node:crypto';
import type { Request, Response, Router } from 'express';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const CACHE_HEADER = 'public, max-age=60, s-maxage=300, stale-if-error=86400';
const COLS =
  'id, provider, provider_video_id, url, title, description, thumbnail_url, duration_seconds, ' +
  'published_at, channel_id, channel_title, content_category, topics, speakers';

function paramAs(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return undefined;
}
function clampLimit(raw?: string): number {
  const n = raw ? parseInt(raw, 10) : DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}
function clampOffset(raw?: string): number {
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export function createPublicVideoRoutes(deps: { supabase: { from(t: string): any } }) {
  const { supabase } = deps;

  async function listVideos(req: Request, res: Response): Promise<void> {
    const limit = clampLimit(paramAs(req.query.limit));
    const offset = clampOffset(paramAs(req.query.offset));
    const channelId = paramAs(req.query.channel_id);
    const topic = paramAs(req.query.topic);
    const category = paramAs(req.query.category);
    const search = paramAs(req.query.search);
    const sort = paramAs(req.query.sort) === 'title' ? 'title' : 'published_at';
    const ascending = paramAs(req.query.order) === 'asc';

    let query = supabase
      .from('videos')
      .select(COLS)
      .eq('status', 'published')
      .eq('visibility', 'public')
      .order(sort, { ascending, nullsFirst: false });

    if (channelId) query = query.eq('channel_id', channelId);
    if (category) query = query.eq('content_category', category);
    if (topic) query = query.contains('topics', [topic]);
    if (search) {
      const safe = search.replace(/[,()*\\]/g, '').slice(0, 100);
      if (safe.length > 0) query = query.or(`title.ilike.%${safe}%,description.ilike.%${safe}%`);
    }
    query = query.range(offset, offset + limit - 1);

    const result = await query;
    if (result.error) {
      sendError(res, 500, 'internal', String(result.error.message ?? ''));
      return;
    }
    sendCacheable(req, res, { videos: result.data ?? [], meta: { limit, offset } }, ['videos']);
  }

  async function getVideo(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    if (!id) { sendError(res, 400, 'bad_request', 'id required'); return; }
    const result = await supabase
      .from('videos')
      .select(COLS + ', publish_state')
      .eq('id', id)
      .eq('status', 'published')
      .eq('visibility', 'public')
      .maybeSingle();
    if (result.error) { sendError(res, 500, 'internal', String(result.error.message ?? '')); return; }
    if (!result.data) { sendError(res, 404, 'not_found', `video '${id}' not found`); return; }
    sendCacheable(req, res, result.data, ['videos', `video:${id}`]);
  }

  async function getVideoMarkdown(req: Request, res: Response): Promise<void> {
    const id = paramAs(req.params.id);
    const result = await supabase
      .from('videos').select(COLS).eq('id', id).eq('status', 'published').eq('visibility', 'public').maybeSingle();
    if (result.error || !result.data) { sendError(res, 404, 'not_found', `video '${id}' not found`); return; }
    const v = result.data as Record<string, any>;
    const speakers = Array.isArray(v.speakers) && v.speakers.length
      ? `\n\n**Speakers:** ${v.speakers.map((s: any) => s?.name).filter(Boolean).join(', ')}` : '';
    const md = `# ${v.title}\n\n${v.description ?? ''}\n\nWatch: ${v.url}${speakers}\n`;
    res.setHeader('Cache-Control', CACHE_HEADER);
    res.status(200).type('text/markdown').send(md);
  }

  return { listVideos, getVideo, getVideoMarkdown };
}

export function mountPublicVideoRoutes(router: Router, routes: ReturnType<typeof createPublicVideoRoutes>): void {
  router.get('/videos', routes.listVideos);
  router.get('/videos/:id.md', routes.getVideoMarkdown);
  router.get('/videos/:id', routes.getVideo);
}

function sendError(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ error, message });
}
function sendCacheable(req: Request, res: Response, body: unknown, keys: string[]): void {
  const json = JSON.stringify(body);
  const etag = `W/"${createHash('sha256').update(json).digest('hex').slice(0, 16)}"`;
  res.setHeader('Cache-Control', CACHE_HEADER);
  res.setHeader('Surrogate-Key', keys.join(' '));
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
  res.status(200).type('application/json').send(json);
}
