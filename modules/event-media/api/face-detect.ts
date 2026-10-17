// @ts-nocheck — depends on @supabase/supabase-js + express which require
// pnpm install at the modules workspace level.
/**
 * Where the faces are in an event's photographs.
 *
 *   POST /admin/events/:eventId/faces/pending  { limit }  what is left
 *   POST /admin/events/:eventId/faces          { ... }    record one
 *
 * BOXES ONLY. No templates, no embeddings, no identity — see
 * migrations/030_face_boxes.sql for why that line matters and what it
 * buys. This api cannot tell one person from another and has nothing
 * stored that would let it.
 *
 * THE API NEVER DECODES A PHOTOGRAPH. Same rule as focus-media.ts and
 * enhanceMedia.ts, same outages behind it: detection runs in the
 * organiser's browser and this takes rectangles as numbers. The pod has
 * 512Mi and a twelve-megapixel JPEG would end it.
 *
 * `pending` hands back the url of a SMALL copy. A face detector works at
 * a few hundred pixels, and asking the CDN for that width means the
 * browser fetches ~50KB instead of 3MB per photograph — the difference
 * between an album that scans in minutes and one that does not.
 */
import type { Request, Response, Router } from 'express';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface FaceDetectDeps {
  canAdminEvent: (req: Request, eventId: string) => Promise<boolean | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceClient: any;
  /** A browser-sized copy of a stored object, through the CDN. */
  sizedUrl: (path: string, width: number) => string;
  logger: PlatformLogger;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The width the detector is given.
 *
 * Big enough that a face in a group shot is still tens of pixels across,
 * small enough that the fetch and the decode are cheap. The model itself
 * works at 128px and upscales nothing, so more than this buys accuracy
 * only for faces that were never going to be usable anyway.
 */
export const DETECT_WIDTH = 768;

/** Photographs handed out per request. */
const PAGE_MAX = 200;
/** Faces recorded for one photograph. A wedding group shot is ~30. */
const FACES_MAX = 100;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

/** A number in range, or null. Never NaN, never a string that looks like one. */
function num(v: unknown, lo: number, hi: number): number | null {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n) || n < lo || n > hi) return null;
  return n;
}

export function createFaceDetect(deps: FaceDetectDeps) {
  const { canAdminEvent, serviceClient: db, sizedUrl, logger } = deps;

  /** The organiser, or nobody. */
  async function gate(req: Request, res: Response): Promise<string | null> {
    const eventId = String(req.params['eventId'] ?? '');
    if (!UUID_RE.test(eventId)) {
      sendError(res, 400, 'invalid_params', 'eventId must be a UUID');
      return null;
    }
    const may = await canAdminEvent(req, eventId);
    if (may !== true) {
      sendError(res, may === null ? 401 : 403, 'forbidden', 'not yours to manage');
      return null;
    }
    return eventId;
  }

  /**
   * Photographs this event has that nobody has looked for faces in.
   *
   * `model_id` is part of the question: a scan by an older detector is
   * not a scan by this one, so changing detector re-offers everything
   * without a migration or a flag.
   */
  async function pending(req: Request, res: Response): Promise<void> {
    const eventId = await gate(req, res);
    if (!eventId) return;

    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const limit = num(body['limit'], 1, PAGE_MAX) ?? 50;
    const modelId = typeof body['model_id'] === 'string' ? body['model_id'].slice(0, 64) : '';
    if (!modelId) {
      sendError(res, 400, 'invalid_params', 'model_id is required');
      return;
    }
    const force = body['force'] === true;

    try {
      // Only photographs. A video has no frame to look at here.
      const { data: media, error } = await db
        .from('host_media')
        .select('id, storage_path, mime_type, width, height')
        .eq('host_kind', 'event')
        .eq('host_id', eventId)
        .like('mime_type', 'image/%')
        .order('created_at', { ascending: false })
        .limit(PAGE_MAX * 4);
      if (error) throw new Error(error.message);

      const rows = (media ?? []) as Array<{
        id: string; storage_path: string; width: number | null; height: number | null;
      }>;
      if (rows.length === 0) { res.status(200).json({ items: [], remaining: 0 }); return; }

      // Which of them this detector has already finished with.
      const done = new Set<string>();
      if (!force) {
        const { data: scans } = await db
          .from('events_media_face_scans')
          .select('media_id')
          .eq('event_id', eventId)
          .eq('model_id', modelId);
        for (const s of (scans ?? []) as Array<{ media_id: string }>) done.add(s.media_id);
      }

      const left = rows.filter((r) => !done.has(r.id));
      const items = left.slice(0, limit).map((r) => ({
        id: r.id,
        // A small copy, not the original. See the header.
        url: sizedUrl(r.storage_path, DETECT_WIDTH),
        width: r.width ?? null,
        height: r.height ?? null,
      }));
      res.status(200).json({ items, remaining: Math.max(0, left.length - items.length) });
    } catch (err) {
      logger.error('face pending failed', {
        eventId, error: err instanceof Error ? err.message : String(err),
      });
      sendError(res, 500, 'list_failed', 'could not list photographs');
    }
  }

  /**
   * Record what the browser found in one photograph.
   *
   * The scan row is written whatever the answer, including none, or an
   * album's empty frames would be offered again for ever.
   */
  async function record(req: Request, res: Response): Promise<void> {
    const eventId = await gate(req, res);
    if (!eventId) return;

    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const mediaId = typeof body['media_id'] === 'string' && UUID_RE.test(body['media_id'])
      ? body['media_id'] : null;
    const modelId = typeof body['model_id'] === 'string' ? body['model_id'].slice(0, 64) : '';
    if (!mediaId || !modelId) {
      sendError(res, 400, 'invalid_params', 'media_id (UUID) and model_id are required');
      return;
    }
    const tookMs = num(body['took_ms'], 0, 600_000);

    // An allowlist, field by field. Nothing from the request object is
    // ever spread into a row.
    const raw = Array.isArray(body['faces']) ? body['faces'].slice(0, FACES_MAX) : [];
    const faces: Array<Record<string, unknown>> = [];
    for (const [i, f] of raw.entries()) {
      if (typeof f !== 'object' || f === null) continue;
      const o = f as Record<string, unknown>;
      const x = num(o['x'], -0.5, 1.5);
      const y = num(o['y'], -0.5, 1.5);
      const w = num(o['w'], 1e-6, 2);
      const h = num(o['h'], 1e-6, 2);
      const score = num(o['score'], 0, 1);
      if (x === null || y === null || w === null || h === null || score === null) continue;
      faces.push({
        event_id: eventId,
        media_id: mediaId,
        face_index: i,
        box_x: x, box_y: y, box_w: w, box_h: h,
        score,
        face_px: num(o['px'], 0, 100_000),
        model_id: modelId,
      });
    }

    try {
      // The photograph has to belong to this event. Without this check a
      // valid admin of event A could write boxes onto event B's media.
      const { data: owns } = await db
        .from('host_media')
        .select('id')
        .eq('id', mediaId)
        .eq('host_kind', 'event')
        .eq('host_id', eventId)
        .maybeSingle();
      if (!owns) {
        sendError(res, 404, 'not_found', 'no such photograph on this event');
        return;
      }

      // Replace rather than add to: a re-scan is the new truth, and
      // face_index would collide on its unique constraint otherwise.
      await db.from('events_media_faces').delete().eq('media_id', mediaId);
      if (faces.length > 0) {
        const { error: insErr } = await db.from('events_media_faces').insert(faces);
        if (insErr) throw new Error(insErr.message);
      }
      const { error: scanErr } = await db
        .from('events_media_face_scans')
        .upsert({
          media_id: mediaId,
          event_id: eventId,
          faces: faces.length,
          model_id: modelId,
          took_ms: tookMs,
          scanned_at: new Date().toISOString(),
        }, { onConflict: 'media_id' });
      if (scanErr) throw new Error(scanErr.message);

      res.status(200).json({ media_id: mediaId, faces: faces.length });
    } catch (err) {
      logger.error('face record failed', {
        eventId, mediaId, error: err instanceof Error ? err.message : String(err),
      });
      sendError(res, 500, 'record_failed', 'could not record those faces');
    }
  }

  /** What has been found so far, for the Media tab. */
  async function summary(req: Request, res: Response): Promise<void> {
    const eventId = await gate(req, res);
    if (!eventId) return;
    try {
      const count = async (table: string) => {
        const { count: n } = await db
          .from(table)
          .select('*', { count: 'exact', head: true })
          .eq('event_id', eventId);
        return n ?? 0;
      };
      const [scanned, faces] = await Promise.all([
        count('events_media_face_scans'),
        count('events_media_faces'),
      ]);
      // The measurement nobody has: what this costs per photograph.
      const { data: timing } = await db
        .from('events_media_face_scans')
        .select('took_ms')
        .eq('event_id', eventId)
        .not('took_ms', 'is', null)
        .limit(1000);
      const times = ((timing ?? []) as Array<{ took_ms: number }>)
        .map((t) => t.took_ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
      res.status(200).json({
        scanned,
        faces,
        median_ms: times.length ? times[Math.floor(times.length / 2)] : null,
      });
    } catch (err) {
      logger.error('face summary failed', {
        eventId, error: err instanceof Error ? err.message : String(err),
      });
      sendError(res, 500, 'summary_failed', 'could not summarise');
    }
  }

  return { pending, record, summary };
}

export function mountFaceDetect(router: Router, routes: ReturnType<typeof createFaceDetect>): void {
  router.post('/events/:eventId/faces/pending', routes.pending);
  router.post('/events/:eventId/faces', routes.record);
  router.get('/events/:eventId/faces/summary', routes.summary);
}
