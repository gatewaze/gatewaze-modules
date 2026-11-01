// @ts-nocheck — depends on express which requires pnpm install at the
// modules workspace level.
/**
 * Somewhere to put a file the organiser's browser has just made.
 *
 *   POST /admin/events/:eventId/media/:mediaId/upload-url
 *        { name, content_type, bytes }
 *     → { storage_path, upload_url, upload_headers }
 *
 * Rotating, enhancing and relighting happen in the browser, which then
 * writes the result beside the photograph and asks the matching route to
 * record it. The browser used to write straight into Supabase's bucket
 * with its own session, which only works while every photograph is in
 * Supabase. Now it asks here: the file goes in the same store as the
 * photograph it belongs to, wherever that is, at a path this route
 * chooses inside the photograph's own folder.
 *
 * The recording routes still check the path and that the file exists, so
 * nothing here is trusted beyond the upload itself.
 */
import type { Request, Response, Router } from 'express';
import type { MediaStorage } from '../lib/media-storage.js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface MediaUploadUrlDeps {
  canAdminEvent: (req: Request, eventId: string) => Promise<boolean | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceClient: any;
  media: MediaStorage;
  logger: PlatformLogger;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One file name, no folders. The extension must match the type. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,80}\.(jpg|png)$/;
const TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png' };
const MAX_BYTES = 64 * 1024 * 1024;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

export function createMediaUploadUrl(deps: MediaUploadUrlDeps) {
  const { canAdminEvent, serviceClient: db, media, logger } = deps;

  async function uploadUrl(req: Request, res: Response): Promise<void> {
    const eventId = req.params['eventId'];
    const mediaId = req.params['mediaId'];
    if (typeof eventId !== 'string' || !UUID_RE.test(eventId) || typeof mediaId !== 'string' || !UUID_RE.test(mediaId)) {
      sendError(res, 400, 'invalid_request', 'eventId and mediaId must be UUIDs');
      return;
    }
    let allowed: boolean | null;
    try {
      allowed = await canAdminEvent(req, eventId);
    } catch {
      allowed = false;
    }
    if (allowed === null) { sendError(res, 401, 'unauthenticated', 'session required'); return; }
    if (!allowed) { sendError(res, 403, 'forbidden', 'not authorised for this event'); return; }

    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const name = typeof body['name'] === 'string' ? body['name'] : '';
    const contentType = typeof body['content_type'] === 'string' ? body['content_type'] : '';
    const bytes = Number(body['bytes']);
    const m = NAME_RE.exec(name);
    if (!m || TYPES[m[1]!] !== contentType || !Number.isInteger(bytes) || bytes < 1 || bytes > MAX_BYTES) {
      sendError(res, 400, 'invalid_request', 'name, content_type and bytes are required');
      return;
    }

    const { data: row, error } = await db
      .from('host_media')
      .select('id, host_kind, host_id, storage_path, storage_provider, storage_bucket, mime_type')
      .eq('id', mediaId)
      .maybeSingle();
    if (error || !row || row.host_kind !== 'event' || row.host_id !== eventId) {
      sendError(res, 404, 'not_found', 'no such photo on this event');
      return;
    }
    if (typeof row.mime_type !== 'string' || !row.mime_type.startsWith('image/')) {
      sendError(res, 400, 'not_a_photo', 'only a photo has files made for it');
      return;
    }
    const current = typeof row.storage_path === 'string' ? row.storage_path : '';
    const dir = current.slice(0, current.lastIndexOf('/'));
    if (!dir.startsWith(`event/${eventId}/`) || dir.includes('..')) {
      sendError(res, 409, 'unsupported_layout', 'this photo is not stored where a copy can be written');
      return;
    }

    try {
      const store = (await media.forRow(row)).direct;
      const path = `${dir}/${name}`;
      const signed = await store.signUpload(path, { contentType, bytes, expiresSeconds: 15 * 60 });
      res.status(200).json({ storage_path: path, upload_url: signed.url, upload_headers: signed.headers });
    } catch (err) {
      logger.error('upload-url: could not sign', { mediaId, error: err instanceof Error ? err.message : String(err) });
      sendError(res, 503, 'storage_unavailable', 'could not prepare that upload');
    }
  }

  return { uploadUrl };
}

export function mountMediaUploadUrl(router: Router, routes: ReturnType<typeof createMediaUploadUrl>): void {
  router.post('/events/:eventId/media/:mediaId/upload-url', routes.uploadUrl);
}
