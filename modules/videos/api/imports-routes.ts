// @ts-nocheck — supabase-js + express are resolved at module-host install time.

/**
 * Operator-only triggers for the two importers (spec §20).
 *
 * Mounted under /api/modules/videos/imports. The platform super-admin-gates
 * the /api/modules tree, and this router checks the caller's admin_profiles
 * row itself as well, the way vehicle-video does: an import can consume
 * hundreds of gigabytes of storage, so it should not depend on another
 * system's middleware being in front of it.
 *
 * Both routes only enqueue. The work happens in the worker, where the budget
 * caps live.
 */

import type { Request, Response, Router } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,128}$/;

export interface ImportsDeps {
  supabase: { from(t: string): any };
  enqueueJob?: (queue: string, name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<{ id: string | undefined }>;
  logger: { info: (m: string, x?: Record<string, unknown>) => void; warn: (m: string, x?: Record<string, unknown>) => void };
}

/** A Drive folder id, from either the bare id or a folder URL pasted whole. */
export function driveFolderId(value: unknown): string | null {
  const s = String(value ?? '').trim();
  if (DRIVE_ID_RE.test(s)) return s;
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,128})/);
  return m ? m[1] : null;
}

/**
 * A job id that makes a double-click a no-op without blocking a deliberate
 * re-run later: BullMQ ignores a second add with an id already in the
 * queue, and the ten-minute bucket means the same scope can be queued
 * again once the first run has had time to start.
 */
export function dedupeJobId(prefix: string, scope: string, nowMs = Date.now()): string {
  // Hyphens, not colons: BullMQ 5.81 refuses a custom job id containing ':'
  // (it is the key separator), and the refusal surfaced as an unhandled
  // rejection and a 500 on every import button.
  return `${prefix}-${scope.replace(/:/g, '-')}-${Math.floor(nowMs / 600_000)}`;
}

export function mountImportsRoutes(router: Router, deps: ImportsDeps): void {
  const { supabase, enqueueJob, logger } = deps;

  router.post('/youtube', async (req: Request, res: Response) => {
    if (!enqueueJob) return res.status(503).json({ error: 'job queue unavailable' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const recapId = String(body.recap_id ?? '');
    const eventId = String(body.event_id ?? '');
    if (!UUID_RE.test(recapId) && !UUID_RE.test(eventId)) {
      return res.status(400).json({ error: 'recap_id or event_id (uuid) is required' });
    }
    const data = UUID_RE.test(recapId) ? { recap_id: recapId } : { event_id: eventId };
    const job = await enqueueJob('jobs', 'videos:import-from-youtube', data, {
      jobId: dedupeJobId('videos-yt', String(data.recap_id ?? data.event_id)),
    });
    logger.info('youtube import queued', { ...data, job: job?.id });
    res.status(202).json({ queued: true, job_id: job?.id ?? null, ...data });
  });

  router.post('/drive', async (req: Request, res: Response) => {
    if (!enqueueJob) return res.status(503).json({ error: 'job queue unavailable' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const folderId = driveFolderId(body.folder_id);
    if (!folderId) return res.status(400).json({ error: 'folder_id must be a Drive folder id or folder URL' });
    const eventId = String(body.event_id ?? '');
    if (eventId && !UUID_RE.test(eventId)) return res.status(400).json({ error: 'event_id must be a uuid' });
    const data = { folder_id: folderId, ...(eventId ? { event_id: eventId } : {}) };
    const job = await enqueueJob('jobs', 'videos:import-masters-from-drive', data, {
      jobId: dedupeJobId('videos-drive', folderId),
    });
    logger.info('drive import queued', { ...data, job: job?.id });
    res.status(202).json({ queued: true, job_id: job?.id ?? null, ...data });
  });

  /**
   * Adopt objects already in the S3 bucket (a local yt-dlp run shipped
   * straight up) as masters. Nothing moves; this only writes rows.
   */
  router.post('/bucket', async (req: Request, res: Response) => {
    if (!enqueueJob) return res.status(503).json({ error: 'job queue unavailable' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { safePrefix, DEFAULT_PREFIX } = await import('../workers/adopt-from-bucket.js');
    const prefix = safePrefix(body.prefix ?? DEFAULT_PREFIX);
    if (!prefix) return res.status(400).json({ error: 'prefix must be a folder path ending in / with no ..' });
    const eventId = String(body.event_id ?? '');
    if (eventId && !UUID_RE.test(eventId)) return res.status(400).json({ error: 'event_id must be a uuid' });
    const data = { prefix, ...(eventId ? { event_id: eventId } : {}) };
    const job = await enqueueJob('jobs', 'videos:adopt-from-bucket', data, {
      jobId: dedupeJobId('videos-bucket', `${prefix.replace(/[^A-Za-z0-9]+/g, '-')}:${eventId || 'any'}`),
    });
    logger.info('bucket adopt queued', { ...data, job: job?.id });
    res.status(202).json({ queued: true, job_id: job?.id ?? null, ...data });
  });

  /** What has been imported so far, so the operator can see a run land. */
  router.get('/recent', async (_req: Request, res: Response) => {
    const { data, error } = await supabase
      .from('video_assets')
      .select('id, video_id, kind, state, bytes, filename, source, storage_provider, batch_id, error, created_at, updated_at')
      .in('source', ['youtube_import', 'drive_import', 'bucket_import', 'batch_import', 'studio'])
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ assets: data ?? [] });
  });
}
