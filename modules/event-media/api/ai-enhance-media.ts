// @ts-nocheck — depends on @supabase/supabase-js + express which require
// pnpm install at the modules workspace level.
/**
 * Relighting an album's photographs with a model, and recording it.
 *
 *   POST /admin/events/:eventId/media/ai-enhance    { ids }  relight them
 *   POST /admin/events/:eventId/media/ai-enhanced   { … }    record one
 *
 * The sibling of enhance-media.ts, and deliberately a separate thing.
 * That one is arithmetic on existing pixels and cannot invent; this one
 * reconstructs the photograph through a diffusion model and can. They
 * are stored under different keys and shown only where an organiser has
 * chosen which they want, so nobody gets a regenerated photograph of
 * their own wedding by accident.
 *
 * THE API NEVER DECODES A PHOTOGRAPH. Same rule, same reason, same two
 * outages (see the top of enhance-media.ts). What happens here is a
 * model call and a byte copy: the relit file is put into storage as a
 * draft, and the organiser's browser -- which has memory to spare --
 * measures it against the original, pulls the colour back to where it
 * started, and uploads the copy that is kept.
 *
 * Paid, per photograph. So an album already done is skipped unless
 * somebody deliberately asks again, exactly as the standard enhancement
 * is, and the record is written before the browser has made anything so
 * an interrupted run is not paid for twice.
 */
import type { Request, Response, Router } from 'express';
import { aiEnhanceConfigured, runAiEnhance, strengthFor } from '../lib/ai-enhance.js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface AiEnhanceMediaDeps {
  canAdminEvent: (req: Request, eventId: string) => Promise<boolean | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceClient: any;
  storageBucket: string;
  publicUrl: (path: string) => string;
  logger: PlatformLogger;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many one call will do. Each is a paid model call. */
const BATCH_MAX = 3;
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,300}\.(jpg|jpeg)$/;
const MAX_COPY_BYTES = 25 * 1024 * 1024;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

export function createAiEnhanceMedia(deps: AiEnhanceMediaDeps) {
  const { canAdminEvent, serviceClient: db, storageBucket, publicUrl, logger } = deps;

  async function guard(req: Request, res: Response, eventId: unknown): Promise<boolean> {
    if (typeof eventId !== 'string' || !UUID_RE.test(eventId)) {
      sendError(res, 400, 'invalid_request', 'eventId must be a UUID');
      return false;
    }
    let allowed: boolean | null;
    try {
      allowed = await canAdminEvent(req, eventId);
    } catch {
      allowed = false;
    }
    if (allowed === null) { sendError(res, 401, 'unauthenticated', 'session required'); return false; }
    if (!allowed) { sendError(res, 403, 'forbidden', 'not authorised for this event'); return false; }
    return true;
  }

  /**
   * One photograph: relight it and leave the draft in storage for the
   * browser to correct. Never throws.
   */
  async function relight(eventId: string, mediaId: string, strength: number, force: boolean): Promise<{
    id: string;
    status: 'needs' | 'unchanged' | 'skipped' | 'failed';
    reason?: string;
    /** The photograph as it was, for measuring the colour against. */
    source?: string;
    /** What the model made of it, before the colour is pulled back. */
    draft?: string;
    of?: 'photo' | 'selfie';
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

    // As with the standard enhancement, a booth picture's own photograph
    // is the selfie behind it -- the poster is left as the booth made it.
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const selfie = typeof meta['selfie'] === 'string' ? meta['selfie'] : null;
    const path = selfie ?? (typeof row.storage_path === 'string' ? row.storage_path : '');
    if (!path.startsWith(`event/${eventId}/`)) {
      return { id: mediaId, status: 'skipped', reason: 'unsupported_layout' };
    }

    // Already done: no second model call, and nothing spent.
    const seen = meta['ai_enhance'] && typeof meta['ai_enhance'] === 'object'
      ? (meta['ai_enhance'] as Record<string, unknown>) : null;
    if (seen && !force) {
      return { id: mediaId, status: 'unchanged', reason: 'already_done' };
    }

    const made = await runAiEnhance(publicUrl(path), strength);
    if (!made.ok) return { id: mediaId, status: 'failed', reason: made.error };

    // The draft goes beside the photograph, under a name of its own, so
    // the browser can read it back and so a CDN never serves a stale one.
    const folder = path.slice(0, path.lastIndexOf('/'));
    const draftPath = `${folder}/ai-draft-${Date.now().toString(36)}.jpg`;
    const up = await db.storage.from(storageBucket).upload(draftPath, made.image, {
      contentType: 'image/jpeg',
      upsert: false,
    });
    if (up.error) {
      logger.error('ai-enhance: could not store the draft', { mediaId, error: up.error.message });
      return { id: mediaId, status: 'failed', reason: 'draft_upload_failed' };
    }

    // Written before the browser has made anything, so an interrupted
    // run is not paid for a second time.
    await db.from('host_media').update({
      metadata: {
        ...meta,
        ai_enhance: {
          at: new Date().toISOString(),
          of: selfie ? 'selfie' : 'photo',
          strength: strengthFor(strength),
          draft: draftPath,
        },
      },
    }).eq('id', mediaId);

    return {
      id: mediaId,
      status: 'needs',
      source: publicUrl(path),
      draft: publicUrl(draftPath),
      of: selfie ? 'selfie' : 'photo',
    };
  }

  async function aiEnhance(req: Request, res: Response): Promise<void> {
    const eventId = req.params['eventId'];
    if (!(await guard(req, res, eventId))) return;
    if (!aiEnhanceConfigured()) {
      sendError(res, 503, 'not_configured', 'no image provider is configured for this site');
      return;
    }

    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const ids = Array.isArray(body['ids'])
      ? [...new Set((body['ids'] as unknown[]).filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)))]
        .slice(0, BATCH_MAX)
      : [];
    const force = body['force'] === true;
    const strength = strengthFor(body['strength']);
    if (ids.length === 0) {
      sendError(res, 400, 'invalid_request', `ids must hold 1-${BATCH_MAX} media UUIDs`);
      return;
    }

    // One at a time. Each is a paid generation taking several seconds,
    // and a burst of them against one pod buys nothing.
    const results: Awaited<ReturnType<typeof relight>>[] = [];
    for (const id of ids) {
      try {
        results.push(await relight(eventId as string, id, strength, force));
      } catch (err) {
        results.push({ id, status: 'failed', reason: err instanceof Error ? err.message : String(err) });
      }
    }
    logger.info('ai-enhance: relit a batch', {
      eventId,
      needs: results.filter((r) => r.status === 'needs').length,
      unchanged: results.filter((r) => r.status === 'unchanged').length,
      failed: results.filter((r) => r.status === 'failed').length,
    });
    res.status(200).json({ results });
  }

  /**
   * The browser judged a relit copy unusable. Sweep the draft and record
   * the refusal, so the album can be run again without paying for the
   * same answer twice.
   */
  async function refuse(eventId: string, mediaId: string): Promise<void> {
    const { data: row } = await db
      .from('host_media')
      .select('id, host_kind, host_id, metadata')
      .eq('id', mediaId)
      .maybeSingle();
    if (!row || row.host_kind !== 'event' || row.host_id !== eventId) return;
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const record = meta['ai_enhance'] && typeof meta['ai_enhance'] === 'object'
      ? (meta['ai_enhance'] as Record<string, unknown>) : {};
    const draft = typeof record['draft'] === 'string' ? record['draft'] : null;
    const { draft: _dropped, ...kept } = record;
    await db.from('host_media').update({
      metadata: {
        ...meta,
        ai_enhance: { ...kept, refused_at: new Date().toISOString(), refused: true },
      },
    }).eq('id', mediaId);
    if (draft && draft.startsWith(`event/${eventId}/`)) {
      try { await db.storage.from(storageBucket).remove([draft]); } catch { /* swept later */ }
    }
  }

  /**
   * Record the corrected copy the browser has just uploaded, and sweep
   * the draft away. Takes the same care as recording a rotation, and
   * decides what the copy is OF from the row rather than the browser --
   * trusting the browser for that put 135 enhanced selfies in the
   * photograph's slot on 2026-09-28.
   */
  async function aiEnhanced(req: Request, res: Response): Promise<void> {
    const eventId = req.params['eventId'];
    if (!(await guard(req, res, eventId))) return;

    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const mediaId = typeof body['media_id'] === 'string' ? body['media_id'] : '';
    // The browser looked at what came back and would not have it. Sweep
    // the draft, write that down, and do not set a variant -- a later
    // run then knows this one was answered and refused, rather than
    // paying for the same answer again.
    if (body['refused'] === true) {
      if (!UUID_RE.test(mediaId)) {
        sendError(res, 400, 'invalid_request', 'media_id is required');
        return;
      }
      await refuse(eventId as string, mediaId);
      res.status(200).json({ id: mediaId, refused: true });
      return;
    }
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
      sendError(res, 400, 'not_a_photo', 'only a photo can be relit');
      return;
    }

    const current = typeof row.storage_path === 'string' ? row.storage_path : '';
    const dir = current.slice(0, current.lastIndexOf('/'));
    if (!dir.startsWith(`event/${eventId}/`) || !path.startsWith(`${dir}/`) || path.includes('..')) {
      sendError(res, 400, 'invalid_request', 'that path is not beside the photo it belongs to');
      return;
    }

    const name = path.slice(path.lastIndexOf('/') + 1);
    const { data: found } = await db.storage.from(storageBucket).list(dir, { search: name, limit: 100 });
    if (!found || !found.some((f: { name: string }) => f.name === name)) {
      sendError(res, 400, 'not_uploaded', 'that copy is not in storage yet');
      return;
    }

    const had = (row.variants ?? {}) as Record<string, unknown>;
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    let of: 'photo' | 'selfie' = 'photo';
    let key: 'enhanced_ai' | 'enhanced_ai_selfie' = 'enhanced_ai';
    if (typeof meta['selfie'] === 'string' && meta['selfie']) {
      of = 'selfie';
      key = 'enhanced_ai_selfie';
    }
    const previous = typeof had[key] === 'string' ? (had[key] as string) : null;
    const record = meta['ai_enhance'] && typeof meta['ai_enhance'] === 'object'
      ? (meta['ai_enhance'] as Record<string, unknown>) : {};
    const draft = typeof record['draft'] === 'string' ? record['draft'] : null;
    const { draft: _dropped, ...kept } = record;

    const { error: updErr } = await db
      .from('host_media')
      .update({
        variants: { ...had, [key]: path },
        metadata: { ...meta, ai_enhance: { ...kept, made_at: new Date().toISOString(), bytes, of } },
      })
      .eq('id', mediaId);
    if (updErr) {
      logger.error('ai-enhance record failed', { mediaId, error: updErr.message });
      sendError(res, 500, 'update_failed', 'could not record that copy');
      return;
    }

    // The draft has served its purpose, and the copy this replaces is
    // nobody's now. Both best effort.
    const sweep = [draft, previous !== path ? previous : null]
      .filter((p): p is string => typeof p === 'string' && p !== path && p.startsWith(`event/${eventId}/`));
    if (sweep.length > 0) {
      try { await db.storage.from(storageBucket).remove(sweep); } catch { /* swept later */ }
    }
    res.status(200).json({ id: mediaId, of, enhanced_ai: path });
  }

  return { aiEnhance, aiEnhanced, relight };
}

export function mountAiEnhanceMedia(router: Router, routes: ReturnType<typeof createAiEnhanceMedia>): void {
  router.post('/events/:eventId/media/ai-enhance', routes.aiEnhance);
  router.post('/events/:eventId/media/ai-enhanced', routes.aiEnhanced);
}
