// @ts-nocheck — depends on @supabase/supabase-js + express which require
// pnpm install at the modules workspace level.

/**
 * Admin CRUD for guest upload links.
 *
 *   GET    /admin/events/:eventId/media-upload-links
 *   POST   /admin/events/:eventId/media-upload-links
 *   PATCH  /admin/events/:eventId/media-upload-links/:id
 *   DELETE /admin/events/:eventId/media-upload-links/:id
 *
 * Mounted under /api/admin by register-routes.ts behind host-media's
 * requireJwt (the platform does not gate /api/admin/* itself). Row
 * authorization is REAL RLS: table ops run on a per-request client
 * built from the caller's own bearer token (anon key + Authorization
 * header), so the admin_all policy's can_admin_event(event_id) check
 * runs as the caller — the service-role client is deliberately NOT
 * used here.
 *
 * Per spec-event-media-guest-uploads §5.2.
 */

import type { Request, Response, Router } from 'express';
import { generateShortCode } from '../lib/guest-limits.js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface AdminLinksDeps {
  /** Builds a Supabase client scoped to the calling user's JWT. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  userClient: (req: Request) => any | null;
  logger: PlatformLogger;
}

interface RequestWithUser extends Request {
  userId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mass-assignment allowlist. short_code, uploads_count, event_id and
// created_by are server-controlled and never writable from the body.
export const LINK_WRITE_FIELDS = [
  'label',
  'is_active',
  'expires_at',
  'require_name',
  'allow_video',
  'auto_approve',
  'show_gallery',
  'max_photo_bytes',
  'max_video_bytes',
  'logo_url',
] as const;

const LINK_SELECT =
  'id, event_id, short_code, label, is_active, expires_at, require_name, allow_video, auto_approve, show_gallery, max_photo_bytes, max_video_bytes, logo_url, uploads_count, created_by, created_at, updated_at';

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

function pickLinkFields(body: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof body !== 'object' || body === null) return out;
  const src = body as Record<string, unknown>;
  for (const key of LINK_WRITE_FIELDS) {
    if (!(key in src)) continue;
    const value = src[key];
    switch (key) {
      case 'label':
        if (typeof value === 'string') out[key] = value.slice(0, 120);
        break;
      case 'logo_url':
        // Either an absolute http(s) URL or a storage path — nothing
        // else (no javascript:/data: schemes, no traversal).
        if (value === null) out[key] = null;
        else if (typeof value === 'string') {
          const v = value.slice(0, 2048).trim();
          if (/^https?:\/\//i.test(v)) out[key] = v;
          else if (v.length > 0 && !v.includes('..') && !/^[a-z]+:/i.test(v)) out[key] = v.replace(/^\/+/, '');
        }
        break;
      case 'expires_at':
        if (value === null) out[key] = null;
        else if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) out[key] = new Date(value).toISOString();
        break;
      case 'max_photo_bytes':
      case 'max_video_bytes': {
        const n = Number(value);
        if (Number.isInteger(n) && n > 0 && n <= 5 * 1024 * 1024 * 1024) out[key] = n;
        break;
      }
      default:
        if (typeof value === 'boolean') out[key] = value;
    }
  }
  return out;
}

export function createAdminLinksRoutes(deps: AdminLinksDeps) {
  const { userClient, logger } = deps;

  function paramEventId(req: Request, res: Response): string | null {
    const eventId = req.params['eventId'];
    if (typeof eventId !== 'string' || !UUID_RE.test(eventId)) {
      sendError(res, 400, 'invalid_event_id', 'eventId must be a UUID');
      return null;
    }
    return eventId;
  }

  function client(req: Request, res: Response) {
    const c = userClient(req);
    if (!c) {
      sendError(res, 401, 'unauthenticated', 'session required');
      return null;
    }
    return c;
  }

  async function listLinks(req: RequestWithUser, res: Response): Promise<void> {
    const eventId = paramEventId(req, res); if (!eventId) return;
    const supabase = client(req, res); if (!supabase) return;

    const { data, error } = await supabase
      .from('events_media_upload_links')
      .select(LINK_SELECT)
      .eq('event_id', eventId)
      .order('created_at', { ascending: false });
    if (error) {
      logger.error('upload-links list failed', { error: error.message });
      sendError(res, 500, 'list_failed', error.message);
      return;
    }
    res.status(200).json({ items: data ?? [] });
  }

  async function createLink(req: RequestWithUser, res: Response): Promise<void> {
    const eventId = paramEventId(req, res); if (!eventId) return;
    const supabase = client(req, res); if (!supabase) return;

    const fields = pickLinkFields(req.body);
    if (typeof fields['label'] !== 'string' || (fields['label'] as string).trim().length === 0) {
      sendError(res, 400, 'invalid_request', 'label is required');
      return;
    }

    // 3-attempt collision retry on the (unique) short_code — copies the
    // edge-fn generator posture, not the retry-free client-side copies.
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = {
        ...fields,
        event_id: eventId,
        short_code: generateShortCode(),
        created_by: req.userId ?? null,
      };
      const { data, error } = await supabase
        .from('events_media_upload_links')
        .insert(row)
        .select(LINK_SELECT)
        .single();
      if (!error) {
        res.status(201).json({ item: data });
        return;
      }
      const isUniqueViolation = typeof error.message === 'string' && error.message.includes('duplicate key');
      if (!isUniqueViolation) {
        // RLS denial surfaces here as an insert error → 403 shape.
        const denied = error.code === '42501' || /row-level security/i.test(error.message ?? '');
        if (denied) sendError(res, 403, 'forbidden', 'not authorised to manage upload links for this event');
        else {
          logger.error('upload-link create failed', { error: error.message });
          sendError(res, 500, 'create_failed', error.message);
        }
        return;
      }
    }
    sendError(res, 500, 'create_failed', 'could not allocate a unique short code');
  }

  async function patchLink(req: RequestWithUser, res: Response): Promise<void> {
    const eventId = paramEventId(req, res); if (!eventId) return;
    const linkId = req.params['id'];
    if (typeof linkId !== 'string' || !UUID_RE.test(linkId)) {
      sendError(res, 400, 'invalid_link_id', 'link id must be a UUID');
      return;
    }
    const supabase = client(req, res); if (!supabase) return;

    const fields = pickLinkFields(req.body);
    if (Object.keys(fields).length === 0) {
      sendError(res, 400, 'no_fields', 'at least one allowlisted field required');
      return;
    }
    fields['updated_at'] = new Date().toISOString();

    const { data, error } = await supabase
      .from('events_media_upload_links')
      .update(fields)
      .eq('id', linkId)
      .eq('event_id', eventId)
      .select(LINK_SELECT)
      .maybeSingle();
    if (error) {
      logger.error('upload-link patch failed', { error: error.message });
      sendError(res, 500, 'update_failed', error.message);
      return;
    }
    if (!data) {
      sendError(res, 404, 'link_not_found', 'link not found');
      return;
    }
    res.status(200).json({ item: data });
  }

  async function deleteLink(req: RequestWithUser, res: Response): Promise<void> {
    const eventId = paramEventId(req, res); if (!eventId) return;
    const linkId = req.params['id'];
    if (typeof linkId !== 'string' || !UUID_RE.test(linkId)) {
      sendError(res, 400, 'invalid_link_id', 'link id must be a UUID');
      return;
    }
    const supabase = client(req, res); if (!supabase) return;

    const { data: existing, error: fetchErr } = await supabase
      .from('events_media_upload_links')
      .select('id, uploads_count')
      .eq('id', linkId)
      .eq('event_id', eventId)
      .maybeSingle();
    if (fetchErr) { sendError(res, 500, 'fetch_failed', fetchErr.message); return; }
    if (!existing) { sendError(res, 404, 'link_not_found', 'link not found'); return; }

    if ((existing.uploads_count ?? 0) > 0) {
      // Keep metadata.upload_link_id provenance meaningful — deactivate
      // instead of deleting once anything was uploaded through it.
      const { error } = await supabase
        .from('events_media_upload_links')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', linkId)
        .eq('event_id', eventId);
      if (error) { sendError(res, 500, 'update_failed', error.message); return; }
      res.status(200).json({ action: 'deactivated' });
      return;
    }

    const { error } = await supabase
      .from('events_media_upload_links')
      .delete()
      .eq('id', linkId)
      .eq('event_id', eventId);
    if (error) { sendError(res, 500, 'delete_failed', error.message); return; }
    res.status(200).json({ action: 'deleted' });
  }

  return { listLinks, createLink, patchLink, deleteLink };
}

export function mountAdminLinksRoutes(router: Router, routes: ReturnType<typeof createAdminLinksRoutes>): void {
  router.get('/events/:eventId/media-upload-links', routes.listLinks);
  router.post('/events/:eventId/media-upload-links', routes.createLink);
  router.patch('/events/:eventId/media-upload-links/:id', routes.patchLink);
  router.delete('/events/:eventId/media-upload-links/:id', routes.deleteLink);
}
