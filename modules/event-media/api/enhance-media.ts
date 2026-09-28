// @ts-nocheck — depends on @supabase/supabase-js + express which require
// pnpm install at the modules workspace level.
/**
 * What an album's photographs need, and recording what was done.
 *
 *   POST /admin/events/:eventId/media/enhance    { ids }   what they need
 *   POST /admin/events/:eventId/media/enhanced   { … }     what was done
 *
 * A model looks at each photograph and says what it needs -- more light,
 * more contrast, a warmer cast, a little sharpening -- and lib/enhance.ts
 * turns that into bounded adjustments. Nothing is drawn: the adjustments
 * are arithmetic on pixels that already exist, so no face can come back
 * as somebody else's. It is an enhancement, not a regeneration.
 *
 * THE API NEVER DECODES A PHOTOGRAPH. It did, and it cost the site two
 * outages (2026-09-27 and 2026-09-28): this pod has 512MB for everything
 * it does -- the projector's feed, the booth, the portal -- and a twelve-
 * megapixel JPEG decoded beside all that is enough to have the pod killed
 * and every visitor served a 503. Tuning it down was not enough, twice.
 *
 * So the work happens where there is memory for it and nobody else is
 * affected: the organiser's own browser, on a canvas, exactly as turning
 * a photograph on its side already does (admin/utils/rotateMedia.ts).
 * The model is asked from here because it fetches the photograph by URL
 * itself -- that costs this process a request, not an image -- and the
 * browser sends back what it made, which this route records after the
 * same checks a rotation gets.
 */
import type { Request, Response, Router } from 'express';
import { opsFor, worthEnhancing } from '../lib/enhance.js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface EnhanceMediaDeps {
  canAdminEvent: (req: Request, eventId: string) => Promise<boolean | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceClient: any;
  storageBucket: string;
  /** A URL the model can fetch this stored object from. */
  publicUrl: (path: string) => string;
  /** What the model makes of one photograph (lib/booth-provider.ts). */
  runVerdict: (imageUrl: string) => Promise<{ ok: true; verdict: unknown } | { ok: false; error: string }>;
  logger: PlatformLogger;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many photographs one call will do. Each is a model call. */
const BATCH_MAX = 3;
/** A storage path we are prepared to write into a row. */
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,300}\.(jpg|jpeg)$/;
/** An enhanced copy far larger than this is not one. */
const MAX_COPY_BYTES = 25 * 1024 * 1024;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

export function createEnhanceMedia(deps: EnhanceMediaDeps) {
  const { canAdminEvent, serviceClient: db, storageBucket, publicUrl, runVerdict, logger } = deps;

  /**
   * One photograph: ask the model what it needs and write that down.
   * Returns what an organiser's browser should do about it, or nothing
   * where there is nothing to do. Never throws.
   */
  async function askAbout(eventId: string, mediaId: string, force = false): Promise<{
    id: string;
    status: 'needs' | 'unchanged' | 'skipped' | 'failed';
    note?: string;
    reason?: string;
    /** Where the photograph is, and what to do to it, for the browser. */
    source?: string;
    ops?: ReturnType<typeof opsFor>;
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
    const path = typeof row.storage_path === 'string' ? row.storage_path : '';
    if (!path.startsWith(`event/${eventId}/`)) {
      return { id: mediaId, status: 'skipped', reason: 'unsupported_layout' };
    }

    // Already looked at: no second model call. This is what makes running
    // an album again cheap, and what stops a caller spending at a paid
    // endpoint by sending the same ids over and over.
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const seen = meta['enhance'] && typeof meta['enhance'] === 'object'
      ? (meta['enhance'] as Record<string, unknown>) : null;
    if (seen && !force) {
      return {
        id: mediaId,
        status: seen['needed'] === true ? 'unchanged' : 'unchanged',
        note: typeof seen['note'] === 'string' ? seen['note'] : undefined,
        reason: 'already_done',
      };
    }

    const answer = await runVerdict(publicUrl(path));
    if (!answer.ok) return { id: mediaId, status: 'failed', reason: answer.error };
    const verdict = answer.verdict as Parameters<typeof worthEnhancing>[0];
    if (!worthEnhancing(verdict)) {
      await db.from('host_media').update({
        metadata: { ...meta, enhance: { at: new Date().toISOString(), needed: false, note: verdict.note } },
      }).eq('id', mediaId);
      return { id: mediaId, status: 'unchanged', note: verdict.note };
    }

    // What the browser should do, and what it should do it to. Recorded
    // now so a run that is interrupted half way is not paid for twice --
    // the record says what was decided even if nothing has been made yet.
    const ops = opsFor(verdict);
    await db.from('host_media').update({
      metadata: {
        ...meta,
        enhance: {
          at: new Date().toISOString(),
          needed: true,
          note: verdict.note,
          applied: {
            exposure: verdict.exposure, contrast: verdict.contrast,
            warmth: verdict.warmth, saturation: verdict.saturation, sharpen: verdict.sharpen,
          },
        },
      },
    }).eq('id', mediaId);
    return { id: mediaId, status: 'needs', note: verdict.note, source: publicUrl(path), ops };
  }

  async function enhance(req: Request, res: Response): Promise<void> {
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
      // Deduplicated: the same id twice in one call is one photograph,
      // and would otherwise be one model call each.
      ? [...new Set((body['ids'] as unknown[]).filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)))]
        .slice(0, BATCH_MAX)
      : [];
    // Doing one again is a deliberate act, never the default.
    const force = body['force'] === true;
    if (ids.length === 0) {
      sendError(res, 400, 'invalid_request', `ids must hold 1-${BATCH_MAX} media UUIDs`);
      return;
    }

    // These are model calls, not image work: nothing here decodes a
    // photograph, so they can go together.
    const results = await Promise.all(ids.map((id) => askAbout(eventId, id, force).catch((err) => ({
      id, status: 'failed' as const, reason: err instanceof Error ? err.message : String(err),
    }))));
    logger.info('enhance: asked about a batch', {
      eventId,
      needs: results.filter((r) => r.status === 'needs').length,
      unchanged: results.filter((r) => r.status === 'unchanged').length,
      failed: results.filter((r) => r.status === 'failed').length,
    });
    res.status(200).json({ results });
  }

  /**
   * Record an enhanced copy the organiser's browser has just made and
   * uploaded. Takes little on trust: the row must be this event's photo,
   * the file must sit beside the photograph it belongs to, and it must
   * actually be in storage. The same rules as recording a rotation.
   */
  async function enhanced(req: Request, res: Response): Promise<void> {
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
    const mediaId = typeof body['media_id'] === 'string' ? body['media_id'] : '';
    const path = typeof body['storage_path'] === 'string' ? body['storage_path'] : '';
    const bytes = Number(body['bytes']);
    if (!UUID_RE.test(mediaId) || !PATH_RE.test(path)
      || !Number.isInteger(bytes) || bytes < 1 || bytes > MAX_COPY_BYTES) {
      sendError(res, 400, 'invalid_request', 'media_id, storage_path and bytes are required');
      return;
    }

    const { data: row, error } = await db
      .from('host_media')
      .select('id, host_kind, host_id, storage_path, mime_type, variants, metadata')
      .eq('id', mediaId)
      .maybeSingle();
    if (error || !row || row.host_kind !== 'event' || row.host_id !== eventId) {
      sendError(res, 404, 'not_found', 'no such photo on this event');
      return;
    }
    if (typeof row.mime_type !== 'string' || !row.mime_type.startsWith('image/')) {
      sendError(res, 400, 'not_a_photo', 'only a photo can be enhanced');
      return;
    }
    // Beside the photograph it is a copy of, and nowhere else.
    const current = typeof row.storage_path === 'string' ? row.storage_path : '';
    const dir = current.slice(0, current.lastIndexOf('/'));
    if (!dir.startsWith(`event/${eventId}/`) || !path.startsWith(`${dir}/`) || path.includes('..')) {
      sendError(res, 400, 'invalid_request', 'that path is not beside the photo it belongs to');
      return;
    }

    // It must exist: a row pointing at nothing is a broken picture.
    const name = path.slice(path.lastIndexOf('/') + 1);
    const { data: found } = await db.storage.from(storageBucket).list(dir, { search: name, limit: 100 });
    if (!found || !found.some((f: { name: string }) => f.name === name)) {
      sendError(res, 400, 'not_uploaded', 'that copy is not in storage yet');
      return;
    }

    const had = (row.variants ?? {}) as Record<string, unknown>;
    const previous = typeof had['enhanced'] === 'string' ? (had['enhanced'] as string) : null;
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const record = meta['enhance'] && typeof meta['enhance'] === 'object'
      ? (meta['enhance'] as Record<string, unknown>) : {};
    const { error: updErr } = await db
      .from('host_media')
      .update({
        variants: { ...had, enhanced: path },
        metadata: { ...meta, enhance: { ...record, made_at: new Date().toISOString(), bytes } },
      })
      .eq('id', mediaId);
    if (updErr) {
      logger.error('enhance record failed', { mediaId, error: updErr.message });
      sendError(res, 500, 'update_failed', 'could not record that copy');
      return;
    }
    // The copy this one replaces is nobody's now. Best effort.
    if (previous && previous !== path && previous.startsWith(`event/${eventId}/`)) {
      try { await db.storage.from(storageBucket).remove([previous]); } catch { /* swept later */ }
    }
    res.status(200).json({ id: mediaId, enhanced: path });
  }

  return { enhance, enhanced, askAbout };
}

export function mountEnhanceMedia(router: Router, routes: ReturnType<typeof createEnhanceMedia>): void {
  router.post('/events/:eventId/media/enhance', routes.enhance);
  router.post('/events/:eventId/media/enhanced', routes.enhanced);
}
