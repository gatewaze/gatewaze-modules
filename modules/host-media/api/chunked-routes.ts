// @ts-nocheck — see routes.ts header.

/**
 * Chunked upload — three-leg flow.
 *
 *   1. POST /admin/<hostKind>/:hostId/media/chunked-init
 *        Body: { filename, mime_type, total_bytes, total_chunks }
 *        Returns: { upload_id, chunk_upload_urls[] } — each entry is a
 *        Supabase Storage signed PUT URL with TTL 1h.
 *   2. Client PUTs each chunk to its signed URL.
 *   3. POST /admin/<hostKind>/:hostId/media/chunked-commit/:uploadId
 *        Triggers media-combine-chunks edge fn → writes host_media row.
 *
 * Per spec-host-media-module §4.2.
 */

import type { Request, Response, Router } from 'express';
import { isKnownHostKind } from '../lib/registry.js';
import { paramAsUuid, paramAsString } from '../lib/sanitisers.js';
import { buildChunkStoragePath } from '../lib/storage-paths.js';

interface RequestWithUser extends Request {
  userId?: string;
}

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface ChunkedRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  /**
   * Adapter creates signed PUT URLs and triggers the combine-chunks
   * edge fn.
   */
  storageBucket: string;
  logger: PlatformLogger;
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

function checkHost(req: Request, res: Response): { hostKind: string; hostId: string } | null {
  const hostKind = paramAsString(req.params['hostKind']);
  const hostId = paramAsUuid(req.params['hostId']);
  if (!hostKind || !hostId || !isKnownHostKind(hostKind)) {
    sendError(res, 400, 'invalid_params', 'valid hostKind + hostId required');
    return null;
  }
  return { hostKind, hostId };
}

export function createChunkedRoutes(deps: ChunkedRoutesDeps) {
  const { supabase, storageBucket, logger } = deps;

  async function init(req: RequestWithUser, res: Response): Promise<void> {
    const c = checkHost(req, res); if (!c) return;
    const userId = req.userId;
    if (!userId) { sendError(res, 401, 'unauthenticated', 'session required'); return; }

    const filename = typeof req.body?.filename === 'string' ? req.body.filename.slice(0, 200) : null;
    const mimeType = typeof req.body?.mime_type === 'string' ? req.body.mime_type : null;
    const totalBytes = Number(req.body?.total_bytes);
    const totalChunks = Number(req.body?.total_chunks);
    if (!filename || !mimeType || !Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > 10_000) {
      sendError(res, 400, 'invalid_init', 'filename, mime_type, total_bytes, total_chunks (1..10000) required');
      return;
    }

    const { data: row, error } = await supabase
      .from('host_media_chunked_uploads')
      .insert({
        host_kind: c.hostKind,
        host_id: c.hostId,
        filename,
        mime_type: mimeType,
        total_bytes: totalBytes,
        total_chunks: totalChunks,
        uploaded_by: userId,
      })
      .select().single();
    if (error || !row) { sendError(res, 500, 'init_failed', error?.message ?? 'unknown'); return; }

    const uploadId = row.id;
    const chunkUploadUrls: string[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const path = buildChunkStoragePath(c.hostKind, c.hostId, uploadId, i);
      const { data: signed, error: signErr } = await supabase
        .storage.from(storageBucket)
        .createSignedUploadUrl(path);
      if (signErr || !signed?.signedUrl) {
        logger.error('chunked-init sign-url failed', { uploadId, chunk: i, error: signErr?.message });
        // Roll back the row so the client can retry cleanly.
        await supabase.from('host_media_chunked_uploads').delete().eq('id', uploadId);
        sendError(res, 500, 'sign_url_failed', signErr?.message ?? 'unknown');
        return;
      }
      chunkUploadUrls.push(signed.signedUrl);
    }

    res.status(201).json({ upload_id: uploadId, chunk_upload_urls: chunkUploadUrls });
  }

  async function commit(req: RequestWithUser, res: Response): Promise<void> {
    const c = checkHost(req, res); if (!c) return;
    const uploadId = paramAsUuid(req.params['uploadId']);
    if (!uploadId) { sendError(res, 400, 'invalid_upload_id', 'upload id must be a UUID'); return; }

    const { data: session, error } = await supabase
      .from('host_media_chunked_uploads')
      .select('*').eq('id', uploadId)
      .eq('host_kind', c.hostKind).eq('host_id', c.hostId)
      .maybeSingle();
    if (error) { sendError(res, 500, 'fetch_failed', error.message); return; }
    if (!session) { sendError(res, 404, 'upload_not_found', 'no such chunked upload'); return; }
    if (session.status !== 'pending') {
      sendError(res, 409, 'already_committed', `upload status ${session.status}`);
      return;
    }
    if (new Date(session.expires_at).getTime() < Date.now()) {
      sendError(res, 410, 'upload_expired', 'chunked upload session expired');
      return;
    }

    // Mark combining; fire the edge fn (best-effort).
    await supabase.from('host_media_chunked_uploads').update({ status: 'combining' }).eq('id', uploadId);

    // The actual combine + host_media row creation happens in the
    // media-combine-chunks edge fn. This route returns 202; clients
    // poll GET /admin/.../media/<id> by media_id once the edge fn
    // writes it back into the session row.
    res.status(202).json({ upload_id: uploadId, status: 'combining' });
  }

  return { init, commit };
}

export function mountChunkedRoutes(router: Router, routes: ReturnType<typeof createChunkedRoutes>): void {
  router.post('/:hostKind/:hostId/media/chunked-init', routes.init);
  router.post('/:hostKind/:hostId/media/chunked-commit/:uploadId', routes.commit);
}
