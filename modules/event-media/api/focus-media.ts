// @ts-nocheck — depends on @supabase/supabase-js + express which require
// pnpm install at the modules workspace level.
/**
 * What a photograph needs before a lens can be put in front of it.
 *
 *   POST /admin/events/:eventId/media/depth   { ids }   measure them
 *
 * Two measurements: how far away everything is, and which of it is the
 * subject. Both already exist for the booth (lib/booth-provider.ts), and
 * both are properties of the PHOTOGRAPH rather than of any particular
 * run, so they are computed once and cached beside it. An album re-run,
 * or run at a different aperture, costs nothing the second time.
 *
 * THE API NEVER DECODES A PHOTOGRAPH. Same rule as everywhere else in
 * this module, same two outages behind it: the model is handed a URL and
 * the answer is copied into storage as bytes. The defocus itself is
 * arithmetic, and happens in the organiser's browser.
 */
import type { Request, Response, Router } from 'express';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface FocusMediaDeps {
  canAdminEvent: (req: Request, eventId: string) => Promise<boolean | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceClient: any;
  storageBucket: string;
  publicUrl: (path: string) => string;
  /** Monocular depth, near is bright (lib/booth-provider.ts). */
  runDepth: (imageUrl: string) => Promise<
    { ok: true; image: Uint8Array; contentType: string } | { ok: false; error: string }>;
  /** The subject, cut out from the background. */
  runCutout: (imageUrl: string) => Promise<
    { ok: true; image: Uint8Array; contentType: string } | { ok: false; error: string }>;
  logger: PlatformLogger;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many one call will measure. Each is two model calls. */
const BATCH_MAX = 3;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

export function createFocusMedia(deps: FocusMediaDeps) {
  const { canAdminEvent, serviceClient: db, storageBucket, publicUrl, runDepth, runCutout, logger } = deps;

  /**
   * One photograph: make sure a depth map and a cutout exist beside it,
   * and say where they are. Never throws.
   */
  async function measure(eventId: string, mediaId: string, force: boolean): Promise<{
    id: string;
    status: 'ready' | 'skipped' | 'failed';
    reason?: string;
    source?: string;
    depth?: string;
    cutout?: string;
  }> {
    const { data: row, error } = await db
      .from('host_media')
      .select('id, host_kind, host_id, storage_path, mime_type, variants, metadata')
      .eq('id', mediaId)
      .maybeSingle();
    if (error || !row || row.host_kind !== 'event' || row.host_id !== eventId) {
      return { id: mediaId, status: 'skipped', reason: 'not_found' };
    }
    if (typeof row.mime_type !== 'string' || !row.mime_type.startsWith('image/')) {
      return { id: mediaId, status: 'skipped', reason: 'not_a_photo' };
    }
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const selfie = typeof meta['selfie'] === 'string' ? meta['selfie'] : null;
    const path = selfie ?? (typeof row.storage_path === 'string' ? row.storage_path : '');
    if (!path.startsWith(`event/${eventId}/`)) {
      return { id: mediaId, status: 'skipped', reason: 'unsupported_layout' };
    }

    const had = (row.variants ?? {}) as Record<string, unknown>;
    // Depth and cutout belong to the photograph, not to a run. If they
    // are already there, this costs nothing.
    let depth = typeof had['depth'] === 'string' ? had['depth'] as string : null;
    let cutout = typeof had['cutout'] === 'string' ? had['cutout'] as string : null;
    if (depth && cutout && !force) {
      return { id: mediaId, status: 'ready', source: publicUrl(path), depth: publicUrl(depth), cutout: publicUrl(cutout) };
    }

    const folder = path.slice(0, path.lastIndexOf('/'));
    const url = publicUrl(path);
    const put = async (bytes: Uint8Array, name: string): Promise<string | null> => {
      const at = `${folder}/variants/${name}`;
      const up = await db.storage.from(storageBucket).upload(at, bytes, {
        contentType: 'image/png', upsert: true,
      });
      if (up.error) {
        logger.warn('focus: could not store a measurement', { mediaId, name, error: up.error.message });
        return null;
      }
      return at;
    };

    if (!depth || force) {
      const got = await runDepth(url);
      if (!got.ok) return { id: mediaId, status: 'failed', reason: `depth: ${got.error}` };
      depth = await put(got.image, 'depth.png');
      if (!depth) return { id: mediaId, status: 'failed', reason: 'depth_upload_failed' };
    }
    if (!cutout || force) {
      const got = await runCutout(url);
      if (!got.ok) return { id: mediaId, status: 'failed', reason: `cutout: ${got.error}` };
      cutout = await put(got.image, 'cutout.png');
      if (!cutout) return { id: mediaId, status: 'failed', reason: 'cutout_upload_failed' };
    }

    const { error: updErr } = await db
      .from('host_media')
      .update({ variants: { ...had, depth, cutout } })
      .eq('id', mediaId);
    if (updErr) {
      logger.error('focus: could not record the measurements', { mediaId, error: updErr.message });
      return { id: mediaId, status: 'failed', reason: 'update_failed' };
    }
    return { id: mediaId, status: 'ready', source: url, depth: publicUrl(depth), cutout: publicUrl(cutout) };
  }

  async function depth(req: Request, res: Response): Promise<void> {
    const eventId = req.params['eventId'];
    if (typeof eventId !== 'string' || !UUID_RE.test(eventId)) {
      sendError(res, 400, 'invalid_request', 'eventId must be a UUID');
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
    const ids = Array.isArray(body['ids'])
      ? [...new Set((body['ids'] as unknown[]).filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)))]
        .slice(0, BATCH_MAX)
      : [];
    const force = body['force'] === true;
    if (ids.length === 0) {
      sendError(res, 400, 'invalid_request', `ids must hold 1-${BATCH_MAX} media UUIDs`);
      return;
    }

    const results: Awaited<ReturnType<typeof measure>>[] = [];
    for (const id of ids) {
      try {
        results.push(await measure(eventId, id, force));
      } catch (err) {
        results.push({ id, status: 'failed', reason: err instanceof Error ? err.message : String(err) });
      }
    }
    logger.info('focus: measured a batch', {
      eventId,
      ready: results.filter((r) => r.status === 'ready').length,
      failed: results.filter((r) => r.status === 'failed').length,
    });
    res.status(200).json({ results });
  }

  return { depth, measure };
}

export function mountFocusMedia(router: Router, routes: ReturnType<typeof createFocusMedia>): void {
  router.post('/events/:eventId/media/depth', routes.depth);
}
