// @ts-nocheck — depends on @supabase/supabase-js + express which require
// pnpm install at the modules workspace level.
/**
 * Enhancing an album's photographs.
 *
 *   POST /admin/events/:eventId/media/enhance   { ids: [...] }
 *
 * A model looks at each photograph and says what it needs -- more light,
 * more contrast, a warmer cast, a little sharpening. The change itself is
 * arithmetic on the pixels (lib/enhance.ts decides how much, sharp does
 * it), so nothing is drawn and nobody's face can come back as somebody
 * else's. It is an enhancement, not a regeneration (asked 2026-09-27).
 *
 * The original is never written to. The enhanced copy goes beside it as
 * variants.enhanced, and the portal shows it only for albums an organiser
 * has turned enhancement on for.
 *
 * A batch at a time, because each photograph costs a model call of a few
 * seconds and a request that took ten minutes would be lost to every
 * proxy between here and the browser. The Media tab walks the album a
 * batch at a time and shows how far it has got.
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
const BATCH_MAX = 6;
/** Bigger than any photograph a phone takes; a guard, not a target. */
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

export function createEnhanceMedia(deps: EnhanceMediaDeps) {
  const { canAdminEvent, serviceClient: db, storageBucket, publicUrl, runVerdict, logger } = deps;

  /**
   * sharp is in the api image but is not this module's own dependency,
   * so it is loaded when it is needed rather than at import time: a
   * missing native module must not take the whole route file down with
   * it (a module dep in a route path 404s every route beside it).
   */
  async function loadSharp(): Promise<((input: Buffer) => unknown) | null> {
    try {
      const mod = await import('sharp');
      return (mod.default ?? mod) as never;
    } catch (err) {
      logger.error('enhance: sharp unavailable', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /**
   * One photograph: ask, adjust, store. Returns what happened, never
   * throws -- one photograph that cannot be improved must not stop the
   * batch behind it.
   */
  async function enhanceOne(eventId: string, mediaId: string): Promise<{
    id: string;
    status: 'enhanced' | 'unchanged' | 'skipped' | 'failed';
    note?: string;
    reason?: string;
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

    const answer = await runVerdict(publicUrl(path));
    if (!answer.ok) return { id: mediaId, status: 'failed', reason: answer.error };
    const verdict = answer.verdict as Parameters<typeof worthEnhancing>[0];
    if (!worthEnhancing(verdict)) {
      // Worth recording: an organiser can see it was considered, and a
      // second pass over the album does not ask about it again.
      await db.from('host_media').update({
        metadata: { ...(row.metadata ?? {}), enhance: { at: new Date().toISOString(), needed: false, note: verdict.note } },
      }).eq('id', mediaId);
      return { id: mediaId, status: 'unchanged', note: verdict.note };
    }

    const sharpFn = await loadSharp();
    if (!sharpFn) return { id: mediaId, status: 'failed', reason: 'no_image_library' };

    const { data: blob, error: dlErr } = await db.storage.from(storageBucket).download(path);
    if (dlErr || !blob) return { id: mediaId, status: 'failed', reason: 'download_failed' };
    const source = Buffer.from(await blob.arrayBuffer());
    if (source.length > MAX_SOURCE_BYTES) return { id: mediaId, status: 'skipped', reason: 'too_large' };

    const ops = opsFor(verdict);
    let out: Buffer;
    try {
      // Every step here is arithmetic on pixels that already exist:
      // a gain and an offset, a per-channel gain for warmth, a colour
      // strength, and an unsharp mask. Nothing is drawn.
      let img = (sharpFn as (b: Buffer, o?: unknown) => never)(source, { failOn: 'none' })
        .rotate() // honour EXIF orientation before touching the pixels
        .linear(ops.linear.multiplier, ops.linear.offset)
        .modulate({ saturation: ops.modulate.saturation });
      if (ops.tint.red !== 1 || ops.tint.blue !== 1) {
        img = img.linear([ops.tint.red, 1, ops.tint.blue], [0, 0, 0]);
      }
      if (ops.sharpenSigma > 0) img = img.sharpen({ sigma: ops.sharpenSigma });
      out = await img.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    } catch (err) {
      return { id: mediaId, status: 'failed', reason: err instanceof Error ? err.message : 'convert_failed' };
    }

    // A new name each time, because a CDN caches by name and an album
    // enhanced twice would go on serving the first attempt.
    const dir = path.slice(0, path.lastIndexOf('/'));
    const at = new Date();
    const enhancedPath = `${dir}/enhanced-${at.getTime().toString(36)}.jpg`;
    const { error: upErr } = await db.storage.from(storageBucket)
      .upload(enhancedPath, out, { contentType: 'image/jpeg', upsert: false });
    if (upErr) return { id: mediaId, status: 'failed', reason: 'upload_failed' };

    const had = (row.variants ?? {}) as Record<string, unknown>;
    const previous = typeof had['enhanced'] === 'string' ? (had['enhanced'] as string) : null;
    const { error: updErr } = await db.from('host_media').update({
      variants: { ...had, enhanced: enhancedPath },
      metadata: {
        ...(row.metadata ?? {}),
        enhance: {
          at: at.toISOString(),
          needed: true,
          note: verdict.note,
          // What was actually done, so a result anyone dislikes can be
          // understood rather than guessed at.
          applied: {
            exposure: verdict.exposure, contrast: verdict.contrast,
            warmth: verdict.warmth, saturation: verdict.saturation, sharpen: verdict.sharpen,
          },
        },
      },
    }).eq('id', mediaId);
    if (updErr) {
      await db.storage.from(storageBucket).remove([enhancedPath]).catch(() => {});
      return { id: mediaId, status: 'failed', reason: 'update_failed' };
    }
    // The copy this one replaces is nobody's now. Best effort.
    if (previous && previous !== enhancedPath && previous.startsWith(`event/${eventId}/`)) {
      try { await db.storage.from(storageBucket).remove([previous]); } catch { /* swept later */ }
    }
    return { id: mediaId, status: 'enhanced', note: verdict.note };
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
      ? (body['ids'] as unknown[]).filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)).slice(0, BATCH_MAX)
      : [];
    if (ids.length === 0) {
      sendError(res, 400, 'invalid_request', `ids must hold 1-${BATCH_MAX} media UUIDs`);
      return;
    }

    // In parallel: the time is the model's, not ours, and six at once is
    // well inside what one organiser pressing a button should cost.
    const results = await Promise.all(ids.map((id) => enhanceOne(eventId, id).catch((err) => ({
      id, status: 'failed' as const, reason: err instanceof Error ? err.message : String(err),
    }))));
    logger.info('enhance batch', {
      eventId,
      enhanced: results.filter((r) => r.status === 'enhanced').length,
      unchanged: results.filter((r) => r.status === 'unchanged').length,
      failed: results.filter((r) => r.status === 'failed').length,
    });
    res.status(200).json({ results });
  }

  return { enhance, enhanceOne };
}

export function mountEnhanceMedia(router: Router, routes: ReturnType<typeof createEnhanceMedia>): void {
  router.post('/events/:eventId/media/enhance', routes.enhance);
}
