// @ts-nocheck — depends on @supabase/supabase-js + express which require
// pnpm install at the modules workspace level.
/**
 * Record a rotated photograph.
 *
 *   POST /admin/events/:eventId/media/:mediaId/rotated
 *
 * Some photographs come in on their side -- a portrait frame that should
 * be landscape (asked 2026-09-27). The rotating itself happens in the
 * organiser's browser, which already has the picture on screen and a
 * canvas to turn it with; this route is what writes the result down.
 *
 * It does not take the caller's word for much. The paths must sit inside
 * this event's own folder, must be objects that actually exist, and the
 * variants offered are matched against the ones the row already has, so
 * a rotation cannot point a photograph at somebody else's file or invent
 * a layer that was never generated.
 *
 * The browser writes new objects rather than overwriting the originals,
 * because a CDN caches by name and would go on serving the old picture
 * for hours. The old objects are removed once the row points at the new
 * ones.
 */
import type { Request, Response, Router } from 'express';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface RotateMediaDeps {
  canAdminEvent: (req: Request, eventId: string) => Promise<boolean | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceClient: any;
  storageBucket: string;
  logger: PlatformLogger;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A storage path we are prepared to write into a row. */
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,300}\.(jpg|jpeg|png|webp)$/;
/** The layers a rotation may replace; everything else is left alone. */
const LAYERS = ['plate', 'cutout', 'depth', 'hires', 'thumb', 'medium'] as const;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

export function createRotateMedia(deps: RotateMediaDeps) {
  const { canAdminEvent, serviceClient: db, storageBucket, logger } = deps;

  async function rotated(req: Request, res: Response): Promise<void> {
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
    const path = typeof body['storage_path'] === 'string' ? body['storage_path'] : '';
    const width = Number(body['width']);
    const height = Number(body['height']);
    const bytes = Number(body['bytes']);
    const quarters = Number(body['quarters']);
    if (!PATH_RE.test(path)
      || !Number.isInteger(width) || width < 1 || width > 20000
      || !Number.isInteger(height) || height < 1 || height > 20000
      || !Number.isInteger(bytes) || bytes < 1 || bytes > 64 * 1024 * 1024
      || ![1, 2, 3].includes(quarters)) {
      sendError(res, 400, 'invalid_request', 'storage_path, width, height, bytes and quarters are required');
      return;
    }

    const { data: row, error } = await db
      .from('host_media')
      .select('id, host_kind, host_id, storage_path, variants, metadata, mime_type')
      .eq('id', mediaId)
      .maybeSingle();
    if (error || !row || row.host_kind !== 'event' || row.host_id !== eventId) {
      sendError(res, 404, 'not_found', 'no such photo on this event');
      return;
    }
    // Only a photograph can be turned. Without this an organiser could
    // point a video row at a still and lose the video: the row below is
    // written as a JPEG whatever it was, and the old file is removed.
    if (typeof row.mime_type !== 'string' || !row.mime_type.startsWith('image/')) {
      sendError(res, 400, 'not_a_photo', 'only a photo can be turned');
      return;
    }

    // Everything written must live in this event's own folder, and in
    // fact in this photograph's own folder beside the file it replaces --
    // so a rotation can only ever point a row at its own new files, not
    // at another photograph's.
    const prefix = `event/${eventId}/`;
    const current = typeof row.storage_path === 'string' ? row.storage_path : '';
    const dir = current.slice(0, current.lastIndexOf('/'));
    if (!dir.startsWith(prefix)) {
      sendError(res, 409, 'unsupported_layout', 'this photo is not stored where a rotation can be written');
      return;
    }
    const inside = (p: string) => p.startsWith(`${dir}/`) && !p.includes('..');
    if (!inside(path)) { sendError(res, 400, 'invalid_request', 'that path is not beside the photo it replaces'); return; }

    // Only the layers this photo already had may be replaced.
    const had = (row.variants ?? {}) as Record<string, unknown>;
    const offered = (typeof body['variants'] === 'object' && body['variants'] !== null
      ? body['variants'] : {}) as Record<string, unknown>;
    const variants: Record<string, string> = {};
    for (const key of LAYERS) {
      const next = offered[key];
      if (typeof next !== 'string' || !PATH_RE.test(next) || !inside(next)) continue;
      if (typeof had[key] !== 'string') continue;
      variants[key] = next;
    }

    // The files must exist: a row pointing at nothing shows a broken
    // picture on the projector, which is worse than one on its side.
    const wanted = [path, ...Object.values(variants)];
    const missing: string[] = [];
    for (const p of wanted) {
      const at = p.slice(0, p.lastIndexOf('/'));
      const name = p.slice(p.lastIndexOf('/') + 1);
      // search is a prefix match, so longer names can come back too --
      // room for those rather than a one-row listing that might miss.
      const { data: found } = await db.storage.from(storageBucket).list(at, { search: name, limit: 100 });
      if (!found || !found.some((f: { name: string }) => f.name === name)) missing.push(p);
    }
    if (missing.length > 0) {
      sendError(res, 400, 'not_uploaded', 'the rotated files are not in storage yet');
      return;
    }

    const metadata = {
      ...((row.metadata ?? {}) as Record<string, unknown>),
      // Quarter turns clockwise since the photograph was uploaded, so an
      // organiser can see it has been turned and by how much.
      rotated_quarters: ((Number((row.metadata ?? {})['rotated_quarters']) || 0) + quarters) % 4,
    };
    const { error: upErr } = await db
      .from('host_media')
      .update({
        storage_path: path,
        width,
        height,
        bytes,
        mime_type: 'image/jpeg',
        variants: { ...had, ...variants },
        metadata,
      })
      .eq('id', mediaId);
    if (upErr) {
      logger.error('rotate update failed', { mediaId, error: upErr.message });
      sendError(res, 500, 'update_failed', 'could not save the rotation');
      return;
    }

    // The originals are nobody's now. Best effort: a leftover object
    // costs a little storage, a failed rotation costs the photograph.
    const stale = [row.storage_path as string, ...Object.keys(variants).map((k) => had[k] as string)]
      .filter((p) => typeof p === 'string' && p && !wanted.includes(p)
        && p.startsWith(prefix) && !p.includes('..'));
    if (stale.length > 0) {
      try { await db.storage.from(storageBucket).remove(stale); } catch { /* swept later */ }
    }

    res.status(200).json({ id: mediaId, storage_path: path, width, height, variants: { ...had, ...variants } });
  }

  return { rotated };
}

export function mountRotateMedia(router: Router, routes: ReturnType<typeof createRotateMedia>): void {
  router.post('/events/:eventId/media/:mediaId/rotated', routes.rotated);
}
